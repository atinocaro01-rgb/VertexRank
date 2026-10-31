import test from "node:test";
import assert from "node:assert/strict";
import { createGscClient, isValidProperty, validateRange } from "../lib/gscClient.js";
import { GscError } from "../lib/gscAuth.js";

const auth = { getAccessToken: async () => "tok", serviceAccountEmail: () => "svc@proj.iam.gserviceaccount.com" };
const NOW = Date.parse("2026-10-28T12:00:00Z");
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function harness(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null }); return handler(url, init, calls); };
  return { calls, client: createGscClient({ auth, fetchImpl, now: () => NOW, sleep: async () => {} }) };
}
const SITES = { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteRestrictedUser" }, { siteUrl: "https://other.com/", permissionLevel: "siteFullUser" }, { siteUrl: "https://nope.com/", permissionLevel: "siteUnverifiedUser" }] };

test("isValidProperty accepts domain and URL-prefix properties only", () => {
  for (const ok of ["sc-domain:example.com", "sc-domain:sub.example.co.ke", "https://example.com/", "http://example.com/blog/", "https://example.com:8080/", "https://www.example.com"]) assert.equal(isValidProperty(ok), true, ok);
  for (const bad of ["", null, "example.com", "sc-domain:", "sc-domain:exa mple.com", "ftp://example.com/", "https://example.com/?q=1", "https://exa mple.com/", "javascript:alert(1)", "x".repeat(301), "sc-domain:../x"]) assert.equal(isValidProperty(bad), false, String(bad));
});

test("validateRange: real dates, ordered, not in the future, within retention", () => {
  assert.doesNotThrow(() => validateRange("2026-10-01", "2026-10-25", NOW));
  for (const [s, e] of [["2026-10-01", "2026-09-01"], ["2026-13-01", "2026-13-02"], ["2026-02-30", "2026-03-01"], ["nope", "2026-10-01"], ["2026-10-01", "2026-11-30"], ["2024-01-01", "2026-10-01"], [undefined, undefined]]) assert.throws(() => validateRange(s, e, NOW), { code: "BAD_REQUEST" }, `${s}..${e}`);
});

test("listSites hides unverified properties and caches for a few minutes", async () => {
  const { client, calls } = harness(() => json(200, SITES));
  assert.deepEqual(await client.listSites(), [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteRestrictedUser" }, { siteUrl: "https://other.com/", permissionLevel: "siteFullUser" }]);
  await client.listSites(); assert.equal(calls.length, 1);
  await client.listSites({ fresh: true }); assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://www.googleapis.com/webmasters/v3/sites"); assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
});

test("query: encodes the property into the path, sends a bounded body, and normalises rows", async () => {
  const { client, calls } = harness((url) => (url.endsWith("/sites") ? json(200, SITES) : json(200, { rows: [{ keys: ["shoes"], clicks: 5, impressions: "100", ctr: 0.05, position: 3.21 }, { keys: null, clicks: "x" }] })));
  const rows = await client.query("sc-domain:example.com", { startDate: "2026-10-01", endDate: "2026-10-25", dimensions: ["query"], rowLimit: 999999 });
  assert.deepEqual(rows, [{ keys: ["shoes"], clicks: 5, impressions: 100, ctr: 0.05, position: 3.21 }, { keys: [], clicks: 0, impressions: 0, ctr: 0, position: 0 }]);
  const q = calls[1];
  assert.equal(q.url, "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query"); assert.equal(q.init.method, "POST");
  assert.deepEqual(q.body, { startDate: "2026-10-01", endDate: "2026-10-25", dimensions: ["query"], rowLimit: 25000, startRow: 0, type: "web" });
  const { client: c2 } = harness((url) => (url.endsWith("/sites") ? json(200, SITES) : json(200, {})));
  assert.deepEqual(await c2.query("https://other.com/", { startDate: "2026-10-01", endDate: "2026-10-02" }), []); // no rows -> empty, not an error
});

test("only properties the service account can see are queryable; bad input never reaches Google", async () => {
  const { client, calls } = harness(() => json(200, SITES));
  await assert.rejects(client.query("https://nope.com/", { startDate: "2026-10-01", endDate: "2026-10-02" }), (e) => e.code === "FORBIDDEN" && /svc@proj\.iam\.gserviceaccount\.com/.test(e.message));
  await assert.rejects(client.query("https://unlisted.com/", { startDate: "2026-10-01", endDate: "2026-10-02" }), { code: "FORBIDDEN" });
  await assert.rejects(client.query("../../evil", { startDate: "2026-10-01", endDate: "2026-10-02" }), { code: "BAD_REQUEST" });
  await assert.rejects(client.query("sc-domain:example.com", { startDate: "2026-10-01", endDate: "2026-10-02", dimensions: ["searchAppearance"] }), { code: "BAD_REQUEST" });
  await assert.rejects(client.query("sc-domain:example.com", { startDate: "2026-10-05", endDate: "2026-10-02" }), { code: "BAD_REQUEST" });
  assert.ok(calls.every((c) => c.url.endsWith("/sites")), "no search-analytics request was made for any rejected input");
});

test("Google errors become actionable messages", async () => {
  const run = async (status, body = {}) => { const { client } = harness((url) => (url.endsWith("/sites") ? json(200, SITES) : json(status, body))); return client.query("sc-domain:example.com", { startDate: "2026-10-01", endDate: "2026-10-02" }); };
  await assert.rejects(run(403), (e) => e.code === "FORBIDDEN" && /Users and permissions/.test(e.message) && /Restricted/.test(e.message));
  await assert.rejects(run(404), { code: "NOT_FOUND" }); await assert.rejects(run(401), { code: "AUTH_FAILED" });
  await assert.rejects(run(400, { error: { message: "Invalid dimension" } }), (e) => e.code === "BAD_REQUEST" && /Invalid dimension/.test(e.message));
  await assert.rejects(run(429), { code: "RATE_LIMIT" }); await assert.rejects(run(500), { code: "UPSTREAM" });
  const { client } = harness(() => { throw new Error("socket"); }); await assert.rejects(client.listSites(), { code: "NETWORK" });
});

test("one retry on 429/5xx, then success or failure", async () => {
  let n = 0;
  const { client } = harness((url) => (url.endsWith("/sites") ? (n++ === 0 ? json(503, {}) : json(200, SITES)) : json(200, { rows: [] })));
  assert.equal((await client.listSites()).length, 2); assert.equal(n, 2);
  let m = 0; const { client: c2 } = harness(() => { m++; return json(429, {}); });
  await assert.rejects(c2.listSites(), { code: "RATE_LIMIT" }); assert.equal(m, 2);
});

test("queryAll pages through results until the data runs out or the cap is hit", async () => {
  const mk = (n, from) => Array.from({ length: n }, (_, i) => ({ keys: [`q${from + i}`], clicks: 1, impressions: 2, ctr: 0.5, position: 1 }));
  const { client, calls } = harness((url, init) => { if (url.endsWith("/sites")) return json(200, SITES); const b = JSON.parse(init.body); return json(200, { rows: mk(Math.max(0, Math.min(b.rowLimit, 2500 - b.startRow)), b.startRow) }); });
  const all = await client.queryAll("sc-domain:example.com", { startDate: "2026-10-01", endDate: "2026-10-02", dimensions: ["query"] }, { maxRows: 5000, pageSize: 1000 });
  assert.equal(all.length, 2500); assert.deepEqual(calls.filter((c) => c.body).map((c) => [c.body.startRow, c.body.rowLimit]), [[0, 1000], [1000, 1000], [2000, 1000]]);
  const capped = await client.queryAll("sc-domain:example.com", { startDate: "2026-10-01", endDate: "2026-10-02", dimensions: ["query"] }, { maxRows: 1500, pageSize: 1000 });
  assert.equal(capped.length, 1500);
});
