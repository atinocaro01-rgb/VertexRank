import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOpportunityQueue, filterQueue, summarizeQueue, scoreOf, issueOpportunityId, issueLegacyIds, findAction, isOpportunityAdded, opportunityIds,
} from "../lib/opportunityQueue.js";

const A = "https://a.com";
const baseSiteWide = { orphanPages: [], weakLinkedPages: [], duplicateTitles: [], duplicateMetaDescriptions: [], nearDuplicateContentPairs: [], recurringIssues: [] };
const crawl = (o = {}) => ({
  crawlId: "c1", startUrl: `${A}/`, pages: [{ url: `${A}/`, htmlLang: "en", hreflangs: [], telLinks: [], schemaSignals: {} }],
  siteWide: { ...baseSiteWide, ...o },
});
const bundle = (o = {}) => ({ siteCrawl: null, actions: [], competitors: [], contentIdeas: [], internalLinks: [], ...o });
const byId = (q, id) => q.find((o) => o.id === id);

const techFinding = (o = {}) => ({ id: "tech_broken_links", category: "Technical", severity: "High", title: "2 broken internal links (404)", why: "w", fix: "Fix them", urls: [`${A}/x`, `${A}/y`], evidence: [], ...o });

test("empty / missing data yields an empty queue", () => {
  assert.deepEqual(buildOpportunityQueue(null), []);
  assert.deepEqual(buildOpportunityQueue(bundle()), []);
});

test("scoring is transparent: priority x confidence + capped breadth bonus", () => {
  assert.equal(scoreOf({ priority: "High", confidence: "High", breadth: 0 }).score, 75);
  assert.equal(scoreOf({ priority: "High", confidence: "Medium", breadth: 0 }).score, 64); // 75 * .85
  assert.equal(scoreOf({ priority: "Critical", confidence: "High", breadth: 4 }).score, 104);
  assert.equal(scoreOf({ priority: "Low", confidence: "Low", breadth: 500 }).score, Math.round(25 * 0.7 + 10)); // bonus capped at 10
  assert.match(scoreOf({ priority: "High", confidence: "High", breadth: 4 }).explanation, /High priority \(75\) × High confidence \(1\) \+ 4 for affecting 4 URLs/);
});

test("technical findings enter the queue with stable ids, high confidence and a breadth bonus", () => {
  const b = bundle({ siteCrawl: crawl({ technical: { findings: [techFinding()] } }) });
  const o = byId(buildOpportunityQueue(b, { country: "Worldwide" }), "tech:tech_broken_links");
  assert.equal(o.type, "technical"); assert.equal(o.priority, "High"); assert.equal(o.confidence, "High");
  assert.equal(o.score, 77); assert.equal(o.actionType, "Technical Fix"); assert.deepEqual(o.legacyIds, ["tech_broken_links"]);
  assert.equal(o.state, "new");
});

test("positional audit ids (rec_3, site_duptitle_0) are replaced by ids derived from content, so they survive re-crawls", () => {
  const rec = { id: "rec_3", category: "On-Page", title: "Missing meta description", urls: [`${A}/a`] };
  const rec2 = { ...rec, id: "rec_0" }; // same issue, different position next crawl
  assert.equal(issueOpportunityId(rec), issueOpportunityId(rec2));
  assert.deepEqual(issueLegacyIds(rec), []); // positional legacy ids are unreliable, never matched
  const dup = { id: "site_duptitle_0", category: "On-Page", title: "Duplicate title", urls: [`${A}/b`, `${A}/a`] };
  assert.equal(issueOpportunityId(dup), issueOpportunityId({ ...dup, id: "site_duptitle_5", urls: [`${A}/a`, `${A}/b`] }));
  assert.equal(issueOpportunityId({ id: "mkt_lang_mismatch" }), "mkt:mkt_lang_mismatch");
  assert.equal(issueOpportunityId({ id: "site_orphan" }), "tech:site_orphan");
});

test("keyword / AEO / GEO / simulator items use canonical ids and remember every legacy id", () => {
  const b = bundle({
    siteCrawl: crawl(),
    siteKeywordClusters: { opportunities: [{ id: "k1", problem: "Target 'x'", evidence: "e", recommendedAction: "r", priority: "High", confidence: "High", source: "s" }], cannibalizationGuidance: [{ id: "g1", recommendedAction: "Merge", explanation: "ex", reasoning: "re" }] },
    siteAeoAnalysis: {
      contentRecommendations: [{ id: "r1", recommendation: "Add an FAQ", why: "w", priority: "Medium" }],
      questions: [{ id: "q1", question: "How much?", coverage: "Missing", missingInfo: "m", recommendedAnswer: "a", priority: "High" }, { id: "q2", question: "Covered one", coverage: "Answered" }],
      weakestPages: [{ url: `${A}/p`, title: "P", score: 40, priority: "High", fixes: [{ label: "Add FAQ", points: 10, action: "do it" }] }, { url: `${A}/q`, title: "Q", fixes: [] }],
    },
    siteGeoAnalysis: { opportunities: [{ id: "o1", title: "Add Organization schema", why: "w", priority: "High" }] },
    aiVisibility: { questions: [{ id: "s1", query: "best x?", answerReadiness: "Weak", missingInfo: "mi", recommendedImprovement: "ri" }, { id: "s2", query: "ok", answerReadiness: "Strong" }] },
  });
  const q = buildOpportunityQueue(b);
  assert.deepEqual(byId(q, "kw:k1").legacyIds, ["k1", "uni_kw_k1"]);
  assert.deepEqual(byId(q, "cannib:g1").legacyIds, ["g1"]);
  assert.deepEqual(byId(q, "aeo:rec:r1").legacyIds, ["saeor_r1", "uni_aeo_r1"]);
  assert.ok(byId(q, "aeo:q:q1") && !byId(q, "aeo:q:q2"), "answered questions are not opportunities");
  assert.ok(byId(q, `aeo:page:${A}/p`) && !byId(q, `aeo:page:${A}/q`), "pages with no fixes are skipped");
  assert.deepEqual(byId(q, "geo:o1").legacyIds, ["sgeoo_o1", "uni_geo_o1"]);
  assert.equal(byId(q, "sim:s1").priority, "High"); assert.ok(!byId(q, "sim:s2"));
  assert.equal(byId(q, "aeo:q:q1").actionType, "FAQ Addition");
});

test("ranking: higher score first, ties broken by type then title", () => {
  const b = bundle({
    siteCrawl: crawl({ technical: { findings: [techFinding({ id: "tech_a", severity: "Low", title: "Low thing", urls: [`${A}/1`] })] } }),
    siteGeoAnalysis: { opportunities: [{ id: "g", title: "Critical geo", why: "", priority: "Critical" }, { id: "h", title: "Low geo", why: "", priority: "Low" }] },
    siteKeywordClusters: { opportunities: [{ id: "k", problem: "High kw", priority: "High", confidence: "High" }] },
  });
  const titles = buildOpportunityQueue(b).map((o) => o.title);
  assert.deepEqual(titles, ["Critical geo", "High kw", "Low thing", "Low geo"]); // 85 > 75 > 25+1=26 > 21
});

test("the same opportunity from two sources is shown once, and both ids count as added", () => {
  const b = bundle({
    siteGeoAnalysis: { opportunities: [{ id: "g1", title: "Add FAQ schema", why: "", priority: "High" }] },
    siteAeoAnalysis: { contentRecommendations: [{ id: "r1", recommendation: "Add FAQ schema", why: "", priority: "Medium" }] },
    actions: [{ id: "act1", status: "New", detail: { sourceId: "saeor_r1" } }],
  });
  const q = buildOpportunityQueue(b);
  assert.equal(q.length, 1);
  assert.equal(q[0].module, "Site-wide GEO"); // the higher-scoring one is kept
  assert.deepEqual(q[0].alsoFrom, ["Site-wide AEO"]);
  assert.equal(q[0].state, "in_actions"); // added from the OTHER source's button -> still counts
});

test("Action Center join: any legacy id counts; status maps to state; no double-adds", () => {
  const mk = (sourceId, status) => bundle({
    siteKeywordClusters: { opportunities: [{ id: "k1", problem: "P", priority: "High", confidence: "High" }] },
    actions: [{ id: "a1", status, detail: { sourceId } }],
  });
  for (const sid of ["kw:k1", "k1", "uni_kw_k1"]) assert.equal(buildOpportunityQueue(mk(sid, "Approved"))[0].state, "in_actions", sid);
  assert.equal(buildOpportunityQueue(mk("k1", "Applied"))[0].state, "done");
  assert.equal(buildOpportunityQueue(mk("k1", "Verified"))[0].state, "done");
  assert.equal(buildOpportunityQueue(mk("k1", "Rejected"))[0].state, "rejected");
  assert.equal(buildOpportunityQueue(mk("somethingelse", "New"))[0].state, "new");
  const o = buildOpportunityQueue(mk("uni_kw_k1", "New"))[0];
  assert.equal(findAction(mk("uni_kw_k1", "New").actions, o).id, "a1"); assert.equal(isOpportunityAdded([], o), false);
  assert.deepEqual(opportunityIds(o), ["kw:k1", "k1", "uni_kw_k1"]);
});

test("competitor gaps: kept, and marked low-confidence when compared against an earlier crawl", () => {
  const interp = { gaps: [{ id: "g1", gap: "Missing pricing page", evidence: "e", recommendedAction: "Add it", priority: "High" }], aeoGeoDifferences: [{ id: "d1", difference: "They use Product schema", recommendedAction: "Add schema", priority: "Medium" }] };
  const fresh = bundle({ siteCrawl: crawl(), competitors: [{ id: "c9", name: "Rival", siteAnalysis: { crawlId: "c1", interpretation: interp } }] });
  const q = buildOpportunityQueue(fresh);
  assert.equal(byId(q, "comp:c9:g1").confidence, "Medium"); assert.deepEqual(byId(q, "comp:c9:g1").legacyIds, ["c9_g1"]);
  const stale = bundle({ siteCrawl: crawl(), competitors: [{ id: "c9", name: "Rival", siteAnalysis: { crawlId: "OLD", interpretation: interp } }] });
  const s = byId(buildOpportunityQueue(stale), "comp:c9:g1");
  assert.equal(s.confidence, "Low"); assert.match(s.note, /earlier crawl/);
  assert.ok(s.score < byId(q, "comp:c9:g1").score);
});

test("internal links: one opportunity per target; orphan outranks weak; tracking decides state", () => {
  const recs = { recommendations: [
    { id: "r1", targetUrl: `${A}/orphan`, links: [{ id: "l1", fromUrl: `${A}/a`, anchorText: "orphan page", reason: "related" }] },
    { id: "r2", targetUrl: `${A}/weak`, links: [{ id: "l2", fromUrl: `${A}/b`, anchorText: "weak page", reason: "related" }] },
    { id: "r3", targetUrl: `${A}/empty`, links: [] },
  ] };
  const b = bundle({ siteCrawl: crawl({ orphanPages: [`${A}/orphan`] }), internalLinkRecs: recs });
  let q = buildOpportunityQueue(b);
  assert.equal(q.filter((o) => o.type === "internal_link").length, 2); // r3 has no links -> no opportunity (the orphan also yields its own audit finding)
  assert.equal(byId(q, `link:${A}/orphan`).priority, "Medium"); assert.equal(byId(q, `link:${A}/weak`).priority, "Low");
  assert.match(byId(q, `link:${A}/orphan`).recommendedAction, /anchor "orphan page"/);
  b.internalLinks = [{ source: `${A}/a`, target: `${A}/orphan`, status: "Suggested" }, { source: `${A}/b`, target: `${A}/weak`, status: "Applied" }];
  q = buildOpportunityQueue(b);
  assert.equal(byId(q, `link:${A}/orphan`).state, "in_actions"); assert.equal(byId(q, `link:${A}/weak`).state, "done");
});

test("content ideas: only ideas not yet started are opportunities", () => {
  const b = bundle({ contentIdeas: [
    { id: "i1", title: "Guide to X", status: "Idea", primaryKeyword: "x", intent: "Informational", questions: ["a", "b"], outline: ["Intro", "Steps"] },
    { id: "i2", title: "Drafting", status: "Drafting" }, { id: "i3", title: "Done", status: "Published" },
  ] });
  const q = buildOpportunityQueue(b);
  assert.deepEqual(q.map((o) => o.id), ["content:i1"]);
  assert.match(q[0].evidence, /Primary keyword: x · Intent: Informational · 2 questions to answer/);
});

test("country: market findings appear only for a specific market and follow the selection instantly", () => {
  const c = crawl(); c.pages[0].htmlLang = "de";
  const b = bundle({ siteCrawl: c });
  assert.equal(buildOpportunityQueue(b, { country: "Worldwide" }).filter((o) => o.type === "market").length, 0);
  const ke = buildOpportunityQueue(b, { country: "Kenya" });
  assert.ok(byId(ke, "mkt:mkt_lang_mismatch")); assert.equal(byId(ke, "mkt:mkt_lang_mismatch").market, "Kenya");
  assert.equal(buildOpportunityQueue(b, { country: "Germany" }).some((o) => o.id === "mkt:mkt_lang_mismatch"), false);
});

test("AI results written for another market are kept but demoted and annotated", () => {
  const b = bundle({ siteCrawl: crawl(), siteGeoAnalysis: { market: "United States", opportunities: [{ id: "o1", title: "Add LocalBusiness schema", why: "", priority: "High" }] } });
  const same = byId(buildOpportunityQueue(b, { country: "United States" }), "geo:o1");
  const other = byId(buildOpportunityQueue(b, { country: "Kenya" }), "geo:o1");
  assert.equal(same.confidence, "Medium"); assert.equal(other.confidence, "Low"); assert.ok(other.score < same.score);
  assert.match(other.note, /Written for United States; the selected market is Kenya/);
  assert.equal(byId(buildOpportunityQueue(b, { country: "Worldwide" }), "geo:o1").confidence, "Medium"); // no specific market selected -> nothing to contradict
  const legacy = bundle({ siteCrawl: crawl(), siteGeoAnalysis: { opportunities: [{ id: "o1", title: "Add LocalBusiness schema", why: "", priority: "High" }] } });
  assert.equal(byId(buildOpportunityQueue(legacy, { country: "Kenya" }), "geo:o1").confidence, "Medium"); // pre-market results aren't penalised
});

test("filterQueue and summarizeQueue", () => {
  const b = bundle({
    siteGeoAnalysis: { opportunities: [{ id: "a", title: "Alpha schema", why: "w1", priority: "High" }, { id: "b", title: "Beta schema", why: "w2", priority: "Low" }] },
    siteKeywordClusters: { opportunities: [{ id: "k", problem: "Gamma keyword", priority: "High", confidence: "High" }] },
    actions: [{ id: "x", status: "Applied", detail: { sourceId: "geo:b" } }],
  });
  const q = buildOpportunityQueue(b);
  assert.equal(filterQueue(q).length, 2); // done hidden by default
  assert.equal(filterQueue(q, { states: ["done"] }).length, 1);
  assert.deepEqual(filterQueue(q, { types: ["keyword"] }).map((o) => o.id), ["kw:k"]);
  assert.deepEqual(filterQueue(q, { priorities: ["High"], search: "alpha" }).map((o) => o.id), ["geo:a"]);
  const s = summarizeQueue(q);
  assert.equal(s.total, 3); assert.equal(s.open, 2); assert.equal(s.done, 1); assert.equal(s.byType.geo, 1); assert.equal(s.byPriority.High, 2);
});

test("hostile or malformed data never throws", () => {
  const b = bundle({
    siteCrawl: { siteWide: { ...baseSiteWide, technical: { findings: [{ id: "tech_x" }, null] } }, pages: [{}] },
    siteKeywordClusters: { opportunities: [null, { id: 1 }, { problem: "ok", priority: "bogus" }] },
    siteAeoAnalysis: { questions: "nope", weakestPages: [{ url: "u", fixes: [null] }] }, competitors: [null, { id: "c" }, { id: "d", siteAnalysis: {} }],
    internalLinkRecs: { recommendations: [null, { links: null }] }, contentIdeas: [null, { status: "Idea" }],
  });
  assert.doesNotThrow(() => buildOpportunityQueue(b, { country: "Kenya" }));
  assert.equal(buildOpportunityQueue(b).find((o) => o.title === "ok").priority, "Medium"); // unknown priority -> Medium
});

const gscReport = (o = {}) => ({
  fetchedAt: "2026-10-28T10:00:00.000Z", days: 28, range: { startDate: "2026-09-28", endDate: "2026-10-25" }, previousRange: { startDate: "2026-08-31", endDate: "2026-09-27" },
  totals: { clicks: 500, impressions: 10000, ctr: 0.05, position: 8 }, previousTotals: { clicks: 500, impressions: 10000, ctr: 0.05, position: 8 },
  queries: [], previousPages: [], truncated: { queries: false, pages: false, queryPages: false },
  pages: [{ page: `${A}/shoes`, clicks: 20, impressions: 2000, ctr: 0.01, position: 4.2 }],
  queryPages: [{ query: "red shoes", page: `${A}/shoes`, clicks: 10, impressions: 900, ctr: 0.011, position: 4 }], ...o,
});
const NOW = Date.parse("2026-10-30T00:00:00Z");

test("search data joins the queue with an estimate-labelled bonus and a pull-request hook", () => {
  const q = buildOpportunityQueue(bundle({ gscReport: gscReport() }), { nowMs: NOW });
  const o = q.find((x) => x.id === "gsc:lowctr:a-com-shoes");
  assert.equal(o.type, "search"); assert.equal(o.state, "new"); assert.ok(o.score > 50 && o.score <= 100);
  assert.match(o.explanation, /Medium confidence/); assert.match(o.explanation, /\+ \d+ for ~\d+ extra clicks per 28 days \(estimate\)/);
  assert.equal(o.prIssue.id, "gsc_lowctr"); assert.deepEqual(o.prIssue.urls, [`${A}/shoes`]);
  assert.equal(summarizeQueue(q).byType.search, 1);
});

test("search data older than two weeks is kept but demoted and labelled; fresh data isn't", () => {
  const fresh = buildOpportunityQueue(bundle({ gscReport: gscReport() }), { nowMs: NOW }).find((x) => x.type === "search");
  const old = buildOpportunityQueue(bundle({ gscReport: gscReport({ fetchedAt: "2026-09-01T00:00:00.000Z" }) }), { nowMs: NOW }).find((x) => x.type === "search");
  assert.equal(fresh.confidence, "Medium"); assert.equal(fresh.note, undefined);
  assert.equal(old.confidence, "Low"); assert.match(old.note, /Search data is 59 days old/); assert.ok(old.score < fresh.score);
  assert.deepEqual(buildOpportunityQueue(bundle({ gscReport: null }), { nowMs: NOW }), []);
});

test("search opportunities map onto the Action Center like every other source", () => {
  const actions = [{ id: "a", status: "PR Open", detail: { sourceId: "gsc:lowctr:a-com-shoes" } }];
  assert.equal(buildOpportunityQueue(bundle({ gscReport: gscReport(), actions }), { nowMs: NOW }).find((x) => x.type === "search").state, "in_actions");
  actions[0].status = "Applied";
  assert.equal(buildOpportunityQueue(bundle({ gscReport: gscReport(), actions }), { nowMs: NOW }).find((x) => x.type === "search").state, "done");
});
