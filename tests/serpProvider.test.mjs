import test from "node:test";
import assert from "node:assert/strict";
import { hostOf, sameSite, findSiteRank } from "../lib/serpMatch.js";
import { createSerp, createSerpApiProvider, validateSerpRequest, normalizeSerpApi, localeFor, SerpError, MAX_QUERY_LENGTH } from "../lib/serpProvider.js";

const NOW = Date.parse("2026-11-01T10:00:00Z");
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const KEY = "sk-test-SECRET-123";
const GOOD = { organic_results: [
  { position: 1, title: "First", link: "https://www.example.com/a", snippet: "one" },
  { position: 2, title: "Second", link: "https://other.co.ke/b", snippet: "two" },
  { position: 3, title: "Bad", link: "javascript:alert(1)", snippet: "x" },
] };

function harness(handler, env = { SERPAPI_KEY: KEY }) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: new URL(url), init }); return handler(url, init); };
  return { calls, provider: createSerpApiProvider({ env, fetchImpl, now: () => NOW }) };
}
const req = { query: "kenya safari", country: "Kenya", device: "desktop" };

test("validateSerpRequest trims, bounds, and sanitizes the query; country comes from the fixed list; device is checked", () => {
  assert.deepEqual(validateSerpRequest({ query: "  kenya   safari  ", country: "Kenya" }), { query: "kenya safari", country: "Kenya", device: "desktop" });
  assert.equal(validateSerpRequest({ query: "x", country: "Narnia; DROP" }).country, "Worldwide");
  assert.equal(validateSerpRequest({ query: "x", device: "mobile" }).device, "mobile");
  for (const bad of [{}, { query: "" }, { query: "   " }, { query: 5 }, { query: "a".repeat(MAX_QUERY_LENGTH + 1) }, { query: "a\u0000b" }, { query: "x", device: "tablet" }, { query: "x", device: {} }]) {
    assert.throws(() => validateSerpRequest(bad), (e) => e instanceof SerpError && e.code === "BAD_REQUEST" && e.status === 400, JSON.stringify(bad));
  }
});

test("localeFor maps markets to gl/hl, and Worldwide sends no location", () => {
  assert.deepEqual(localeFor("Kenya"), { gl: "ke", hl: "en" });
  assert.deepEqual(localeFor("France"), { gl: "fr", hl: "fr" });
  assert.deepEqual(localeFor("Botswana"), { gl: "bw", hl: "en" }); // "tn" isn't a safe interface language
  assert.deepEqual(localeFor("Worldwide"), { gl: null, hl: "en" });
});

test("normalizeSerpApi keeps organic results with http(s) links only, bounds text, and ignores everything else", () => {
  const out = normalizeSerpApi({ ...GOOD, ads: [{ link: "https://ad.com" }], answer_box: {} });
  assert.deepEqual(out.map((r) => [r.rank, r.url]), [[1, "https://www.example.com/a"], [2, "https://other.co.ke/b"]]);
  assert.equal(normalizeSerpApi({}).length, 0); assert.equal(normalizeSerpApi(null).length, 0);
  const many = { organic_results: Array.from({ length: 30 }, (_, i) => ({ position: i + 1, title: "t".repeat(900), link: `https://x${i}.com/`, snippet: "s".repeat(900) })) };
  const o = normalizeSerpApi(many); assert.equal(o.length, 10); assert.ok(o[0].title.length <= 300 && o[0].snippet.length <= 500);
});

test("search: calls only SerpApi's fixed host with the right parameters and returns the normalized shape", async () => {
  const { provider, calls } = harness(() => json(200, GOOD));
  const r = await provider.search(req);
  assert.equal(calls.length, 1); assert.equal(calls[0].url.origin, "https://serpapi.com"); assert.equal(calls[0].url.pathname, "/search.json");
  const p = calls[0].url.searchParams;
  assert.equal(p.get("engine"), "google"); assert.equal(p.get("q"), "kenya safari"); assert.equal(p.get("gl"), "ke"); assert.equal(p.get("hl"), "en"); assert.equal(p.get("device"), "desktop"); assert.equal(p.get("api_key"), KEY);
  assert.ok(calls[0].init.signal, "has a timeout");
  assert.deepEqual({ ...r, results: r.results.length }, { query: "kenya safari", country: "Kenya", device: "desktop", results: 2, related: { searches: [], questions: [] }, source: "SerpApi (Google)", observedAt: "2026-11-01T10:00:00.000Z" });
});

test("search: Worldwide omits gl; an unconfigured provider is reported, not thrown as a crash, and makes no request", async () => {
  const { provider, calls } = harness(() => json(200, GOOD));
  await provider.search({ ...req, country: "Worldwide" }); assert.equal(calls[0].url.searchParams.has("gl"), false);
  const none = harness(() => json(200, GOOD), {});
  assert.equal(none.provider.configured(), false);
  await assert.rejects(none.provider.search(req), (e) => e.code === "NOT_CONFIGURED" && e.status === 503); assert.equal(none.calls.length, 0);
});

test("search: provider failures become clear errors, and the key never appears in them", async () => {
  const cases = [
    [() => json(401, { error: "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key" }), "AUTH_FAILED"],
    [() => json(429, { error: "Your account has run out of searches." }), "QUOTA"],
    [() => json(429, { error: "Too many requests" }), "RATE_LIMIT"],
    [() => json(500, {}), "UPSTREAM"],
    [() => json(200, { error: "Something odd" }), "UPSTREAM"],
    [() => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }), "UPSTREAM"],
    [() => { throw new Error(`connect failed https://serpapi.com/search.json?api_key=${KEY}`); }, "NETWORK"],
  ];
  for (const [handler, code] of cases) {
    const { provider } = harness(handler);
    await assert.rejects(provider.search(req), (e) => e instanceof SerpError && e.code === code && !e.message.includes(KEY) && !e.message.includes("SECRET"), code);
  }
});

test("search: a 200 'no results' answer is an empty result, not a failure", async () => {
  const { provider } = harness(() => json(200, { error: "Google hasn't returned any results for this query." }));
  assert.deepEqual((await provider.search(req)).results, []);
});

test("createSerp defaults to SerpApi and rejects an unknown SERP_PROVIDER as a configuration error", () => {
  assert.equal(createSerp({ env: {} }).id, "serpapi");
  assert.equal(createSerp({ env: { SERP_PROVIDER: " SerpApi " } }).id, "serpapi");
  assert.throws(() => createSerp({ env: { SERP_PROVIDER: "nope" } }), (e) => e.code === "BAD_CONFIG");
});

test("site matching: www and subdomains match, lookalike hosts don't, and the best rank wins", () => {
  assert.equal(hostOf("https://WWW.Example.com/x?y"), "example.com"); assert.equal(hostOf("example.com/path"), "example.com"); assert.equal(hostOf(""), ""); assert.equal(hostOf("http://"), "");
  assert.equal(sameSite("https://blog.example.com/a", "example.com"), true); assert.equal(sameSite("https://example.com", "https://www.example.com/"), true);
  assert.equal(sameSite("https://notexample.com", "example.com"), false); assert.equal(sameSite("https://example.com.evil.io", "example.com"), false); assert.equal(sameSite("", "example.com"), false);
  const results = [{ rank: 1, url: "https://other.com/" }, { rank: 4, url: "https://blog.example.com/p" }, { rank: 7, url: "https://example.com/" }];
  assert.equal(findSiteRank(results, "example.com").rank, 4); assert.equal(findSiteRank(results, "nowhere.com"), null); assert.equal(findSiteRank(null, "example.com"), null);
});

import { listSerpKeys, countSerpKeys } from "../lib/serpProvider.js";

// --- several keys that rotate -------------------------------------------------------------------------------------------------------
const freshState = () => ({ cooling: new Map(), cursor: 0 });
function multi(env, handler, { now = () => NOW, state = freshState() } = {}) {
  const used = [];
  const fetchImpl = async (url) => { const k = new URL(url).searchParams.get("api_key"); used.push(k); return handler(k, url); };
  return { provider: createSerpApiProvider({ env, fetchImpl, now, state }), used, state };
}
const OK = () => json(200, GOOD);

test("listSerpKeys reads SERPAPI_KEY, SERPAPI_KEYS and SERPAPI_KEY_1..N in a stable order, without blanks or duplicates", () => {
  assert.deepEqual(listSerpKeys({ SERPAPI_KEY: "a", SERPAPI_KEYS: "b, c\nd e", SERPAPI_KEY_1: "f", SERPAPI_KEY_3: "g", SERPAPI_KEY_2: " ", SERPAPI_KEY_4: "a" }), ["a", "b", "c", "d", "e", "f", "g"]);
  assert.deepEqual(listSerpKeys({ SERPAPI_KEY_2: "y", SERPAPI_KEY_1: "x", SERPAPI_KEY_50: "z", SERPAPI_KEY_51: "ignored" }), ["x", "y", "z"]);
  assert.deepEqual(listSerpKeys({}), []); assert.equal(countSerpKeys({ SERPAPI_KEY_1: "a", SERPAPI_KEY_2: "b" }), 2);
  assert.deepEqual(listSerpKeys({ SERPAPI_KEY: 5, SERPAPI_KEYS: null }), []);
});

test("keys given only as SERPAPI_KEY_n make the provider configured, and it reports how many it has", () => {
  const { provider } = multi({ SERPAPI_KEY_1: "k1", SERPAPI_KEY_2: "k2" }, OK);
  assert.equal(provider.configured(), true); assert.equal(provider.keyCount(), 2);
  assert.equal(multi({}, OK).provider.configured(), false);
});

test("searches rotate round-robin so each key is used evenly", async () => {
  const { provider, used } = multi({ SERPAPI_KEY_1: "k1", SERPAPI_KEY_2: "k2", SERPAPI_KEY_3: "k3" }, OK);
  for (let i = 0; i < 6; i++) await provider.search(req);
  assert.deepEqual(used, ["k1", "k2", "k3", "k1", "k2", "k3"]);
});

test("a key that is used up fails over to the next key within the same search, and is skipped afterwards", async () => {
  const { provider, used } = multi({ SERPAPI_KEY_1: "k1", SERPAPI_KEY_2: "k2", SERPAPI_KEY_3: "k3" }, (k) => (k === "k1" ? json(429, { error: "Your account has run out of searches." }) : OK()));
  const r = await provider.search(req);
  assert.equal(r.results.length, 2); assert.deepEqual(used, ["k1", "k2"], "k1 failed, k2 answered, in one search");
  used.length = 0; await provider.search(req); await provider.search(req); await provider.search(req);
  assert.ok(!used.includes("k1"), `k1 is cooling down: ${used}`); assert.deepEqual(used, ["k2", "k3", "k2"]);
});

test("a cooled-down key is tried again after its cooldown, and a success clears it", async () => {
  let t = NOW; let k1Broken = true;
  const { provider, used, state } = multi({ SERPAPI_KEY_1: "k1", SERPAPI_KEY_2: "k2" }, (k) => (k === "k1" && k1Broken ? json(429, { error: "Too many requests" }) : OK()), { now: () => t });
  await provider.search(req); assert.deepEqual(used, ["k1", "k2"]); assert.equal(state.cooling.size, 1);
  used.length = 0; k1Broken = false; t += 61_000; // a rate-limit cooldown is one minute
  await provider.search(req); await provider.search(req); assert.ok(used.includes("k1")); assert.equal(state.cooling.size, 0);
});

test("a rejected key (bad key) also rotates; the error for every-key-failed names the count and never a key", async () => {
  let r = multi({ SERPAPI_KEY_1: "bad", SERPAPI_KEY_2: "good" }, (k) => (k === "bad" ? json(401, { error: "Invalid API key." }) : OK()));
  assert.equal((await r.provider.search(req)).results.length, 2);
  const allQuota = multi({ SERPAPI_KEY_1: "SECRET-1", SERPAPI_KEY_2: "SECRET-2", SERPAPI_KEY_3: "SECRET-3" }, () => json(429, { error: "Your account has run out of searches." }));
  await assert.rejects(allQuota.provider.search(req), (e) => e.code === "QUOTA" && /All 3 search keys/.test(e.message) && !/SECRET/.test(e.message)); assert.equal(allQuota.used.length, 3);
  const allBad = multi({ SERPAPI_KEY_1: "a", SERPAPI_KEY_2: "b" }, () => json(401, { error: "Invalid API key." }));
  await assert.rejects(allBad.provider.search(req), (e) => e.code === "AUTH_FAILED" && /all 2 API keys/.test(e.message));
  const mixed = multi({ SERPAPI_KEY_1: "a", SERPAPI_KEY_2: "b" }, (k) => (k === "a" ? json(401, { error: "Invalid API key." }) : json(429, { error: "Too many requests" })));
  await assert.rejects(mixed.provider.search(req), (e) => e.code === "RATE_LIMIT");
});

test("when every key is cooling down they are still tried (so a renewed allowance is noticed), and outages don't burn other keys", async () => {
  let broken = true;
  const { provider, used } = multi({ SERPAPI_KEY_1: "k1", SERPAPI_KEY_2: "k2" }, () => (broken ? json(429, { error: "Your account has run out of searches." }) : OK()));
  await assert.rejects(provider.search(req), (e) => e.code === "QUOTA"); used.length = 0; broken = false;
  assert.equal((await provider.search(req)).results.length, 2); assert.equal(used.length, 1, "every key was cooling, so the first tried is used and answers");
  const down = multi({ SERPAPI_KEY_1: "k1", SERPAPI_KEY_2: "k2", SERPAPI_KEY_3: "k3" }, () => { throw new Error("connect failed"); });
  await assert.rejects(down.provider.search(req), (e) => e.code === "NETWORK"); assert.equal(down.used.length, 1, "a network failure is not retried on other keys");
  const upstream = multi({ SERPAPI_KEY_1: "k1", SERPAPI_KEY_2: "k2" }, () => json(500, {}));
  await assert.rejects(upstream.provider.search(req), (e) => e.code === "UPSTREAM"); assert.equal(upstream.used.length, 1);
});

test("a single key behaves exactly as before (same error messages)", async () => {
  const one = multi({ SERPAPI_KEY: "only" }, () => json(429, { error: "Your account has run out of searches." }));
  await assert.rejects(one.provider.search(req), (e) => e.code === "QUOTA" && /monthly search allowance is used up/.test(e.message));
});
