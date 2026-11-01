import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { errorResponse, serpFromEnv, serpCacheKey, createSerpCache } from "../lib/serpApi.js";
import { SerpError } from "../lib/serpProvider.js";

test("SerpErrors become JSON with the right status and no internals; unexpected errors are generic", async () => {
  const cases = [["NOT_CONFIGURED", 503], ["BAD_CONFIG", 503], ["BAD_REQUEST", 400], ["AUTH_FAILED", 502], ["RATE_LIMIT", 429], ["QUOTA", 429], ["NETWORK", 502], ["UPSTREAM", 502]];
  for (const [code, status] of cases) { const r = errorResponse(new SerpError(code, "friendly")); assert.equal(r.status, status, code); assert.deepEqual(await r.json(), { error: "friendly", code }); }
  const orig = console.error; console.error = () => {};
  try { const r = errorResponse(new Error("api_key=SECRET leaked")); assert.equal(r.status, 500); assert.ok(!JSON.stringify(await r.json()).includes("SECRET")); } finally { console.error = orig; }
});

test("serpFromEnv reports an unconfigured environment instead of throwing; the cache key separates country, device and query case", () => {
  assert.equal(serpFromEnv({}).configured(), false);
  const a = serpCacheKey("serpapi", { query: "Safari", country: "Kenya", device: "desktop" });
  assert.equal(a, serpCacheKey("serpapi", { query: "safari", country: "Kenya", device: "desktop" }));
  assert.notEqual(a, serpCacheKey("serpapi", { query: "safari", country: "Kenya", device: "mobile" }));
  assert.notEqual(a, serpCacheKey("serpapi", { query: "safari", country: "Uganda", device: "desktop" }));
  assert.equal(typeof createSerpCache().delete, "function");
});

test("serp/search: guarded first, server-only, validates before calling the provider, and never touches the key", () => {
  const src = readFileSync(new URL("../app/api/serp/search/route.js", import.meta.url), "utf8");
  assert.match(src, /guardJson\(req, "serp"\)/); assert.ok(src.indexOf("guardJson(") < src.indexOf("serpFromEnv("), "guard runs first");
  assert.ok(src.indexOf("validateSerpRequest(") < src.indexOf(".search("), "validation runs before the provider is called");
  assert.match(src, /export const runtime = "nodejs"/); assert.ok(!/process\.env/.test(src), "the route never reads the environment itself"); assert.ok(!/SERPAPI_KEY/.test(src));
  assert.match(src, /refresh === true/);
});
