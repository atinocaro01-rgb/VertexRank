import test from "node:test";
import assert from "node:assert/strict";
import {
  createTracker, resetDerived, migrateLegacyBundle, stampResult, isStaleForCrawl,
  normalizeSiteKey, discardMessage, DERIVED_ANALYSIS_FIELDS,
} from "../lib/crawlState.js";

const mkBundle = (crawlId, extra = {}) => ({
  scores: { overall: 80, aeo: 70, geo: 60, technical: 90, keyword: 50, content: 85 },
  siteCrawl: crawlId ? { crawlId, crawledAt: "2026-10-24T10:00:00Z", domain: "a.com" } : null,
  siteKeywordClusters: { x: 1 }, siteAeoAnalysis: { x: 1 }, siteGeoAnalysis: { x: 1 },
  internalLinkRecs: { x: 1 }, siteInsights: { x: 1 }, aiVisibility: { x: 1 },
  keywords: [{ keyword: "kw" }], actions: [{ id: "a1" }], contentIdeas: [{ id: "c1" }], competitorSuggestions: [{ name: "s" }],
  geoFactors: { f: 1 }, competitors: [{ id: "c", name: "Rival", url: "rival.com", siteAnalysis: { crawlId: "old" }, backlinkOpportunities: { y: 1 } }],
  ...extra,
});

function world(initial) {
  const state = { bundles: initial };
  return { state, tracker: createTracker(() => state.bundles) };
}

test("analysis is applicable when nothing changed", () => {
  const { tracker } = world({ s1: mkBundle("crawl-1") });
  const t = tracker.beginAnalysis("s1", "siteAeoAnalysis");
  assert.equal(t.crawlId, "crawl-1");
  assert.equal(tracker.checkAnalysis(t), "ok");
});

test("RACE: a re-crawl finishes while an analysis request is in flight -> its result is discarded", () => {
  const { state, tracker } = world({ s1: mkBundle("crawl-1") });
  const ticket = tracker.beginAnalysis("s1", "siteGeoAnalysis"); // request sent against crawl-1
  state.bundles = { s1: mkBundle("crawl-2") }; // re-crawl lands
  assert.equal(tracker.checkAnalysis(ticket), "recrawled");
  assert.ok(discardMessage("recrawled"));
});

test("RACE: out-of-order runs — the older request cannot overwrite the newer one", () => {
  const { tracker } = world({ s1: mkBundle("crawl-1") });
  const first = tracker.beginAnalysis("s1", "siteAeoAnalysis");
  const second = tracker.beginAnalysis("s1", "siteAeoAnalysis");
  assert.equal(tracker.checkAnalysis(second), "ok"); // newer lands first
  assert.equal(tracker.checkAnalysis(first), "superseded"); // older lands later -> dropped
  assert.equal(discardMessage("superseded"), null);
});

test("different analyses and different sites don't supersede each other", () => {
  const { tracker } = world({ s1: mkBundle("c1"), s2: mkBundle("c2") });
  const a = tracker.beginAnalysis("s1", "siteAeoAnalysis");
  const b = tracker.beginAnalysis("s1", "siteGeoAnalysis");
  const c = tracker.beginAnalysis("s2", "siteAeoAnalysis");
  for (const t of [a, b, c]) assert.equal(tracker.checkAnalysis(t), "ok");
});

test("a ticket taken with an explicit crawlId (crawl just stored) works before state catches up", () => {
  const { state, tracker } = world({ s1: mkBundle("old") });
  const t = tracker.beginAnalysis("s1", "siteAeoAnalysis", "new"); // crawl "new" is about to be stored
  assert.equal(tracker.checkAnalysis(t), "recrawled"); // not yet stored -> not applicable
  state.bundles = { s1: mkBundle("new") };
  assert.equal(tracker.checkAnalysis(t), "ok");
});

test("deleted website: late results are 'gone' (no ghost bundle)", () => {
  const { state, tracker } = world({ s1: mkBundle("c1") });
  const crawlRun = tracker.beginCrawl("s1");
  const ticket = tracker.beginAnalysis("s1", "siteAeoAnalysis");
  state.bundles = {};
  assert.equal(tracker.crawlStatus(crawlRun), "gone");
  assert.equal(tracker.checkAnalysis(ticket), "gone");
});

test("URL edited while a crawl is in flight: the old crawl is superseded", () => {
  const { tracker } = world({ s1: mkBundle("c1") });
  const oldRun = tracker.beginCrawl("s1");
  tracker.invalidate("s1"); // URL edit
  const newRun = tracker.beginCrawl("s1");
  assert.equal(tracker.crawlStatus(oldRun), "superseded");
  assert.equal(tracker.crawlStatus(newRun), "ok");
});

test("URL edited while an analysis is in flight: it is discarded once the crawl is cleared", () => {
  const { state, tracker } = world({ s1: mkBundle("c1") });
  const ticket = tracker.beginAnalysis("s1", "siteKeywordClusters");
  state.bundles = { s1: resetDerived(state.bundles.s1, { newSite: true }) }; // siteCrawl -> null
  assert.equal(tracker.checkAnalysis(ticket), "recrawled");
});

test("supersede() invalidates in-flight analyses for one field only", () => {
  const { tracker } = world({ s1: mkBundle("c1") });
  const a = tracker.beginAnalysis("s1", "aiVisibility");
  const b = tracker.beginAnalysis("s1", "siteAeoAnalysis");
  tracker.supersede("s1", "aiVisibility");
  assert.equal(tracker.checkAnalysis(a), "superseded");
  assert.equal(tracker.checkAnalysis(b), "ok");
});

test("resetDerived (re-crawl) clears every derived analysis and the module scores, keeps the user's data", () => {
  const out = resetDerived(mkBundle("c1"));
  for (const f of DERIVED_ANALYSIS_FIELDS) assert.equal(out[f], null, f);
  assert.deepEqual([out.scores.aeo, out.scores.geo, out.scores.keyword], [null, null, null]);
  assert.equal(out.scores.technical, 90);
  assert.equal(out.keywords.length, 1); assert.equal(out.actions.length, 1); assert.equal(out.contentIdeas.length, 1);
  assert.equal(out.competitors[0].siteAnalysis.crawlId, "old"); // kept on re-crawl, flagged stale in the UI instead
  assert.equal(out.siteCrawl.crawlId, "c1");
});

test("resetDerived (new site) also drops the crawl and old-site-specific data, keeps user-curated data", () => {
  const out = resetDerived(mkBundle("c1"), { newSite: true });
  assert.equal(out.siteCrawl, null);
  assert.deepEqual(out.competitorSuggestions, []); assert.deepEqual(out.geoFactors, {});
  assert.ok(Object.values(out.scores).every((v) => v === null));
  assert.equal(out.competitors[0].siteAnalysis, null);
  assert.equal(out.competitors[0].name, "Rival"); assert.ok(out.competitors[0].backlinkOpportunities);
  assert.equal(out.keywords.length, 1); assert.equal(out.actions.length, 1);
});

test("legacy data without crawlId is migrated and NOT flagged stale", () => {
  const legacy = mkBundle(null, { siteCrawl: { crawledAt: "2026-01-01T00:00:00Z", domain: "a.com" } });
  const out = migrateLegacyBundle(legacy);
  const id = out.siteCrawl.crawlId;
  assert.match(id, /^legacy-/);
  for (const f of DERIVED_ANALYSIS_FIELDS) assert.equal(out[f].crawlId, id, f);
  assert.equal(isStaleForCrawl(out.siteAeoAnalysis, out.siteCrawl), false);
  assert.equal(migrateLegacyBundle(out), out); // idempotent
  assert.equal(migrateLegacyBundle(mkBundle(null)).siteCrawl, null); // no crawl -> untouched
});

test("isStaleForCrawl / stampResult / normalizeSiteKey", () => {
  assert.equal(isStaleForCrawl({ crawlId: "a" }, { crawlId: "b" }), true);
  assert.equal(isStaleForCrawl({ crawlId: "a" }, { crawlId: "a" }), false);
  assert.equal(isStaleForCrawl({}, { crawlId: "a" }), false);
  assert.deepEqual(stampResult({ score: 5 }, "c1"), { score: 5, crawlId: "c1" });
  assert.equal(stampResult(null, "c1"), null);
  assert.equal(normalizeSiteKey("HTTPS://Example.com/"), "example.com");
  assert.notEqual(normalizeSiteKey("example.com"), normalizeSiteKey("www.example.com"));
  assert.equal(normalizeSiteKey("example.com/blog/"), "example.com/blog");
});
