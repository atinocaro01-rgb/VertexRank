import test from "node:test";
import assert from "node:assert/strict";
import { searchOpportunities, ctrModel, pageKey } from "../lib/gscAnalysis.js";

const A = "https://a.com";
const m = (clicks, impressions, position) => ({ clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
const report = (o = {}) => ({
  days: 28, range: { startDate: "2026-09-28", endDate: "2026-10-25" }, previousRange: { startDate: "2026-08-31", endDate: "2026-09-27" },
  totals: { clicks: 500, impressions: 10000, ctr: 0.05, position: 8 }, previousTotals: { clicks: 500, impressions: 10000, ctr: 0.05, position: 8 },
  queries: [], pages: [], previousPages: [], queryPages: [], truncated: { queries: false, pages: false, queryPages: false }, ...o,
});
const byPrefix = (opps, p) => opps.filter((o) => o.id.startsWith(p));
// seven queries at ~position 4 converting at 7% -> the site's own typical CTR there
const ownQueries = Array.from({ length: 7 }, (_, i) => ({ query: `own ${i}`, ...m(7, 100, 4) }));

test("invalid or empty reports produce nothing", () => {
  assert.deepEqual(searchOpportunities(null), []); assert.deepEqual(searchOpportunities({}), []); assert.deepEqual(searchOpportunities(report()), []);
});

test("pageKey ignores protocol, www, hash and trailing slash", () => {
  assert.equal(pageKey("https://www.a.com/x/#top"), pageKey("http://a.com/x")); assert.notEqual(pageKey("https://a.com/x?p=1"), pageKey("https://a.com/x")); assert.equal(pageKey("https://a.com"), pageKey("https://a.com/"));
});

test("ctrModel uses the site's own median at a position, and a labelled generic fallback otherwise", () => {
  const own = ctrModel(report({ queries: ownQueries }))(4.2);
  assert.ok(Math.abs(own.ctr - 0.07) < 1e-9); assert.match(own.basis, /your own queries/);
  const generic = ctrModel(report())(4.2); assert.equal(generic.ctr, 0.07); assert.match(generic.basis, /generic benchmark/);
  assert.equal(ctrModel(report({ queries: ownQueries.slice(0, 3) }))(4).basis.includes("generic"), true); // fewer than 5 own queries
});

test("low CTR: flags pages that rank but aren't clicked, with an estimate based on the site's own data and a PR hook", () => {
  const r = report({
    queries: ownQueries,
    pages: [{ page: `${A}/shoes`, ...m(20, 2000, 4.2) }, { page: `${A}/fine`, ...m(150, 2000, 4.1) }, { page: `${A}/deep`, ...m(1, 3000, 35) }, { page: `${A}/small`, ...m(0, 40, 3) }],
    queryPages: [{ query: "red shoes", page: `${A}/shoes`, ...m(10, 900, 4) }, { query: "buy shoes", page: `${A}/shoes`, ...m(5, 500, 4.5) }, { query: "x", page: `${A}/other`, ...m(1, 9, 4) }],
  });
  const lows = byPrefix(searchOpportunities(r), "gsc:lowctr");
  assert.equal(lows.length, 1); const o = lows[0];
  assert.equal(o.id, "gsc:lowctr:a-com-shoes"); assert.equal(o.priority, "High"); assert.equal(o.type, "search"); assert.equal(o.actionType, "Meta Fix"); assert.equal(o.confidence, "Medium");
  assert.match(o.title, /Low click-through rate on \/shoes \(1\.0% at position 4\.2\)/); assert.match(o.evidence, /2,000 impressions and 20 clicks/); assert.match(o.evidence, /Typical CTR at this position is 7\.0%, based on your own queries/);
  assert.match(o.evidence, /roughly 120 more clicks per 28 days \(estimate\)/); assert.match(o.evidence, /Top queries: red shoes, buy shoes/);
  assert.deepEqual(o.urls, [`${A}/shoes`]); assert.equal(o.breadth, 6); assert.match(o.bonusLabel, /120 extra clicks per 28 days \(estimate\)/);
  assert.deepEqual(o.prIssue.queries, ["red shoes", "buy shoes"]); assert.equal(o.prIssue.id, "gsc_lowctr"); assert.deepEqual(o.prIssue.urls, [`${A}/shoes`]);
});

test("thresholds scale with the report length", () => {
  const pages = [{ page: `${A}/p`, ...m(2, 200, 4) }];
  assert.equal(byPrefix(searchOpportunities(report({ days: 28, pages })), "gsc:lowctr").length, 1);
  assert.equal(byPrefix(searchOpportunities(report({ days: 90, pages })), "gsc:lowctr").length, 0, "200 impressions isn't meaningful over 90 days");
  assert.equal(byPrefix(searchOpportunities(report({ days: 90, pages: [{ page: `${A}/p`, ...m(8, 800, 4) }] })), "gsc:lowctr").length, 1);
});

test("striking distance: page-2 queries with real demand, ranked by estimated gain, with the page that ranks", () => {
  const r = report({
    queries: [{ query: "big opportunity", ...m(15, 3000, 12.4) }, { query: "small one", ...m(2, 400, 14) }, { query: "already good", ...m(300, 3000, 3) }, { query: "too deep", ...m(0, 5000, 31) }, { query: "no demand", ...m(0, 20, 11) }],
    queryPages: [{ query: "big opportunity", page: `${A}/guide`, ...m(10, 2000, 12) }, { query: "big opportunity", page: `${A}/blog`, ...m(5, 1000, 13) }],
  });
  const s = byPrefix(searchOpportunities(r), "gsc:strike");
  assert.deepEqual(s.map((o) => o.id), ["gsc:strike:big-opportunity", "gsc:strike:small-one"]);
  assert.equal(s[0].priority, "High"); assert.match(s[0].title, /"big opportunity" is stuck at position 12\.4/); assert.match(s[0].evidence, /mostly on \/guide/); assert.match(s[0].evidence, /\(estimate\)/); assert.deepEqual(s[0].urls, [`${A}/guide`]);
  assert.equal(s[1].urls.length, 0); // no query+page row for it -> no page named, nothing invented
});

test("cannibalisation: pages that share a query; URL variants and trivial rows don't count; repeated pairs are grouped", () => {
  const r = report({ queryPages: [
    { query: "red shoes", page: `${A}/a`, ...m(20, 300, 6) }, { query: "red shoes", page: `${A}/b`, ...m(8, 200, 9) }, { query: "red shoes", page: `${A}/c`, ...m(0, 5, 20) },
    { query: "buy red shoes", page: `${A}/a`, ...m(5, 100, 7) }, { query: "buy red shoes", page: `${A}/b`, ...m(4, 90, 8) },
    { query: "variants", page: `${A}/x`, ...m(5, 300, 5) }, { query: "variants", page: `${A}/x/`, ...m(5, 300, 5) }, { query: "variants", page: `http://www.a.com/x#top`, ...m(1, 100, 5) },
    { query: "dominated", page: `${A}/p`, ...m(50, 900, 2) }, { query: "dominated", page: `${A}/q`, ...m(0, 40, 15) },
  ] });
  const c = byPrefix(searchOpportunities(r), "gsc:cannibal");
  assert.equal(c.length, 1, "one opportunity for the /a + /b pair covering both queries");
  assert.match(c[0].title, /2 of your pages compete for 2 queries \(e\.g\. "red shoes"\)/); assert.deepEqual(c[0].urls.sort(), [`${A}/a`, `${A}/b`]);
  assert.match(c[0].evidence, /\/a \(300 impressions, position 6\.0\); \/b \(200 impressions, position 9\.0\)/); assert.equal(c[0].priority, "High"); // 695 impressions across both queries crosses the High threshold (500 per 28 days)
});

test("declining pages: needs a real previous volume, a 30%+ drop, and handles pages that vanished", () => {
  const r = report({
    previousPages: [{ page: `${A}/x`, ...m(100, 2000, 3) }, { page: `${A}/y`, ...m(100, 2000, 3) }, { page: `${A}/gone`, ...m(30, 800, 5) }, { page: `${A}/tiny`, ...m(10, 100, 5) }],
    pages: [{ page: `${A}/x`, ...m(40, 1500, 5.5) }, { page: `${A}/y`, ...m(80, 1900, 3.4) }, { page: `${A}/tiny`, ...m(0, 50, 9) }],
  });
  const d = byPrefix(searchOpportunities(r), "gsc:decline");
  assert.deepEqual(d.map((o) => o.id).sort(), ["gsc:decline:a-com-gone", "gsc:decline:a-com-x"]);
  const x = d.find((o) => o.id.endsWith("x"));
  assert.equal(x.priority, "High"); assert.equal(x.confidence, "High"); assert.match(x.title, /\/x lost 60% of its clicks \(100 → 40\)/); assert.match(x.evidence, /average position 3\.0 → 5\.5/); assert.match(x.evidence, /Seasonal demand/);
  assert.match(d.find((o) => o.id.endsWith("gone")).evidence, /no longer appears/);
  assert.equal(byPrefix(searchOpportunities({ ...r, truncated: { queries: false, pages: true, queryPages: false } }), "gsc:decline").length, 1, "absent pages aren't claimed lost when the list was truncated");
});

test("site-wide trend", () => {
  const down = (c, p) => report({ totals: { clicks: c, impressions: 9000, ctr: 0.05, position: 8 }, previousTotals: { clicks: p, impressions: 10000, ctr: 0.05, position: 8 } });
  const t30 = byPrefix(searchOpportunities(down(700, 1000)), "gsc:trend")[0]; assert.equal(t30.priority, "Medium"); assert.match(t30.title, /down 30%/);
  assert.equal(byPrefix(searchOpportunities(down(500, 1000)), "gsc:trend")[0].priority, "High");
  assert.equal(byPrefix(searchOpportunities(down(900, 1000)), "gsc:trend").length, 0); assert.equal(byPrefix(searchOpportunities(down(40, 80)), "gsc:trend").length, 0, "tiny volumes aren't a trend");
});

test("pages with no impressions: needs a crawl, skips noindex, ignores URL variants, and is silent when the page list was truncated", () => {
  const crawl = { pages: [{ url: `${A}/seen` }, { url: `${A}/lonely` }, { url: `${A}/hidden`, noindex: true }, { url: `${A}/broken`, statusCode: 404 }, { url: `${A}/variant/` }] };
  const r = report({ pages: [{ page: `${A}/seen`, ...m(5, 50, 8) }, { page: "http://www.a.com/variant", ...m(1, 10, 20) }] });
  const n = byPrefix(searchOpportunities(r, crawl), "gsc:noimpr");
  assert.equal(n.length, 1); assert.deepEqual(n[0].urls, [`${A}/lonely`]); assert.match(n[0].title, /1 crawled page got no search impressions in 28 days/); assert.equal(n[0].confidence, "Medium"); assert.match(n[0].recommendedAction, /URL Inspection/);
  assert.equal(byPrefix(searchOpportunities({ ...r, truncated: { queries: false, pages: true, queryPages: false } }, crawl), "gsc:noimpr").length, 0);
  assert.equal(byPrefix(searchOpportunities(r, null), "gsc:noimpr").length, 0); assert.equal(byPrefix(searchOpportunities(report({ pages: [] }), crawl), "gsc:noimpr").length, 0, "no data at all isn't evidence about individual pages");
});

test("every opportunity has the fields the queue needs, unique ids, and honest labelling of estimates", () => {
  const r = report({ queries: [...ownQueries, { query: "q1", ...m(15, 3000, 12.4) }], pages: [{ page: `${A}/shoes`, ...m(20, 2000, 4.2) }], previousPages: [{ page: `${A}/shoes`, ...m(100, 2000, 3) }],
    queryPages: [{ query: "q1", page: `${A}/shoes`, ...m(10, 2000, 12) }], totals: { clicks: 20, impressions: 2000, ctr: 0.01, position: 4 }, previousTotals: { clicks: 100, impressions: 2000, ctr: 0.05, position: 3 } });
  const all = searchOpportunities(r);
  assert.ok(all.length >= 4); assert.equal(new Set(all.map((o) => o.id)).size, all.length);
  for (const o of all) {
    assert.equal(o.type, "search"); assert.equal(o.module, "Search Console"); assert.equal(o.source, "Google Search Console");
    assert.ok(o.title && o.evidence && o.recommendedAction && ["High", "Medium", "Low"].includes(o.priority) && ["High", "Medium", "Low"].includes(o.confidence) && Array.isArray(o.urls) && o.breadth >= 0 && o.breadth <= 10);
    if (/more clicks/.test(o.evidence)) assert.match(o.evidence, /\(estimate\)/, "extra-click numbers are always labelled as estimates");
  }
});

test("a domain property includes other subdomains: only the website's own host is analysed", () => {
  const r = report({
    property: "sc-domain:a.com", queries: ownQueries,
    pages: [{ page: `${A}/shoes`, ...m(20, 2000, 4.2) }, { page: "https://blog.a.com/post", ...m(20, 2000, 4.2) }],
    queryPages: [{ query: "q", page: `${A}/shoes`, ...m(10, 900, 4) }],
  });
  const urls = (opts) => byPrefix(searchOpportunities(r, null, opts), "gsc:lowctr").flatMap((o) => o.urls);
  assert.deepEqual(urls({ host: "www.a.com" }), [`${A}/shoes`]);
  assert.deepEqual(urls({ host: "blog.a.com" }), ["https://blog.a.com/post"]);
  assert.equal(urls({}).length, 2, "no host given -> nothing filtered");
  const prefix = { ...r, property: "https://a.com/" };
  assert.equal(byPrefix(searchOpportunities(prefix, null, { host: "other.com" }), "gsc:lowctr").length, 2, "URL-prefix properties are already scoped by Google");
});
