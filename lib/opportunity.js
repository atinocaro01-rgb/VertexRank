// The normalized opportunity — one shape for everything the app tells the user to do (no React, no I/O —
// unit-tested in tests/opportunity.test.mjs).
//
// Before this, every module built its own ad-hoc `detail` object at its own `addAction` call site, with its own
// idea of what "priority" meant, which fields existed and how a finding was identified. Now:
//
//   candidate   what a module PRODUCES (a finding it thinks is worth doing). Never stored; recomputed from the
//               analyses every time, so it is always as fresh as the latest crawl/analysis.
//   record      a candidate the user ACCEPTED into the workflow (or dismissed). Stored in `bundle.actions`
//               (same key as before, so saved workspaces keep working) with an id, status and timestamps.
//   queue item  what the Opportunity Queue shows: every candidate plus every record, matched together.
//               A candidate with no record is "Open"; with a record its state is the record's workflow status.
//
// The Action Center is therefore not a second list — it is the workflow state of the Queue (records only).

import { isStaleForCrawl } from "./crawlState.js";

export const OPPORTUNITY_VERSION = 2;

export const ACTION_TYPES = ["Meta Fix", "Content Update", "Schema Markup", "Internal Link", "Technical Fix", "FAQ Addition"];
export const PRIORITIES = ["Critical", "High", "Medium", "Low"];
export const CONFIDENCES = ["High", "Medium", "Low"];
// Workflow. "Applied" is stored for compatibility with saved data; the UI shows it as "Marked done"
// (VertexRank does not change anyone's website — see Phase 1).
export const OPPORTUNITY_STATUSES = ["New", "Pending Approval", "Approved", "Rejected", "Applied", "Verified"];
export const OPEN = "Open"; // queue-only state: a candidate nobody has accepted or dismissed yet

/** Where the evidence comes from, using the app-wide provenance vocabulary (lib/dataLabel.js). */
export const KINDS = ["observed", "ai_analysis", "ai_estimate"];

const PRIORITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const KIND_RANK = { observed: 0, ai_analysis: 1, ai_estimate: 2 };
// What hurts most when it is wrong: can search engines index the site at all, then everything else technical.
const CATEGORY_RANK = { Indexing: 0, Technical: 1 };

const str = (v, max = 2000) => (v === undefined || v === null ? "" : String(v).replace(/\r\n?/g, "\n").trim().slice(0, max));
const pickFrom = (list, v, fallback) => {
  const hit = list.find((x) => x.toLowerCase() === String(v ?? "").trim().toLowerCase());
  return hit || fallback;
};
export const normalizePriority = (v) => pickFrom(PRIORITIES, v, "Medium");
export const normalizeConfidence = (v) => pickFrom(CONFIDENCES, v, "Medium");
export const normalizeType = (v) => pickFrom(ACTION_TYPES, v, "Content Update");
export const normalizeStatus = (v) => pickFrom(OPPORTUNITY_STATUSES, v, "New");
const normalizeKind = (v, fallback = "ai_analysis") => (KINDS.includes(v) ? v : fallback);
const uniqueUrls = (list) => [...new Set((Array.isArray(list) ? list : []).map((u) => str(u, 500)).filter(Boolean))].slice(0, 200);

/**
 * Builds a candidate. Returns null when it cannot be identified or described (no sourceId / no title) —
 * callers must handle that rather than store a half-empty opportunity.
 */
export function makeOpportunity(f = {}) {
  const sourceId = str(f.sourceId, 300);
  const title = str(f.title, 400);
  if (!sourceId || !title) return null;
  return {
    sourceId,
    module: str(f.module, 120) || "Other",
    kind: normalizeKind(f.kind),
    title,
    type: normalizeType(f.type),
    category: str(f.category, 60) || null,
    priority: normalizePriority(f.priority),
    confidence: normalizeConfidence(f.confidence),
    evidence: str(f.evidence),
    recommendedAction: str(f.recommendedAction),
    source: str(f.source, 160),
    urls: uniqueUrls(f.urls),
  };
}

/** Turns a candidate into a stored record. `now`/`id` are injectable so tests (and ids) stay deterministic. */
export function toRecord(candidate, { id, websiteId, country, crawlId, status = "New", now = new Date().toISOString() } = {}) {
  // Re-normalizing through makeOpportunity also strips anything that is not part of the shape — queue items
  // carry UI fields (state, record, stale…) that must never be stored.
  const clean = makeOpportunity(candidate);
  if (!clean) return null;
  return {
    schemaVersion: OPPORTUNITY_VERSION,
    ...clean,
    id, websiteId,
    country: country ?? null,
    crawlId: candidate.crawlId ?? crawlId ?? null,
    status: normalizeStatus(status),
    createdAt: now, updatedAt: now,
  };
}

/* ============================== builders: one per source, preserving the sourceIds the app already used ============================== */

const AUDIT_TYPE_BY_CATEGORY = { Content: "Content Update", Schema: "Schema Markup", "Internal Linking": "Internal Link", "On-Page": "Meta Fix" };

/** A site-wide audit issue (lib/copyExport.js computeSiteAuditIssues). Severity IS the priority — a Critical
 *  indexability problem must not be flattened to "High" on its way into the queue. */
export function fromAuditIssue(issue, describe = () => "") {
  const urls = Array.isArray(issue?.urls) ? issue.urls : [];
  const lines = (Array.isArray(issue?.evidence) ? issue.evidence : []).slice(0, 3).map((e) => `${e?.url}${describe(e) ? ` — ${describe(e)}` : ""}`);
  return makeOpportunity({
    sourceId: issue?.id, title: issue?.title, module: "Site-wide Audit", kind: "observed",
    type: AUDIT_TYPE_BY_CATEGORY[issue?.category] || "Technical Fix", category: issue?.category,
    priority: issue?.severity, confidence: "High", source: "Crawled Data",
    evidence: [`Affects ${urls.length} page${urls.length === 1 ? "" : "s"}: ${urls.slice(0, 3).join(", ")}${urls.length > 3 ? "…" : ""}`, ...lines].join("\n"),
    recommendedAction: issue?.fix, urls,
  });
}

export const fromKeywordOpportunity = (o) => makeOpportunity({
  sourceId: o?.id, title: o?.problem, module: "Site-wide Keyword Intelligence", type: "Content Update",
  evidence: o?.evidence, recommendedAction: o?.recommendedAction, priority: o?.priority, confidence: o?.confidence, source: o?.source,
});

export const fromCannibalization = (g) => makeOpportunity({
  sourceId: g?.id, title: `${str(g?.recommendedAction)} competing pages`, module: "Site-wide Keyword Intelligence", type: "Content Update",
  evidence: g?.explanation, recommendedAction: g?.reasoning, priority: "High", confidence: "Medium", source: g?.source,
});

export const fromAeoQuestion = (q) => makeOpportunity({
  sourceId: `saeoq_${q?.id}`, title: `Answer: "${str(q?.question)}"`, module: "Site-wide AEO", type: "FAQ Addition",
  evidence: q?.missingInfo, recommendedAction: q?.recommendedAnswer, priority: q?.priority, confidence: "Medium", source: q?.source,
  urls: q?.answeringUrl ? [q.answeringUrl] : [],
});

export const fromAeoRecommendation = (r) => makeOpportunity({
  sourceId: `saeor_${r?.id}`, title: r?.recommendation, module: "Site-wide AEO", type: "Content Update",
  evidence: r?.why, recommendedAction: r?.recommendation, priority: r?.priority, confidence: "Medium", source: r?.source,
});

export const fromAeoWeakPage = (p) => {
  const fixes = (Array.isArray(p?.fixes) ? p.fixes : []).map((f) => `${f.label} (+${f.points}): ${f.action}`).join("\n");
  return makeOpportunity({
    sourceId: `saeop_${p?.url}`, title: `Improve AEO on: ${str(p?.title) || str(p?.url)}`, module: "Site-wide AEO", kind: "observed", type: "Content Update",
    evidence: `Scores ${p?.score}/100 on the AEO signal checklist (${p?.url}).`,
    recommendedAction: [fixes, p?.aiSuggestions?.rewriteTip].filter(Boolean).join("\n"),
    priority: p?.priority, confidence: "High", source: "VertexRank crawl signals", urls: p?.url ? [p.url] : [],
  });
};

export const fromGeoOpportunity = (o) => makeOpportunity({
  sourceId: `sgeoo_${o?.id}`, title: o?.title, module: "Site-wide GEO", type: "Schema Markup",
  evidence: o?.why, recommendedAction: o?.title, priority: o?.priority, confidence: "Medium", source: o?.source,
});

export const fromSimulatorQuery = (q) => makeOpportunity({
  sourceId: `sim_${q?.id}`, title: `Improve AI visibility for: "${str(q?.query)}"`, module: "AI Visibility Simulator", kind: "ai_estimate", type: "Content Update",
  evidence: q?.missingInfo, recommendedAction: q?.recommendedImprovement, priority: q?.answerReadiness === "Weak" ? "High" : "Medium",
  confidence: "Medium", source: "VertexRank AI Visibility Simulation",
});

export const fromCompetitorGap = (c, g) => makeOpportunity({
  sourceId: `${c?.id}_${g?.id}`, title: g?.gap, module: `Competitor: ${str(c?.name)}`, type: "Content Update",
  evidence: g?.evidence, recommendedAction: g?.recommendedAction, priority: g?.priority, confidence: "Medium", source: g?.source,
});

export const fromCompetitorAeoGeoDiff = (c, d) => makeOpportunity({
  sourceId: `${c?.id}_${d?.id}`, title: d?.difference, module: `Competitor: ${str(c?.name)} (AEO/GEO)`, type: "Schema Markup",
  recommendedAction: d?.recommendedAction, priority: d?.priority, confidence: "Medium", source: d?.source,
});

/* ============================== ranking ============================== */

/** Most important first: priority, then proof over inference (observed before AI), then indexability/technical
 *  over everything else, then how many pages it touches. */
export function compareOpportunities(a, b) {
  return (PRIORITY_RANK[a.priority] ?? 4) - (PRIORITY_RANK[b.priority] ?? 4)
    || (KIND_RANK[a.kind] ?? 3) - (KIND_RANK[b.kind] ?? 3)
    || (CATEGORY_RANK[a.category] ?? 2) - (CATEGORY_RANK[b.category] ?? 2)
    || (b.urls?.length || 0) - (a.urls?.length || 0)
    || String(a.title).localeCompare(String(b.title));
}

/* ============================== collecting candidates ============================== */

const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Every candidate the current analyses support, deduplicated by sourceId.
 * auditIssues is passed in (computed by copyExport.computeSiteAuditIssues) to keep this file free of imports
 * from the export code, which itself imports from here.
 */
export function collectCandidates(b, { auditIssues = [], describeEvidence } = {}) {
  const out = [];
  const add = (c) => { if (c) out.push(c); };
  arr(auditIssues).forEach((i) => add(fromAuditIssue(i, describeEvidence)));
  arr(b?.siteKeywordClusters?.opportunities).forEach((o) => add(fromKeywordOpportunity(o)));
  arr(b?.siteKeywordClusters?.cannibalizationGuidance).forEach((g) => add(fromCannibalization(g)));
  arr(b?.siteAeoAnalysis?.questions).forEach((q) => add(fromAeoQuestion(q)));
  arr(b?.siteAeoAnalysis?.contentRecommendations).forEach((r) => add(fromAeoRecommendation(r)));
  arr(b?.siteAeoAnalysis?.weakestPages).slice(0, 8).filter((p) => Array.isArray(p?.fixes) && p.fixes.length > 0).forEach((p) => add(fromAeoWeakPage(p)));
  arr(b?.siteGeoAnalysis?.opportunities).forEach((o) => add(fromGeoOpportunity(o)));
  arr(b?.aiVisibility?.queries).forEach((q) => add(fromSimulatorQuery(q)));
  arr(b?.competitors).forEach((c) => {
    arr(c?.siteAnalysis?.interpretation?.gaps).forEach((g) => add(fromCompetitorGap(c, g)));
    arr(c?.siteAnalysis?.interpretation?.aeoGeoDifferences).forEach((d) => add(fromCompetitorAeoGeoDiff(c, d)));
  });
  const seen = new Set();
  return out.filter((c) => (seen.has(c.sourceId) ? false : (seen.add(c.sourceId), true)));
}

/* ============================== stored records: legacy migration ============================== */

// The Dashboard's old "Unified recommendations" used its own ids for the same findings the module tabs offered,
// so one finding could be added twice. Map them back to the canonical id.
const LEGACY_PREFIXES = [["uni_kw_", ""], ["uni_aeo_", "saeor_"], ["uni_geo_", "sgeoo_"]];
export function canonicalSourceId(id) {
  const s = str(id, 300);
  for (const [from, to] of LEGACY_PREFIXES) if (s.startsWith(from)) return `${to}${s.slice(from.length)}`;
  return s;
}

function inferKind(source, module) {
  const t = `${source || ""} ${module || ""}`;
  if (/Crawled Data|crawl signals|Site-wide Audit/i.test(t)) return "observed";
  if (/Simulat/i.test(t)) return "ai_estimate";
  return "ai_analysis";
}

/** Brings one stored action up to the current shape. Idempotent. Never invents values it cannot know
 *  (country / crawlId stay null for legacy records, which makes them neither "stale" nor "wrong market"). */
export function migrateOpportunity(a) {
  if (!a || typeof a !== "object") return null;
  if (a.schemaVersion === OPPORTUNITY_VERSION) return a;
  const d = a.detail && typeof a.detail === "object" ? a.detail : {};
  const sourceId = canonicalSourceId(d.sourceId || a.sourceId) || `manual_${a.id}`;
  const title = str(a.title, 400) || "Untitled action";
  const created = a.createdAt || new Date(0).toISOString();
  return {
    schemaVersion: OPPORTUNITY_VERSION,
    id: a.id, websiteId: a.websiteId,
    sourceId, module: str(d.module || a.module, 120) || "Other",
    kind: normalizeKind(d.kind || a.kind, inferKind(d.source || a.source, d.module || a.module)),
    title, type: normalizeType(a.type), category: a.category || null,
    priority: normalizePriority(d.priority || a.priority), confidence: normalizeConfidence(d.confidence || a.confidence),
    evidence: str(d.evidence ?? a.evidence), recommendedAction: str(d.recommendedAction ?? a.recommendedAction),
    source: str(d.source || a.source, 160), urls: uniqueUrls(a.urls),
    country: a.country ?? null, crawlId: a.crawlId ?? null,
    status: normalizeStatus(a.status), createdAt: created, updatedAt: a.updatedAt || created,
  };
}

/** Migrates a stored list and drops duplicates of the same finding (newest first wins — new ones are prepended). */
export function migrateOpportunities(list) {
  const seen = new Set();
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const m = migrateOpportunity(a);
    if (!m || seen.has(m.sourceId)) continue;
    seen.add(m.sourceId);
    out.push(m);
  }
  return out;
}

/* ============================== the queue ============================== */

const titleKey = (o) => `${str(o?.module).toLowerCase()}|${str(o?.title).toLowerCase()}`;

/** True if a finding is already a record (accepted or dismissed). Reads migrated and legacy records alike. */
export function hasRecord(records, sourceId) {
  const id = canonicalSourceId(sourceId);
  return arr(records).some((r) => canonicalSourceId(r?.sourceId ?? r?.detail?.sourceId) === id);
}

/**
 * The Opportunity Queue: every candidate the analyses currently support plus every stored record, matched by
 * sourceId (falling back to module + title, which survives index-based ids like "rec_3" changing between crawls).
 *   state     "Open" or the record's workflow status
 *   record    the stored record, if any (its text is what the user accepted — it is not rewritten under them)
 *   current   false when a record's finding no longer shows up in the latest analyses (fixed, or analysis re-run)
 *   stale     the record was made from an older crawl than the current one
 *   otherMarket  the record was made for a different target country than the site has now
 */
export function buildQueue(b, { auditIssues = [], describeEvidence, country } = {}) {
  const candidates = collectCandidates(b, { auditIssues, describeEvidence });
  const records = migrateOpportunities(b?.actions);
  const bySource = new Map(records.map((r) => [r.sourceId, r]));
  const byTitle = new Map(records.map((r) => [titleKey(r), r]));
  const crawl = b?.siteCrawl;
  const used = new Set();
  const items = [];

  const decorate = (base, record, current) => {
    const rec = record || null;
    return {
      ...(rec || base),
      state: rec ? rec.status : OPEN,
      record: rec,
      current,
      stale: !!rec && isStaleForCrawl(rec, crawl),
      otherMarket: !!rec && !!rec.country && !!country && rec.country !== country,
    };
  };

  for (const c of candidates) {
    let rec = bySource.get(c.sourceId) || null;
    if (!rec) { const t = byTitle.get(titleKey(c)); if (t && !used.has(t.id)) rec = t; }
    if (rec) used.add(rec.id);
    items.push(decorate(c, rec, true));
  }
  for (const r of records) if (!used.has(r.id)) items.push(decorate(r, r, false));
  return items.sort(compareOpportunities);
}

/** Which tab of the queue an item belongs to: open (needs a decision), workflow (accepted, not finished),
 *  done (marked done / verified) or dismissed (rejected). The one definition the screens and counts share. */
export function groupOf(item) {
  if (!item || item.state === OPEN || !item.record) return "open";
  if (item.state === "Rejected") return "dismissed";
  if (item.state === "Applied" || item.state === "Verified") return "done";
  return "workflow";
}

/** Header counts for the queue and the action center. */
export function summarizeQueue(items) {
  const list = arr(items);
  const n = (g) => list.filter((i) => groupOf(i) === g).length;
  return { open: n("open"), inWorkflow: n("workflow"), done: n("done"), dismissed: n("dismissed"), total: list.length };
}
