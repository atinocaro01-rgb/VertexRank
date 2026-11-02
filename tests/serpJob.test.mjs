import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkKeywords, runScheduledChecks, jobConfig } from "../lib/serpJob.js";
import { SerpError } from "../lib/serpProvider.js";
import { StoreError } from "../lib/serpStore.js";

const NOW = Date.parse("2026-11-10T05:10:00Z");
const DAY = 86400000;
const kw = (id, daysAgo, o = {}) => ({ id, siteHost: "mysite.com", query: `q-${id}`, country: "Kenya", device: "desktop", active: true, lastCheckedAt: daysAgo === null ? null : new Date(NOW - daysAgo * DAY).toISOString(), ...o });
const RESULTS = [{ rank: 1, title: "A", url: "https://a.com/" }, { rank: 3, title: "Mine", url: "https://mysite.com/p" }];

function fakes({ keywords = [], used = 0, claim = 1, searchImpl } = {}) {
  const log = { snapshots: [], finished: null, released: false, searches: [], claims: 0 };
  const store = {
    claimRun: async () => { log.claims++; return claim; },
    listActiveKeywords: async () => keywords,
    countSnapshotsSince: async () => used,
    insertSnapshot: async (s) => { log.snapshots.push(s); },
    finishRun: async (id, r) => { log.finished = { id, ...r }; },
    releaseRun: async () => { log.released = true; },
  };
  const serp = { configured: () => true, search: searchImpl || (async (r) => { log.searches.push(r.query); return { query: r.query, country: r.country, device: r.device, results: RESULTS, source: "SerpApi (Google)", observedAt: "2026-11-10T05:10:01.000Z" }; }) };
  return { store, serp, log };
}

test("scheduled run: checks due keywords (never-checked first), stores positions as 'scheduled', and records the run", async () => {
  const f = fakes({ keywords: [kw("a", 8), kw("b", null), kw("c", 2)] });
  const r = await runScheduledChecks({ ...f, env: {}, now: () => NOW });
  assert.equal(r.status, "ok"); assert.equal(r.checked, 2); assert.deepEqual(f.log.searches, ["q-b", "q-a"]);
  assert.equal(f.log.snapshots[0].position, 3); assert.equal(f.log.snapshots[0].trigger, "scheduled"); assert.equal(f.log.snapshots[0].rankingUrl, "https://mysite.com/p");
  assert.equal(f.log.finished.status, "ok"); assert.equal(f.log.finished.checked, 2);
});

test("scheduled run: a duplicated delivery is skipped without spending anything", async () => {
  const f = fakes({ keywords: [kw("a", null)], claim: null });
  const r = await runScheduledChecks({ ...f, env: {}, now: () => NOW });
  assert.equal(r.status, "skipped"); assert.equal(f.log.searches.length, 0); assert.equal(f.log.finished, null);
});

test("scheduled run: the per-run cap, the monthly budget and the manual reserve all limit spending", async () => {
  const many = Array.from({ length: 12 }, (_, i) => kw(`k${i}`, null));
  let f = fakes({ keywords: many }); await runScheduledChecks({ ...f, env: { SERP_CRON_MAX_PER_RUN: "3" }, now: () => NOW }); assert.equal(f.log.searches.length, 3);
  f = fakes({ keywords: many, used: 148 }); await runScheduledChecks({ ...f, env: { SERP_MONTHLY_BUDGET: "200", SERP_MANUAL_RESERVE: "50" }, now: () => NOW }); assert.equal(f.log.searches.length, 2);
  f = fakes({ keywords: many, used: 150 }); const r = await runScheduledChecks({ ...f, env: { SERP_MONTHLY_BUDGET: "200", SERP_MANUAL_RESERVE: "50" }, now: () => NOW });
  assert.equal(r.status, "budget_exhausted"); assert.equal(f.log.searches.length, 0); assert.match(r.note, /150 of 200/);
});

test("scheduled run: nothing due, or no provider key, spends nothing and says why", async () => {
  let f = fakes({ keywords: [kw("a", 1)] }); let r = await runScheduledChecks({ ...f, env: {}, now: () => NOW }); assert.equal(r.status, "idle"); assert.equal(f.log.finished.status, "idle");
  f = fakes({ keywords: [kw("a", null)] }); f.serp.configured = () => false; r = await runScheduledChecks({ ...f, env: {}, now: () => NOW }); assert.equal(r.status, "no_provider"); assert.equal(f.log.searches.length, 0);
});

test("scheduled run: a provider error that would repeat stops the run; a one-off failure doesn't block the rest; failed keywords stay due", async () => {
  let f = fakes({ keywords: [kw("a", null), kw("b", null)], searchImpl: async () => { throw new SerpError("QUOTA", "Allowance used up.", 429); } });
  let r = await runScheduledChecks({ ...f, env: {}, now: () => NOW }); assert.equal(r.status, "failed"); assert.equal(r.errors.length, 1, "stopped after the first fatal error"); assert.equal(f.log.snapshots.length, 0);
  let n = 0; f = fakes({ keywords: [kw("a", null), kw("b", null)], searchImpl: async (q) => { if (n++ === 0) throw new SerpError("UPSTREAM", "Provider hiccup.", 502); return { query: q.query, country: q.country, device: q.device, results: RESULTS, source: "SerpApi (Google)", observedAt: "2026-11-10T05:10:01.000Z" }; } });
  r = await runScheduledChecks({ ...f, env: {}, now: () => NOW }); assert.equal(r.status, "partial"); assert.equal(r.checked, 1); assert.equal(f.log.snapshots[0].keywordId, "b");
});

test("scheduled run: if the database fails before any search, the day's claim is released so a later delivery can run", async () => {
  const f = fakes({ keywords: [kw("a", null)] }); f.store.listActiveKeywords = async () => { throw new StoreError("UNREACHABLE", "db down", 502); };
  await assert.rejects(runScheduledChecks({ ...f, env: {}, now: () => NOW }), /db down/); assert.equal(f.log.released, true);
});

test("checkKeywords stops at the time limit and reports what it skipped", async () => {
  let t = 0; const f = fakes({ keywords: [] }); f.serp.search = async (q) => { t += 30000; return { query: q.query, country: q.country, device: q.device, results: RESULTS, source: "SerpApi (Google)", observedAt: "2026-11-10T05:10:01.000Z" }; };
  const r = await checkKeywords({ store: f.store, serp: f.serp, keywords: [kw("a", null), kw("b", null), kw("c", null)], trigger: "manual", now: () => t, deadlineMs: 45000 });
  assert.equal(r.checked.length, 2); assert.equal(r.errors.length, 1); assert.match(r.errors[0].message, /time limit/);
});

test("jobConfig has safe defaults and clamps bad values", () => {
  assert.deepEqual(jobConfig({}), { perRunMax: 5, intervalDays: 7, monthlyBudget: 200, reserve: 50 });
  assert.deepEqual(jobConfig({ SERP_CRON_MAX_PER_RUN: "999", SERP_CHECK_INTERVAL_DAYS: "0", SERP_MONTHLY_BUDGET: "abc", SERP_MANUAL_RESERVE: "-5" }), { perRunMax: 20, intervalDays: 1, monthlyBudget: 200, reserve: 0 });
});

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
test("routes: password-gated ones guard first and never read the environment; the cron route verifies the secret first; the middleware exempts only the cron path", () => {
  for (const [p, policy] of [["app/api/serp/tracked/route.js", "serpData"], ["app/api/serp/history/route.js", "serpData"], ["app/api/serp/check/route.js", "serp"]]) {
    const s = src(p); assert.match(s, new RegExp(`guardJson\\(req, "${policy}"\\)`), p); assert.ok(s.indexOf("guardJson(") < s.indexOf("serpStoreFromEnv("), `${p}: guard first`); assert.ok(!/process\.env/.test(s), `${p}: no env`); assert.match(s, /export const runtime = "nodejs"/);
  }
  const cron = src("app/api/cron/serp/route.js"); assert.ok(cron.indexOf("isCronRequest(") < cron.indexOf("serpStoreFromEnv("), "secret checked before anything else"); assert.match(cron, /status: 401/);
  const mw = src("middleware.js"); assert.match(mw, /CRON_PATHS\.includes\(req\.nextUrl\.pathname\) && isCronRequest\(/);
  assert.deepEqual(JSON.parse(src("vercel.json")).crons, [{ path: "/api/cron/serp", schedule: "0 5 * * *" }]);
});

import { recordIfTracked } from "../lib/serpTracking.js";
test("recordIfTracked saves a snapshot only for an active tracked keyword, and never throws", async () => {
  const result = { query: "Kenya Safari", country: "Kenya", device: "desktop", source: "SerpApi (Google)", observedAt: "2026-11-10T05:10:01.000Z", results: RESULTS };
  const saved = []; let looked;
  const store = (kwRow) => ({ configured: () => true, findKeyword: async (q) => { looked = q; return kwRow; }, insertSnapshot: async (s) => { saved.push(s); } });
  assert.equal(await recordIfTracked({ store: store({ id: "k1", active: true }), siteHost: "https://www.mysite.com/x", result }), true);
  assert.equal(looked.query, "kenya safari"); assert.equal(looked.siteHost, "mysite.com"); assert.equal(saved[0].position, 3); assert.equal(saved[0].trigger, "manual");
  assert.equal(await recordIfTracked({ store: store(null), siteHost: "mysite.com", result }), false);
  assert.equal(await recordIfTracked({ store: store({ id: "k1", active: false }), siteHost: "mysite.com", result }), false);
  assert.equal(await recordIfTracked({ store: { configured: () => false }, siteHost: "mysite.com", result }), false);
  assert.equal(await recordIfTracked({ store: store({ id: "k1", active: true }), siteHost: "", result }), false);
  assert.equal(await recordIfTracked({ store: { configured: () => true, findKeyword: async () => { throw new Error("db down"); } }, siteHost: "mysite.com", result }), false);
});
