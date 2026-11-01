import test from "node:test";
import assert from "node:assert/strict";
import { slimCheck, upsertCheck, checkId, competitorProspects, serpOpportunities, isGenericHost, MAX_CHECKS } from "../lib/serpInsights.js";
import { buildOpportunityQueue } from "../lib/opportunityQueue.js";
import { normalizeWorkspace } from "../lib/workspaceBackup.js";

const NOW = Date.parse("2026-11-05T10:00:00Z");
const resp = (o = {}) => ({
  query: "kenya safari", country: "Kenya", device: "desktop", source: "SerpApi (Google)", observedAt: "2026-11-04T09:00:00.000Z",
  results: [
    { rank: 1, title: "Top Safaris", url: "https://www.topsafaris.com/a", snippet: "long snippet" },
    { rank: 2, title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Safari" },
    { rank: 3, title: "Other", url: "https://other.co.ke/b" },
    { rank: 4, title: "Mine", url: "https://mysite.com/safari" },
  ], ...o,
});
const SITE = "mysite.com";

test("slimCheck keeps what matters, drops snippets, normalizes, and rejects unusable responses", () => {
  const s = slimCheck(resp());
  assert.equal(s.id, "serp:kenya-safari:kenya:desktop"); assert.equal(s.results.length, 4); assert.ok(!("snippet" in s.results[0]));
  assert.equal(slimCheck(resp({ country: "Narnia" })).country, "Worldwide");
  for (const bad of [null, {}, resp({ query: "" }), resp({ results: null }), resp({ observedAt: "nope" })]) assert.equal(slimCheck(bad), null);
  assert.deepEqual(slimCheck(resp({ results: [{ rank: 0, url: "https://a.com" }, { rank: 2, url: "" }, { rank: 3, url: "https://b.com", title: "t" }] })).results.map((r) => r.rank), [3]);
});

test("upsertCheck replaces the same query/country/device, keeps newest first, and is bounded", () => {
  const a = slimCheck(resp()); const b = slimCheck(resp({ query: "other" }));
  let list = upsertCheck([], a); list = upsertCheck(list, b); assert.deepEqual(list.map((c) => c.query), ["other", "kenya safari"]);
  const again = upsertCheck(list, slimCheck(resp({ observedAt: "2026-11-05T00:00:00.000Z" }))); assert.equal(again.length, 2); assert.equal(again[0].query, "kenya safari");
  assert.equal(upsertCheck(list, null), list);
  let many = []; for (let i = 0; i < MAX_CHECKS + 10; i++) many = upsertCheck(many, slimCheck(resp({ query: `q${i}` }))); assert.equal(many.length, MAX_CHECKS);
  assert.equal(checkId("A  B", "Kenya", "mobile"), "serp:a-b:kenya:mobile");
});

test("competitorProspects: excludes own site, big platforms and tracked competitors; ranks by appearances then position", () => {
  const checks = [slimCheck(resp()), slimCheck(resp({ query: "safari tours", results: [{ rank: 1, title: "x", url: "https://other.co.ke/z" }, { rank: 2, title: "y", url: "https://topsafaris.com/" }, { rank: 3, title: "m", url: "https://blog.mysite.com/" }] }))];
  const p = competitorProspects(checks, { site: SITE });
  assert.deepEqual(p.map((x) => x.host), ["other.co.ke", "topsafaris.com"]); // 2 appearances each; other.co.ke's best rank (1) beats topsafaris' (1)? tie -> host order
  assert.equal(p[0].appearances, 2); assert.equal(p[0].bestRank, 1); assert.ok(!p.some((x) => /wikipedia|mysite/.test(x.host)));
  assert.deepEqual(competitorProspects(checks, { site: SITE, tracked: [{ url: "https://www.other.co.ke" }] }).map((x) => x.host), ["topsafaris.com"]);
  assert.equal(isGenericHost("en.wikipedia.org"), true); assert.equal(isGenericHost("wikipedia.org.evil.io"), false);
  assert.deepEqual(competitorProspects(null, { site: SITE }), []);
});

test("serpOpportunities: ranks 4-10 become 'room to climb', top 3 produce nothing, evidence is observed and cites who is ahead", () => {
  const o = serpOpportunities([slimCheck(resp())], { site: SITE, nowMs: NOW });
  assert.equal(o.length, 1); assert.equal(o[0].type, "search"); assert.equal(o[0].id, "serp:kenya-safari:kenya:desktop"); assert.equal(o[0].confidence, "Medium"); assert.equal(o[0].priority, "Medium");
  assert.match(o[0].title, /ranks #4/); assert.match(o[0].evidence, /Observed/); assert.match(o[0].evidence, /#1 topsafaris\.com — Top Safaris/); assert.deepEqual(o[0].urls, ["https://mysite.com/safari"]);
  const top = resp({ results: [{ rank: 2, title: "Mine", url: "https://mysite.com/" }] });
  assert.deepEqual(serpOpportunities([slimCheck(top)], { site: SITE, nowMs: NOW }), []);
});

test("serpOpportunities: not ranking -> opportunity; demand (Search Console or tracked keyword) raises priority; crawl decides strengthen vs create", () => {
  const miss = slimCheck(resp({ results: [{ rank: 1, title: "A", url: "https://a.com/" }, { rank: 2, title: "B", url: "https://b.com/" }] }));
  let o = serpOpportunities([miss], { site: SITE, nowMs: NOW })[0];
  assert.match(o.title, /Not in the top 2/); assert.equal(o.priority, "Medium"); assert.match(o.evidence, /No crawled page has every word/); assert.match(o.recommendedAction, /^Create or retarget/); assert.deepEqual(o.urls, []);
  o = serpOpportunities([miss], { site: SITE, nowMs: NOW, keywords: [{ keyword: "Kenya Safari" }] })[0]; assert.equal(o.priority, "High");
  o = serpOpportunities([miss], { site: SITE, nowMs: NOW, gscReport: { queries: [{ query: "kenya safari", impressions: 400, position: 14.2 }] } })[0]; assert.equal(o.priority, "High"); assert.match(o.evidence, /400 impressions at average position 14\.2/);
  const crawl = { pages: [{ url: "https://mysite.com/tours", title: "Kenya Safari Tours", h1Text: "Book" }] };
  o = serpOpportunities([miss], { site: SITE, nowMs: NOW, crawl })[0]; assert.match(o.recommendedAction, /^Strengthen \/tours/); assert.deepEqual(o.urls, ["https://mysite.com/tours"]);
});

test("serpOpportunities: stale checks are demoted and annotated; empty results, missing site and hostile data never throw", () => {
  const old = slimCheck(resp({ observedAt: "2026-10-01T00:00:00.000Z" }));
  const o = serpOpportunities([old], { site: SITE, nowMs: NOW })[0]; assert.equal(o.confidence, "Low"); assert.match(o.note, /checked 35 days ago/);
  assert.deepEqual(serpOpportunities([slimCheck(resp({ results: [] }))], { site: SITE, nowMs: NOW }), []);
  assert.deepEqual(serpOpportunities([slimCheck(resp())], { nowMs: NOW }), []);
  for (const bad of [null, undefined, [null, 5, {}, { query: "x", results: "no" }, { query: "x", results: [null, 3] }]]) assert.doesNotThrow(() => serpOpportunities(bad, { site: SITE, nowMs: NOW }));
});

test("the queue includes live-search opportunities, demotes ones from another market, and maps them like every other source", () => {
  const crawl = { crawlId: "c1", domain: "mysite.com", startUrl: "https://mysite.com/", pages: [{ url: "https://mysite.com/", htmlLang: "en", hreflangs: [], telLinks: [], schemaSignals: {} }], siteWide: { orphanPages: [], weakLinkedPages: [], duplicateTitles: [], duplicateMetaDescriptions: [], nearDuplicateContentPairs: [], recurringIssues: [] } };
  const b = { siteCrawl: crawl, actions: [], competitors: [], contentIdeas: [], internalLinks: [], serpChecks: [slimCheck(resp())] };
  const q = buildOpportunityQueue(b, { country: "Kenya", nowMs: NOW }).filter((o) => o.id.startsWith("serp:"));
  assert.equal(q.length, 1); assert.equal(q[0].state, "new"); assert.equal(q[0].module, "Live search results"); assert.ok(q[0].score > 0);
  const other = buildOpportunityQueue(b, { country: "Uganda", nowMs: NOW }).find((o) => o.id.startsWith("serp:")); assert.equal(other.confidence, "Low"); assert.ok(other.marketMismatch);
  const added = buildOpportunityQueue({ ...b, actions: [{ id: "a1", status: "Approved", detail: { sourceId: q[0].id } }] }, { country: "Kenya", nowMs: NOW }).find((o) => o.id === q[0].id); assert.equal(added.state, "in_actions");
  assert.doesNotThrow(() => buildOpportunityQueue({ ...b, serpChecks: "garbage" }, { country: "Kenya" }));
});

test("workspaces saved before live checks existed load with an empty list; a malformed value is reset", () => {
  const emptyBundle = () => ({ scores: {}, serpChecks: [] });
  const ws = (b) => normalizeWorkspace({ websites: [{ id: "w1", url: "a.com" }], bundles: { w1: b } }, { emptyBundle });
  assert.deepEqual(ws({}).bundles.w1.serpChecks, []); assert.deepEqual(ws({ serpChecks: "x" }).bundles.w1.serpChecks, []); assert.equal(ws({ serpChecks: [{ id: "k" }] }).bundles.w1.serpChecks.length, 1);
});
