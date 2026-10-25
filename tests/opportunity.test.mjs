import test from "node:test";
import assert from "node:assert/strict";
import {
  makeOpportunity, toRecord, fromAuditIssue, fromKeywordOpportunity, fromAeoQuestion, fromAeoWeakPage, fromSimulatorQuery,
  fromCompetitorGap, compareOpportunities, collectCandidates, migrateOpportunity, migrateOpportunities, canonicalSourceId,
  buildQueue, summarizeQueue, groupOf, hasRecord, OPEN, ACTION_TYPES, PRIORITIES, OPPORTUNITY_VERSION,
} from "../lib/opportunity.js";
import { computeSiteAuditIssues, formatAction, sectionOpportunities, PAGE_EXPORTERS } from "../lib/copyExport.js";

const baseSiteWide = { orphanPages: [], weakLinkedPages: [], duplicateTitles: [], duplicateMetaDescriptions: [], nearDuplicateContentPairs: [], recurringIssues: [] };
const finding = (over = {}) => ({
  id: "tech_broken_links", category: "Technical", severity: "High", title: "2 broken internal links (404)", why: "w", fix: "Fix the links.",
  urls: ["https://a.com/x", "https://a.com/y"], evidence: [{ url: "https://a.com/x", status: 404 }], ...over,
});

test("makeOpportunity normalizes and refuses unidentifiable input", () => {
  const o = makeOpportunity({ sourceId: " s1 ", title: " T ", priority: "high", type: "nonsense", confidence: "??", kind: "bogus", urls: ["u", "u", "", null] });
  assert.equal(o.sourceId, "s1"); assert.equal(o.title, "T");
  assert.equal(o.priority, "High"); assert.equal(o.type, "Content Update"); assert.equal(o.confidence, "Medium");
  assert.equal(o.kind, "ai_analysis"); assert.deepEqual(o.urls, ["u"]);
  assert.equal(makeOpportunity({ title: "no id" }), null);
  assert.equal(makeOpportunity({ sourceId: "no title" }), null);
  assert.equal(makeOpportunity(), null);
});

test("every builder yields a valid shape (types and priorities are from the allowed lists)", () => {
  const all = [
    fromAuditIssue(finding()),
    fromKeywordOpportunity({ id: "kw1", problem: "P", evidence: "e", recommendedAction: "r", priority: "Low", confidence: "High", source: "s" }),
    fromAeoQuestion({ id: "q1", question: "Why?", priority: "Medium", missingInfo: "m", recommendedAnswer: "a", answeringUrl: "https://a.com/" }),
    fromAeoWeakPage({ url: "https://a.com/w", title: "W", score: 30, priority: "High", fixes: [{ label: "L", points: 5, action: "A" }] }),
    fromSimulatorQuery({ id: "0", query: "best x", answerReadiness: "Weak", missingInfo: "m", recommendedImprovement: "i" }),
    fromCompetitorGap({ id: "c1", name: "Rival" }, { id: "g1", gap: "Gap", evidence: "e", recommendedAction: "r", priority: "High" }),
  ];
  for (const o of all) {
    assert.ok(o, "builder returned null");
    assert.ok(ACTION_TYPES.includes(o.type)); assert.ok(PRIORITIES.includes(o.priority));
    assert.ok(Array.isArray(o.urls)); assert.ok(o.sourceId && o.title && o.module);
  }
  assert.equal(all[3].kind, "observed"); assert.equal(all[4].kind, "ai_estimate"); assert.equal(all[2].kind, "ai_analysis");
  assert.equal(all[4].priority, "High"); // a Weak simulated answer is High
});

test("existing sourceIds are preserved, so saved workspaces still match", () => {
  assert.equal(fromAeoQuestion({ id: "7", question: "q" }).sourceId, "saeoq_7");
  assert.equal(fromAeoWeakPage({ url: "https://a.com/w", title: "t" }).sourceId, "saeop_https://a.com/w");
  assert.equal(fromSimulatorQuery({ id: "sim_2", query: "q" }).sourceId, "sim_sim_2");
  assert.equal(fromCompetitorGap({ id: "c9", name: "R" }, { id: "g2", gap: "g" }).sourceId, "c9_g2");
});

test("audit severity is carried through as priority — Critical is not flattened to High", () => {
  assert.equal(fromAuditIssue(finding({ severity: "Critical" })).priority, "Critical");
  assert.equal(fromAuditIssue(finding({ severity: "Low" })).priority, "Low");
});

test("audit issues map to the right action type", () => {
  const t = (category) => fromAuditIssue(finding({ category })).type;
  assert.equal(t("On-Page"), "Meta Fix"); assert.equal(t("Content"), "Content Update"); assert.equal(t("Schema"), "Schema Markup");
  assert.equal(t("Internal Linking"), "Internal Link"); assert.equal(t("Indexing"), "Technical Fix"); assert.equal(t("Technical"), "Technical Fix");
});

test("audit evidence names the affected pages and the per-URL proof", () => {
  const o = fromAuditIssue(finding(), (e) => `HTTP ${e.status}`);
  assert.match(o.evidence, /Affects 2 pages: https:\/\/a\.com\/x, https:\/\/a\.com\/y/);
  assert.match(o.evidence, /https:\/\/a\.com\/x — HTTP 404/);
  assert.deepEqual(o.urls, ["https://a.com/x", "https://a.com/y"]);
});

test("ranking: priority, then observed before AI, then indexability, then reach", () => {
  const mk = (over) => makeOpportunity({ sourceId: Math.random().toString(36), title: "t", ...over });
  const list = [
    mk({ priority: "High", kind: "ai_analysis", title: "ai-high" }),
    mk({ priority: "Low", kind: "observed", title: "obs-low" }),
    mk({ priority: "High", kind: "observed", category: "Content", title: "obs-high-content" }),
    mk({ priority: "High", kind: "observed", category: "Indexing", title: "obs-high-indexing" }),
    mk({ priority: "Critical", kind: "ai_estimate", title: "est-critical" }),
    mk({ priority: "High", kind: "observed", category: "Technical", urls: ["a", "b", "c"], title: "obs-high-tech-wide" }),
    mk({ priority: "High", kind: "observed", category: "Technical", urls: ["a"], title: "obs-high-tech-narrow" }),
  ].sort(compareOpportunities).map((o) => o.title);
  assert.deepEqual(list, ["est-critical", "obs-high-indexing", "obs-high-tech-wide", "obs-high-tech-narrow", "obs-high-content", "ai-high", "obs-low"]);
});

test("toRecord stamps identity, status, market and crawl", () => {
  const c = fromKeywordOpportunity({ id: "kw1", problem: "P" });
  const r = toRecord(c, { id: "act_1", websiteId: "site_1", country: "Kenya", crawlId: "crawl-9", now: "2026-10-25T00:00:00.000Z" });
  assert.equal(r.schemaVersion, OPPORTUNITY_VERSION); assert.equal(r.status, "New");
  assert.equal(r.country, "Kenya"); assert.equal(r.crawlId, "crawl-9"); assert.equal(r.createdAt, r.updatedAt);
  assert.equal(r.sourceId, "kw1"); assert.equal(r.detail, undefined);
});

test("legacy records (with `detail`) migrate losslessly and idempotently", () => {
  const legacy = {
    id: "act_5", websiteId: "s", createdAt: "2026-01-01T00:00:00Z", title: "Fix meta", type: "Meta Fix", status: "Applied",
    detail: { sourceId: "site_dupmeta_0", module: "Site-wide Audit", evidence: "ev", recommendedAction: "do it", priority: "Medium", confidence: "High", source: "Crawled Data" },
  };
  const m = migrateOpportunity(legacy);
  assert.equal(m.schemaVersion, 2); assert.equal(m.detail, undefined);
  assert.deepEqual([m.sourceId, m.module, m.evidence, m.recommendedAction, m.priority, m.confidence, m.source, m.status, m.type], ["site_dupmeta_0", "Site-wide Audit", "ev", "do it", "Medium", "High", "Crawled Data", "Applied", "Meta Fix"]);
  assert.equal(m.kind, "observed"); assert.equal(m.country, null); assert.equal(m.crawlId, null); // unknown stays unknown
  assert.equal(m.createdAt, "2026-01-01T00:00:00Z");
  assert.strictEqual(migrateOpportunity(m), m);
});

test("migration tolerates junk: no detail, bad status/type/priority, non-objects", () => {
  const m = migrateOpportunity({ id: "a1", title: "x", status: "weird", type: "weird" });
  assert.equal(m.status, "New"); assert.equal(m.type, "Content Update"); assert.equal(m.priority, "Medium"); assert.equal(m.sourceId, "manual_a1");
  assert.equal(migrateOpportunity(null), null); assert.equal(migrateOpportunity("x"), null);
  assert.deepEqual(migrateOpportunities(undefined), []);
  assert.deepEqual(migrateOpportunities([null, 5, { id: "z", title: "ok" }]).map((x) => x.id), ["z"]);
});

test("the Dashboard's old unified ids are mapped to the canonical ids, and the duplicate collapses", () => {
  assert.equal(canonicalSourceId("uni_kw_kwo_3"), "kwo_3");
  assert.equal(canonicalSourceId("uni_aeo_r1"), "saeor_r1");
  assert.equal(canonicalSourceId("uni_geo_g1"), "sgeoo_g1");
  const list = migrateOpportunities([
    { id: "new", title: "Same finding", status: "Approved", detail: { sourceId: "uni_aeo_r1" } },
    { id: "old", title: "Same finding", status: "New", detail: { sourceId: "saeor_r1" } },
  ]);
  assert.deepEqual(list.map((x) => x.id), ["new"]); // newest (first) wins
  assert.ok(hasRecord([{ detail: { sourceId: "uni_kw_kwo_3" } }], "kwo_3"));
});

const analyses = () => ({
  siteCrawl: { crawlId: "crawl-2", siteWide: { ...baseSiteWide, orphanPages: ["https://a.com/o"], technical: { findings: [finding({ id: "tech_home_noindex", category: "Indexing", severity: "Critical", title: "Homepage is noindex", urls: ["https://a.com/"] })] } } },
  siteKeywordClusters: { opportunities: [{ id: "kw1", problem: "Weak H1", priority: "High", evidence: "e", recommendedAction: "r" }], cannibalizationGuidance: [{ id: "can1", recommendedAction: "Merge", explanation: "x", reasoning: "y" }] },
  siteAeoAnalysis: {
    questions: [{ id: "q1", question: "Q?", priority: "Medium" }],
    contentRecommendations: [{ id: "r1", recommendation: "Add FAQ", why: "w", priority: "High" }],
    weakestPages: [{ url: "https://a.com/w", title: "W", score: 20, priority: "High", fixes: [{ label: "L", points: 3, action: "A" }] }, { url: "https://a.com/nofix", title: "N", fixes: [] }],
  },
  siteGeoAnalysis: { opportunities: [{ id: "g1", title: "Add Organization schema", priority: "Medium" }] },
  aiVisibility: { queries: [{ id: "sim_0", query: "best x", answerReadiness: "Weak" }] },
  competitors: [{ id: "c1", name: "Rival", siteAnalysis: { interpretation: { gaps: [{ id: "g1", gap: "Topic gap", priority: "Low" }], aeoGeoDifferences: [{ id: "d1", difference: "Rival has FAQ schema", priority: "Medium" }] } } }],
  actions: [],
});
const auditOf = (b) => computeSiteAuditIssues(b.siteCrawl);

test("collectCandidates gathers every module once, with unique ids, skipping pages with no fixes", () => {
  const b = analyses();
  const c = collectCandidates(b, { auditIssues: auditOf(b) });
  const ids = c.map((x) => x.sourceId);
  assert.equal(new Set(ids).size, ids.length);
  for (const want of ["tech_home_noindex", "site_orphan", "kw1", "can1", "saeoq_q1", "saeor_r1", "saeop_https://a.com/w", "sgeoo_g1", "sim_sim_0", "c1_g1", "c1_d1"]) assert.ok(ids.includes(want), `missing ${want}`);
  assert.ok(!ids.includes("saeop_https://a.com/nofix"));
});

test("collectCandidates is safe on an empty / never-analysed site", () => {
  assert.deepEqual(collectCandidates(null), []);
  assert.deepEqual(collectCandidates({ siteCrawl: null, actions: [] }), []);
});

test("queue: everything starts Open and the indexability problem is first", () => {
  const b = analyses();
  const q = buildQueue(b, { auditIssues: auditOf(b), country: "Kenya" });
  assert.ok(q.every((i) => i.state === OPEN && i.record === null));
  assert.equal(q[0].sourceId, "tech_home_noindex"); // Critical + observed + Indexing
  assert.equal(summarizeQueue(q).open, q.length);
});

test("queue: an accepted finding takes the record's workflow state and is not duplicated", () => {
  const b = analyses();
  const cand = fromKeywordOpportunity({ id: "kw1", problem: "Weak H1", priority: "High" });
  b.actions = [toRecord(cand, { id: "act_1", websiteId: "s", country: "Kenya", crawlId: "crawl-2", status: "Approved" })];
  const q = buildQueue(b, { auditIssues: auditOf(b), country: "Kenya" });
  assert.equal(q.filter((i) => i.sourceId === "kw1").length, 1);
  const item = q.find((i) => i.sourceId === "kw1");
  assert.equal(item.state, "Approved"); assert.equal(item.record.id, "act_1"); assert.equal(item.current, true);
  assert.equal(item.stale, false); assert.equal(item.otherMarket, false);
  assert.deepEqual(summarizeQueue(q), { open: q.length - 1, inWorkflow: 1, done: 0, dismissed: 0, total: q.length });
});

test("queue: dismissed and done counts", () => {
  const b = analyses();
  const mk = (src, status) => toRecord(fromKeywordOpportunity({ id: src, problem: src }), { id: `a_${src}`, websiteId: "s", status });
  b.actions = [mk("kw1", "Rejected"), mk("x1", "Applied"), mk("x2", "Verified"), mk("x3", "Pending Approval")];
  const s = summarizeQueue(buildQueue(b, { auditIssues: auditOf(b) }));
  assert.equal(s.dismissed, 1); assert.equal(s.done, 2); assert.equal(s.inWorkflow, 1);
});

test("queue: a record whose finding is gone is kept (it's the user's work) and flagged as not current", () => {
  const b = analyses();
  b.actions = [toRecord(fromKeywordOpportunity({ id: "gone", problem: "Old thing" }), { id: "a1", websiteId: "s", crawlId: "crawl-2" })];
  const item = buildQueue(b, { auditIssues: auditOf(b) }).find((i) => i.id === "a1");
  assert.ok(item); assert.equal(item.current, false); assert.equal(item.state, "New");
});

test("queue: records from an older crawl, or another market, are flagged — legacy records are not", () => {
  const b = analyses();
  const rec = (id, over) => ({ ...toRecord(fromKeywordOpportunity({ id, problem: id }), { id: `a_${id}`, websiteId: "s" }), ...over });
  b.actions = [rec("old", { crawlId: "crawl-1", country: "Kenya" }), rec("mkt", { crawlId: "crawl-2", country: "France" }), rec("legacy", { crawlId: null, country: null })];
  const q = buildQueue(b, { auditIssues: [], country: "Kenya" });
  const by = (id) => q.find((i) => i.id === `a_${id}`);
  assert.equal(by("old").stale, true); assert.equal(by("old").otherMarket, false);
  assert.equal(by("mkt").otherMarket, true); assert.equal(by("mkt").stale, false);
  assert.equal(by("legacy").stale, false); assert.equal(by("legacy").otherMarket, false);
});

test("queue: a legacy index-based id ('rec_3') still matches the same issue by title after the ids shift", () => {
  const b = analyses();
  b.siteCrawl.siteWide.recurringIssues = [{ category: "On-Page", severity: "Medium", title: "Missing meta description", why: "w", fix: "f", urls: ["https://a.com/p"] }];
  // crawl order changed: the issue is now rec_0, but the user accepted it back when it was rec_3
  b.actions = [{ id: "legacy1", title: "Missing meta description", status: "Approved", type: "Meta Fix", detail: { sourceId: "rec_3", module: "Site-wide Audit", priority: "Medium" } }];
  const q = buildQueue(b, { auditIssues: auditOf(b) });
  const hits = q.filter((i) => i.title === "Missing meta description");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].state, "Approved");
});

test("queue: two candidates sharing a title cannot both claim one record", () => {
  const b = analyses();
  b.siteKeywordClusters.opportunities = [{ id: "k1", problem: "Same", priority: "High" }, { id: "k2", problem: "Same", priority: "High" }];
  b.actions = [{ id: "l1", title: "Same", status: "Approved", detail: { sourceId: "unknown", module: "Site-wide Keyword Intelligence" } }];
  const same = buildQueue(b, { auditIssues: [] }).filter((i) => i.title === "Same");
  assert.equal(same.length, 2);
  assert.equal(same.filter((i) => i.state === "Approved").length, 1);
});

test("exports read both record shapes", () => {
  const legacy = { id: "a", title: "T", type: "Meta Fix", status: "New", createdAt: "2026-10-01T00:00:00Z", detail: { module: "M", evidence: "E", recommendedAction: "R", priority: "High", confidence: "High", source: "S" } };
  const md = formatAction(legacy, "##");
  for (const t of ["## T", "Priority", "High", "Evidence from crawl", "E", "Recommended action", "R"]) assert.ok(md.includes(t), t);
  const flat = formatAction({ ...migrateOpportunity(legacy), country: "Kenya", urls: ["https://a.com/p"] }, "##");
  assert.match(flat, /Market.*Kenya/); assert.match(flat, /https:\/\/a\.com\/p/); assert.match(flat, /Evidence from crawl.*E/);
});

test("the queue page export lists items in rank order with their state", () => {
  const b = analyses();
  b.actions = [toRecord(fromKeywordOpportunity({ id: "kw1", problem: "Weak H1", priority: "High" }), { id: "a1", websiteId: "s", status: "Applied" })];
  const md = PAGE_EXPORTERS.queue({ url: "a.com", country: "Kenya" }, b);
  assert.match(md, /## Opportunity Queue \(/);
  assert.ok(md.indexOf("Homepage is noindex") < md.indexOf("Weak H1"));
  assert.match(md, /Status\*\*: Applied|Status.*Applied/);
  assert.equal(sectionOpportunities([]), "");
  assert.equal(PAGE_EXPORTERS.queue({ url: "a.com" }, { siteCrawl: null, actions: [] }), "");
});

test("toRecord strips UI-only fields and refuses an unidentifiable candidate", () => {
  const c = { ...fromKeywordOpportunity({ id: "kw1", problem: "P" }), state: "Open", record: null, stale: true, current: true, otherMarket: false };
  const r = toRecord(c, { id: "a", websiteId: "s" });
  for (const k of ["state", "record", "stale", "current", "otherMarket"]) assert.equal(k in r, false, k);
  assert.equal(toRecord({ title: "no id" }, { id: "a" }), null);
});

test("groupOf puts every status in exactly one tab", () => {
  const rec = (status) => ({ state: status, record: { status } });
  assert.equal(groupOf({ state: OPEN, record: null }), "open");
  assert.equal(groupOf(rec("New")), "workflow"); assert.equal(groupOf(rec("Pending Approval")), "workflow"); assert.equal(groupOf(rec("Approved")), "workflow");
  assert.equal(groupOf(rec("Applied")), "done"); assert.equal(groupOf(rec("Verified")), "done");
  assert.equal(groupOf(rec("Rejected")), "dismissed");
  assert.equal(groupOf(null), "open");
});
