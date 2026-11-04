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

const relClean = (v, n) => [...new Set((Array.isArray(v) ? v : []).map((x) => clip(x, 160)).filter((x) => x.length >= 3))].slice(0, n);

/**
 * Google's own suggestions that come back with the same search at no extra cost: "related searches" and "people also ask" QUESTIONS.
 * Only the question text is kept — never the answer snippets, which are other sites' content.
 */
export function normalizeRelated(data) {
  return {
    searches: relClean((Array.isArray(data?.related_searches) ? data.related_searches : []).map((r) => r?.query), 12),
    questions: relClean((Array.isArray(data?.related_questions) ? data.related_questions : []).map((r) => r?.question), 8),
  };
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

/* ------------------------------------------------------------------ */
/* several API keys that rotate                                       */
/* ------------------------------------------------------------------ */

/**
 * Every SerpApi key in the environment, in a stable order, without duplicates:
 *   SERPAPI_KEY, SERPAPI_KEYS (comma, space or newline separated), then SERPAPI_KEY_1 ... SERPAPI_KEY_50 (gaps are fine).
 * Each free key has its own monthly allowance, so more keys means more searches.
 */
export function listSerpKeys(env = process.env) {
  const out = [];
  const add = (v) => { if (typeof v === "string") for (const k of v.split(/[\s,]+/)) if (k.trim()) out.push(k.trim()); };
  add(env.SERPAPI_KEY); add(env.SERPAPI_KEYS);
  for (let i = 1; i <= 50; i++) add(env[`SERPAPI_KEY_${i}`]);
  return [...new Set(out)];
}
export const countSerpKeys = (env = process.env) => listSerpKeys(env).length;

// Failures that belong to ONE key (so the next key may well work) and how long to leave that key alone afterwards.
const ROTATE_ON = { AUTH_FAILED: 60 * 60 * 1000, QUOTA: 6 * 60 * 60 * 1000, RATE_LIMIT: 60 * 1000 };
// Shared by every search in this server instance: which key goes next, and which keys are cooling down. (Serverless instances each
// keep their own copy; that only means an instance may retry a spent key once, which costs nothing because failed calls aren't billed.)
const sharedState = { cooling: new Map(), cursor: 0 };
const keyId = (k) => { let h = 5381; for (let i = 0; i < k.length; i++) h = ((h << 5) + h + k.charCodeAt(i)) | 0; return `k${Math.abs(h).toString(36)}`; };

export function createSerpApiProvider({ env = process.env, fetchImpl, now = () => Date.now(), state = sharedState } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const keys = () => listSerpKeys(env);

  /** One search with one specific key. Throws SerpError; the caller decides whether another key is worth trying. */
  async function attempt(key, { query, country, device }) {
    const { gl, hl } = localeFor(country);
    const u = new URL("https://serpapi.com/search.json");
    u.searchParams.set("engine", "google");
    u.searchParams.set("q", query);
    u.searchParams.set("device", device);
    u.searchParams.set("hl", hl);
    if (gl) u.searchParams.set("gl", gl);
    u.searchParams.set("api_key", key);

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
      related: normalizeRelated(data),
      source: "SerpApi (Google)",
      observedAt: new Date(now()).toISOString(),
    };
  }

  /**
   * Round-robin across the configured keys so usage spreads evenly; if the chosen key is rejected, used up or rate-limited, the same
   * search moves on to the next key (and that key is left alone for a while). Network and provider outages are NOT retried on other
   * keys: they would fail the same way and burn calls. With a single key this behaves exactly as before.
   */
  async function search(req) {
    const all = keys();
    if (all.length === 0) throw new SerpError("NOT_CONFIGURED", "Live search results aren't set up yet. Add SERPAPI_KEY (or SERPAPI_KEY_1, SERPAPI_KEY_2, ...) on the server to turn them on.", 503);
    const start = state.cursor++ % all.length;
    const rotated = all.map((_, i) => all[(start + i) % all.length]);
    const t = now();
    const cooling = (k) => (state.cooling.get(keyId(k))?.until ?? 0) > t;
    const order = [...rotated.filter((k) => !cooling(k)), ...rotated.filter(cooling)]; // cooled-down keys are a last resort, not skipped forever
    const seen = [];
    for (const key of order) {
      try {
        const result = await attempt(key, req);
        state.cooling.delete(keyId(key));
        return result;
      } catch (err) {
        if (!(err instanceof SerpError) || !(err.code in ROTATE_ON)) throw err;
        state.cooling.set(keyId(key), { until: now() + ROTATE_ON[err.code], code: err.code });
        seen.push(err);
      }
    }
    throw summarizeKeyFailures(seen, all.length);
  }

  return { id: "serpapi", configured: () => keys().length > 0, keyCount: () => keys().length, search };
}

/** One clear error for "every key failed". With one key the original message is kept as is. */
function summarizeKeyFailures(errors, total) {
  if (total === 1) return errors[0];
  const has = (c) => errors.some((e) => e.code === c);
  if (has("RATE_LIMIT")) return new SerpError("RATE_LIMIT", `All ${total} search keys are being rate-limited right now. Wait a minute and try again.`, 429);
  if (has("QUOTA")) return new SerpError("QUOTA", `All ${total} search keys have used their monthly search allowance. They reset with each key's billing month, or add another key.`, 429);
  return new SerpError("AUTH_FAILED", `The search provider rejected all ${total} API keys. Check the SERPAPI_KEY values.`, 502);
}

const PROVIDERS = { serpapi: createSerpApiProvider };

/** The provider named by SERP_PROVIDER (default: serpapi). An unknown name is a configuration error, not a crash. */
export function createSerp({ env = process.env, fetchImpl, now } = {}) {
  const name = (typeof env.SERP_PROVIDER === "string" && env.SERP_PROVIDER.trim().toLowerCase()) || "serpapi";
  const make = PROVIDERS[name];
  if (!make) throw new SerpError("BAD_CONFIG", `SERP_PROVIDER "${name.slice(0, 40)}" isn't a supported provider.`, 503);
  return make({ env, fetchImpl, now });
}
