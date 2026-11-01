// SERP provider adapter. VertexRank talks to ONE normalized shape; each provider is a small module behind it, so swapping
// SerpApi for Brave, OpenSERP or anything else means writing one more provider and changing SERP_PROVIDER.
//
// Safety rules (same spirit as lib/gscClient.js):
//   - only the provider's fixed API host is ever contacted — nothing a client sends becomes a URL;
//   - the query, country and device are validated before any request, and the country comes from the fixed market list;
//   - every request has a timeout, and failures become SerpError messages written for people;
//   - the API key is never returned, logged or placed in an error message.
// Node-only; `fetch` and the clock are injectable (tests/serpProvider.test.mjs).
//
// What a result IS: a snapshot of what one provider returned for one query, country, device and moment. It is not
// "your rank" and not a search volume. Callers must show source, country, device and time next to it.

import { normalizeCountry, marketProfile, isWorldwide } from "./market.js";

export class SerpError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "SerpError";
    this.code = code; // NOT_CONFIGURED | BAD_CONFIG | BAD_REQUEST | AUTH_FAILED | RATE_LIMIT | QUOTA | NETWORK | UPSTREAM
    this.status = status;
  }
}

export const MAX_QUERY_LENGTH = 150;
export const MAX_RESULTS = 10; // one provider search = one page of organic results; we never fetch extra pages
export const DEVICES = ["desktop", "mobile"];
const TIMEOUT_MS = 20000;

/** Validates and normalizes a client request. Throws SerpError(BAD_REQUEST) with a message that is safe to show. */
export function validateSerpRequest(input) {
  const raw = typeof input?.query === "string" ? input.query : "";
  const query = raw.replace(/\s+/g, " ").trim();
  if (!query) throw new SerpError("BAD_REQUEST", "Enter a search query.", 400);
  if (query.length > MAX_QUERY_LENGTH) throw new SerpError("BAD_REQUEST", `Keep the query under ${MAX_QUERY_LENGTH} characters.`, 400);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(query)) throw new SerpError("BAD_REQUEST", "That query contains characters that can't be searched.", 400);
  const device = input?.device === undefined || input?.device === null || input?.device === "" ? "desktop" : input.device;
  if (!DEVICES.includes(device)) throw new SerpError("BAD_REQUEST", "Device must be desktop or mobile.", 400);
  return { query, country: normalizeCountry(input?.country), device };
}

// Google interface languages that SerpApi accepts for `hl`. A market's first language is used only when it is in this
// set; anything else falls back to English rather than risking a rejected request.
const HL = new Set(["ar", "bn", "cs", "da", "de", "el", "en", "es", "fi", "fr", "hu", "id", "it", "ja", "ko", "nl", "no", "pl", "pt", "ro", "sv", "th", "tr", "uk", "vi", "zh"]);

/** { gl, hl } for a market. Worldwide sends neither location nor a market language. */
export function localeFor(country) {
  if (isWorldwide(country)) return { gl: null, hl: "en" };
  const p = marketProfile(country);
  const lang = p?.languages?.[0];
  return { gl: p ? p.code.toLowerCase() : null, hl: HL.has(lang) ? lang : "en" };
}

const clip = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** Only http(s) URLs survive; anything else (javascript:, data:, relative) is dropped. */
function safeUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === "http:" || x.protocol === "https:" ? x.href.slice(0, 2000) : "";
  } catch { return ""; }
}

/** SerpApi's response -> VertexRank's normalized organic results. Ads, featured snippets and other blocks are ignored. */
export function normalizeSerpApi(data) {
  const out = [];
  for (const r of Array.isArray(data?.organic_results) ? data.organic_results : []) {
    const url = safeUrl(r?.link);
    if (!url) continue;
    const position = Number(r.position);
    out.push({ rank: Number.isInteger(position) && position > 0 ? position : out.length + 1, title: clip(r.title, 300), url, snippet: clip(r.snippet, 500) });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

export function createSerpApiProvider({ env = process.env, fetchImpl, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const key = () => (typeof env.SERPAPI_KEY === "string" ? env.SERPAPI_KEY.trim() : "");

  async function search({ query, country, device }) {
    if (!key()) throw new SerpError("NOT_CONFIGURED", "Live search results aren't set up yet. Add SERPAPI_KEY on the server to turn them on.", 503);
    const { gl, hl } = localeFor(country);
    const u = new URL("https://serpapi.com/search.json");
    u.searchParams.set("engine", "google");
    u.searchParams.set("q", query);
    u.searchParams.set("device", device);
    u.searchParams.set("hl", hl);
    if (gl) u.searchParams.set("gl", gl);
    u.searchParams.set("api_key", key());

    let res;
    try {
      res = await doFetch(u.href, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new SerpError("NETWORK", "Couldn't reach the search provider. Try again in a moment.", 502);
    }
    let data = null;
    try { data = await res.json(); } catch { /* handled below */ }
    const detail = typeof data?.error === "string" ? data.error.toLowerCase() : "";

    if (res.status === 401 || res.status === 403 || (!res.ok && /api key/.test(detail))) throw new SerpError("AUTH_FAILED", "The search provider rejected the API key. Check SERPAPI_KEY.", 502);
    if (res.status === 429) {
      if (/run out|out of searches|plan|quota/.test(detail)) throw new SerpError("QUOTA", "The search provider's monthly search allowance is used up. It resets with your plan's billing month.", 429);
      throw new SerpError("RATE_LIMIT", "The search provider is rate-limiting requests. Wait a minute and try again.", 429);
    }
    if (!res.ok) throw new SerpError("UPSTREAM", `The search provider returned an error (${res.status}). Try again later.`, 502);
    if (!data || typeof data !== "object") throw new SerpError("UPSTREAM", "The search provider sent a response VertexRank couldn't read.", 502);
    // SerpApi answers 200 with an "error" field when a search simply found nothing; that is an empty result, not a failure.
    if (typeof data.error === "string" && !/hasn't returned any results|no results/i.test(data.error)) {
      if (/run out|out of searches|plan|quota/i.test(data.error)) throw new SerpError("QUOTA", "The search provider's monthly search allowance is used up. It resets with your plan's billing month.", 429);
      throw new SerpError("UPSTREAM", "The search provider couldn't complete that search. Try again.", 502);
    }

    return {
      query, country, device,
      results: normalizeSerpApi(data),
      source: "SerpApi (Google)",
      observedAt: new Date(now()).toISOString(),
    };
  }

  return { id: "serpapi", configured: () => !!key(), search };
}

const PROVIDERS = { serpapi: createSerpApiProvider };

/** The provider named by SERP_PROVIDER (default: serpapi). An unknown name is a configuration error, not a crash. */
export function createSerp({ env = process.env, fetchImpl, now } = {}) {
  const name = (typeof env.SERP_PROVIDER === "string" && env.SERP_PROVIDER.trim().toLowerCase()) || "serpapi";
  const make = PROVIDERS[name];
  if (!make) throw new SerpError("BAD_CONFIG", `SERP_PROVIDER "${name.slice(0, 40)}" isn't a supported provider.`, 503);
  return make({ env, fetchImpl, now });
}
