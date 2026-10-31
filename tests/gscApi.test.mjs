import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { errorResponse, createCache, gscFromEnv } from "../lib/gscApi.js";
import { GscError } from "../lib/gscAuth.js";

test("GscErrors become JSON with the right status and no internals; unexpected errors are generic", async () => {
  const cases = [["NOT_CONFIGURED", 503], ["BAD_CONFIG", 503], ["BAD_KEY", 502], ["AUTH_FAILED", 502], ["NETWORK", 502], ["FORBIDDEN", 403], ["NOT_FOUND", 404], ["RATE_LIMIT", 429], ["BAD_REQUEST", 400], ["UPSTREAM", 502]];
  for (const [code, status] of cases) { const r = errorResponse(new GscError(code, "friendly")); assert.equal(r.status, status, code); assert.deepEqual(await r.json(), { error: "friendly", code }); }
  const orig = console.error; console.error = () => {};
  try { const r = errorResponse(new Error("PRIVATE KEY leaked")); assert.equal(r.status, 500); assert.ok(!JSON.stringify(await r.json()).includes("PRIVATE")); } finally { console.error = orig; }
});

test("cache: hits within the TTL, expires, bounds its size, never caches failures, and can be invalidated", async () => {
  let t = 0, runs = 0;
  const cache = createCache({ ttlMs: 1000, max: 2, now: () => t });
  const run = (v) => cache("k", async () => { runs++; return v; });
  assert.deepEqual(await run("a"), { value: "a", cached: false }); assert.deepEqual(await run("b"), { value: "a", cached: true }); assert.equal(runs, 1);
  t = 1500; assert.deepEqual(await run("c"), { value: "c", cached: false });
  cache.delete("k"); assert.equal((await run("d")).value, "d");
  await assert.rejects(cache("bad", async () => { throw new Error("boom"); }), /boom/); assert.equal((await cache("bad", async () => "ok")).cached, false, "a failure left nothing behind");
  await cache("x", async () => 1); await cache("y", async () => 2); await cache("z", async () => 3);
  assert.equal((await cache("k", async () => "again")).cached, false, "oldest entries are evicted when full");
});

test("gscFromEnv wires auth and client; an unconfigured environment is reported, not thrown", () => {
  const { auth, client } = gscFromEnv({});
  assert.equal(auth.configured(), false); assert.equal(typeof client.query, "function");
});

const route = (n) => readFileSync(new URL(`../app/api/gsc/${n}/route.js`, import.meta.url), "utf8");
for (const name of ["properties", "report"]) {
  test(`gsc/${name}: guarded first, server-only, and never touches the key or returns raw upstream data`, () => {
    const src = route(name);
    assert.match(src, /guardJson\(req, "gsc"\)/); assert.ok(src.indexOf("guardJson(") < src.indexOf("gscFromEnv("), "guard runs first");
    assert.match(src, /export const runtime = "nodejs"/); assert.ok(!/process\.env/.test(src), "routes never read the environment (and so never touch the key) themselves");
    assert.ok(!/private_key|client_secret/.test(src));
  });
}
test("gsc/report validates the property and period before calling Google, and only offers fresh data on request", () => {
  const src = route("report");
  assert.match(src, /isValidProperty\(siteUrl\)/); assert.match(src, /ALLOWED_DAYS\.includes/); assert.match(src, /refresh === true/); assert.match(src, /cache\.delete\(key\)/);
});
