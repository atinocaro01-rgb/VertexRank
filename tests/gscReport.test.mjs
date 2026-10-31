import test from "node:test";
import assert from "node:assert/strict";
import { resolveRanges, buildReport, suggestProperty, ALLOWED_DAYS, DATA_LAG_DAYS, LIMITS } from "../lib/gscReport.js";

const NOW = Date.parse("2026-10-28T15:30:00Z");

test("ranges end three days ago; the previous period is the equal-length span just before; odd day counts fall back to 28", () => {
  assert.equal(DATA_LAG_DAYS, 3);
  const r = resolveRanges({ days: 28, nowMs: NOW });
  assert.deepEqual(r.current, { startDate: "2026-09-28", endDate: "2026-10-25" });
  assert.deepEqual(r.previous, { startDate: "2026-08-31", endDate: "2026-09-27" });
  assert.deepEqual(resolveRanges({ days: 7, nowMs: NOW }).current, { startDate: "2026-10-19", endDate: "2026-10-25" });
  for (const bad of [0, 5, 30, "abc", null, undefined, 9999]) assert.equal(resolveRanges({ days: bad, nowMs: NOW }).days, 28);
  for (const d of ALLOWED_DAYS) { const x = resolveRanges({ days: d, nowMs: NOW }); const span = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000 + 1; assert.equal(span(x.current.startDate, x.current.endDate), d); assert.equal(span(x.previous.startDate, x.previous.endDate), d); }
  // a 180-day report still reaches back less than the ~16 months Search Console keeps
  assert.ok((NOW - Date.parse(resolveRanges({ days: 180, nowMs: NOW }).previous.startDate)) / 86400000 < 480);
});

function fakeClient(rowsFor) {
  const calls = [];
  return { calls, query: async (site, params) => { calls.push({ site, ...params }); return rowsFor(params) ?? []; } };
}
const row = (keys, clicks, impressions, ctr, position) => ({ keys, clicks, impressions, ctr, position });

test("buildReport shapes every section, rounds numbers, sorts the daily series and records provenance", async () => {
  const client = fakeClient(({ dimensions, startDate }) => {
    const prev = startDate < "2026-09-28";
    const d = dimensions.join(",");
    if (d === "") return [row([], prev ? 50 : 80, prev ? 1000 : 1600, 0.0500123, 12.3456)];
    if (d === "date") return [row(["2026-10-02"], 3, 60, 0.05, 9.04), row(["2026-10-01"], 2, 40, 0.05, 9.5)];
    if (d === "query") return [row(["red shoes"], 10, 200, 0.05, 4.44)];
    if (d === "page") return [row([prev ? "https://a.com/old" : "https://a.com/a"], 10, 200, 0.05, 4.44)];
    if (d === "query,page") return [row(["red shoes", "https://a.com/a"], 10, 200, 0.05, 4.44)];
    if (d === "device") return [row(["MOBILE"], 60, 1000, 0.06, 8)];
    if (d === "country") return [row(["ken"], 70, 1200, 0.058, 7)];
  });
  const r = await buildReport({ client, siteUrl: "sc-domain:a.com", days: 28, nowMs: NOW });
  assert.equal(r.source, "Google Search Console"); assert.equal(r.property, "sc-domain:a.com"); assert.equal(r.fetchedAt, "2026-10-28T15:30:00.000Z");
  assert.deepEqual(r.range, { startDate: "2026-09-28", endDate: "2026-10-25" }); assert.equal(r.days, 28);
  assert.deepEqual(r.totals, { clicks: 80, impressions: 1600, ctr: 0.05, position: 12.3 }); assert.deepEqual(r.previousTotals, { clicks: 50, impressions: 1000, ctr: 0.05, position: 12.3 });
  assert.deepEqual(r.daily.map((x) => x.date), ["2026-10-01", "2026-10-02"]); assert.equal(r.daily[1].position, 9);
  assert.deepEqual(r.queries[0], { query: "red shoes", clicks: 10, impressions: 200, ctr: 0.05, position: 4.4 });
  assert.equal(r.pages[0].page, "https://a.com/a"); assert.equal(r.previousPages[0].page, "https://a.com/old");
  assert.deepEqual(r.queryPages[0], { query: "red shoes", page: "https://a.com/a", clicks: 10, impressions: 200, ctr: 0.05, position: 4.4 });
  assert.equal(r.devices[0].device, "MOBILE"); assert.equal(r.countries[0].country, "ken");
  assert.equal(r.limitations.length, 4); assert.ok(r.limitations.some((l) => /average position over the period, not a live ranking/.test(l)));
  assert.equal(client.calls.length, 9); assert.ok(client.calls.every((c) => c.site === "sc-domain:a.com"));
});

test("a property with no data gives zeros and empty lists, never NaN or errors", async () => {
  const r = await buildReport({ client: fakeClient(() => []), siteUrl: "sc-domain:a.com", nowMs: NOW });
  assert.deepEqual(r.totals, { clicks: 0, impressions: 0, ctr: 0, position: 0 });
  for (const k of ["daily", "queries", "pages", "previousPages", "queryPages", "devices", "countries"]) assert.deepEqual(r[k], [], k);
  assert.deepEqual(r.truncated, { queries: false, pages: false, queryPages: false });
});

test("truncation is reported when Google returned as many rows as we asked for", async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => row([`q${i}`, `https://a.com/${i}`], 1, 1, 1, 1));
  const r = await buildReport({ client: fakeClient(({ dimensions }) => (dimensions.length === 2 ? many(LIMITS.queryPages) : dimensions[0] === "query" ? many(LIMITS.queries) : dimensions[0] === "page" ? many(10) : [])), siteUrl: "sc-domain:a.com", nowMs: NOW });
  assert.deepEqual(r.truncated, { queries: true, pages: false, queryPages: true });
});

test("a failing request fails the whole report with the original error (no half-reports)", async () => {
  const bad = fakeClient(({ dimensions }) => { if (dimensions[0] === "page") throw Object.assign(new Error("quota"), { code: "RATE_LIMIT" }); return []; });
  await assert.rejects(buildReport({ client: bad, siteUrl: "sc-domain:a.com", nowMs: NOW }), { code: "RATE_LIMIT" });
});

test("requests run with limited concurrency", async () => {
  let active = 0, peak = 0;
  const client = { query: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active--; return []; } };
  await buildReport({ client, siteUrl: "sc-domain:a.com", nowMs: NOW });
  assert.ok(peak <= 4 && peak >= 2, `peak concurrency ${peak}`);
});

test("suggestProperty prefers an exact URL-prefix property, then the exact domain property, then a parent domain", () => {
  const props = (...ids) => ids.map((siteUrl) => ({ siteUrl, permissionLevel: "siteFullUser" }));
  assert.equal(suggestProperty(props("sc-domain:example.com", "https://example.com/"), "example.com"), "https://example.com/");
  assert.equal(suggestProperty(props("sc-domain:example.com", "https://other.com/"), "https://www.example.com/page"), "sc-domain:example.com");
  assert.equal(suggestProperty(props("sc-domain:example.com"), "blog.example.com"), "sc-domain:example.com");
  assert.equal(suggestProperty(props("sc-domain:example.com", "sc-domain:blog.example.com"), "blog.example.com"), "sc-domain:blog.example.com");
  assert.equal(suggestProperty(props("https://www.example.com/"), "example.com"), "https://www.example.com/");
  assert.equal(suggestProperty(props("sc-domain:notexample.com", "sc-domain:example.org"), "example.com"), null, "similar-looking domains don't match");
  for (const bad of [null, undefined, [], "x"]) assert.equal(suggestProperty(bad, "example.com"), null);
  assert.equal(suggestProperty(props("sc-domain:example.com"), "http://[bad"), null);
});
