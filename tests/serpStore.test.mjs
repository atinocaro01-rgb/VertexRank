import test from "node:test";
import assert from "node:assert/strict";
import { createStore, StoreError, isUuid, isSiteHost, MAX_TRACKED_PER_SITE } from "../lib/serpStore.js";

const KEY = "service-role-SECRET-key";
const ENV = { SUPABASE_URL: "https://abc.supabase.co/", SUPABASE_SERVICE_ROLE_KEY: KEY };
const ID = "0b9f1c2e-1111-4222-8333-444455556666";
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, json: async () => body });
function harness(handler) { const calls = []; const store = createStore({ env: ENV, fetchImpl: async (url, init) => { calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined }); return handler(url, init, calls); } }); return { store, calls }; }
const row = (o = {}) => ({ id: ID, site_host: "mysite.com", query: "safari", country: "Kenya", device: "desktop", active: true, last_checked_at: null, created_at: "2026-11-01T00:00:00Z", ...o });

test("validators", () => {
  assert.equal(isUuid(ID), true); assert.equal(isUuid("1;drop"), false); assert.equal(isUuid(null), false);
  for (const ok of ["mysite.com", "a.b.co.ke"]) assert.equal(isSiteHost(ok), true, ok);
  for (const bad of ["", "My Site.com", "a/b", ".x.com", "a..b", "x".repeat(300), null, "a.com?x=1"]) assert.equal(isSiteHost(bad), false, String(bad));
});

test("unconfigured store reports itself and refuses to call out; a malformed URL is a configuration error", async () => {
  const none = createStore({ env: {}, fetchImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(none.configured(), false); await assert.rejects(none.listKeywords("a.com"), (e) => e.code === "NOT_CONFIGURED" && e.status === 503);
  const bad = createStore({ env: { SUPABASE_URL: "http://x.com/path", SUPABASE_SERVICE_ROLE_KEY: KEY }, fetchImpl: async () => res(200, []) });
  await assert.rejects(bad.listKeywords("a.com"), (e) => e.code === "BAD_CONFIG");
});

test("requests go to the project's REST API with the key in headers only, and filter values are encoded", async () => {
  const { store, calls } = harness(() => res(200, [row({ query: "a&b=c" })]));
  const list = await store.listKeywords("mysite.com");
  assert.equal(calls[0].url, "https://abc.supabase.co/rest/v1/tracked_keywords?site_host=eq.mysite.com&order=created_at.asc&limit=100");
  assert.equal(calls[0].init.headers.apikey, KEY); assert.ok(!calls[0].url.includes(KEY)); assert.equal(list[0].siteHost, "mysite.com"); assert.equal(list[0].lastCheckedAt, null);
  await store.findKeyword({ siteHost: "mysite.com", query: "a&b=c d", country: "Kenya", device: "mobile" });
  assert.match(calls[1].url, /query=eq\.a%26b%3Dc%20d&country=eq\.Kenya&device=eq\.mobile/);
  await assert.rejects(store.listKeywords("bad host"), (e) => e.code === "BAD_REQUEST");
  await assert.rejects(store.setActive("not-a-uuid", true), (e) => e.code === "BAD_REQUEST");
  await assert.rejects(store.removeKeyword("1 or 1=1"), (e) => e.code === "BAD_REQUEST");
  assert.deepEqual(await store.snapshots(["junk"], "2026-01-01T00:00:00Z"), []);
});

test("addKeyword: creates, reports duplicates, and enforces the per-site cap", async () => {
  let h = harness((url, init) => (init.method === "GET" ? res(200, []) : res(201, [row()])));
  const added = await h.store.addKeyword({ siteHost: "mysite.com", query: "safari", country: "Kenya", device: "desktop" });
  assert.equal(added.created, true); const post = h.calls.find((c) => c.init.method === "POST"); assert.match(post.url, /on_conflict=site_host,query,country,device/); assert.match(post.init.headers.Prefer, /ignore-duplicates/);
  h = harness((url, init) => (init.method === "GET" ? res(200, [row()]) : res(201, [])));
  const dup = await h.store.addKeyword({ siteHost: "mysite.com", query: "safari", country: "Kenya", device: "desktop" }); assert.equal(dup.created, false); assert.equal(dup.keyword.id, ID);
  h = harness(() => res(200, Array.from({ length: MAX_TRACKED_PER_SITE }, (_, i) => row({ id: `0b9f1c2e-1111-4222-8333-44445555${String(i).padStart(4, "0")}` }))));
  await assert.rejects(h.store.addKeyword({ siteHost: "mysite.com", query: "x", country: "Kenya", device: "desktop" }), (e) => e.code === "LIMIT");
});

test("insertSnapshot writes the snapshot and marks the keyword as checked; counts read the total from Content-Range", async () => {
  const { store, calls } = harness((url, init) => (init.method === "GET" ? res(206, [], { "content-range": "0-0/37" }) : res(201, [])));
  await store.insertSnapshot({ keywordId: ID, checkedAt: "2026-11-02T05:00:00.000Z", position: 6, rankingUrl: "https://mysite.com/x", provider: "SerpApi (Google)", trigger: "scheduled", topResults: [{ rank: 1, title: "t", url: "https://a.com" }] });
  assert.equal(calls[0].body.position, 6); assert.equal(calls[0].body.trigger, "scheduled"); assert.equal(calls[1].init.method, "PATCH"); assert.equal(calls[1].body.last_checked_at, "2026-11-02T05:00:00.000Z");
  assert.equal(await store.countSnapshotsSince("2026-11-01T00:00:00.000Z"), 37);
  assert.equal(calls[2].init.headers.Prefer, "count=exact");
});

test("database failures become clear errors that never contain the key", async () => {
  const cases = [[() => res(401, {}), "AUTH_FAILED"], [() => res(404, { code: "PGRST205" }), "NO_TABLES"], [() => res(400, { code: "42P01" }), "NO_TABLES"], [() => res(503, {}), "UNREACHABLE"], [() => res(500, {}), "DB"], [() => { throw new Error(`fetch failed ${KEY}`); }, "UNREACHABLE"]];
  for (const [handler, code] of cases) { const { store } = harness(handler); await assert.rejects(store.listKeywords("a.com"), (e) => e instanceof StoreError && e.code === code && !e.message.includes("SECRET"), code); }
});

test("claimRun returns the id once and null for a duplicate claim", async () => {
  let n = 0; const { store, calls } = harness(() => res(201, n++ === 0 ? [{ id: 7 }] : []));
  assert.equal(await store.claimRun("serp", "2026-11-10"), 7); assert.equal(await store.claimRun("serp", "2026-11-10"), null);
  assert.match(calls[0].url, /on_conflict=job,run_day/);
});
