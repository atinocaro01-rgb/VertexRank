// The unified Opportunity Queue: one ranked list of everything VertexRank thinks is worth doing for a
// website, from every source — technical findings, market (country) checks, keyword, AEO, GEO / AI
// visibility, competitor gaps, internal links and content ideas. Pure functions of the saved workspace
// (no React, no network), unit-tested in tests/opportunityQueue.test.mjs.
//
// What each opportunity carries: a stable canonical id, a type, evidence, a recommended action, a priority,
// a confidence, a transparent score (see scoreOf), the Action Center status it maps to, and — where
// relevant — the market (country) it was computed for.
//
// IDs: modules used to add items to the Action Center with their own ad-hoc `sourceId`s (and the old
// "Unified AI Recommendations" list used a third scheme), so the same opportunity could be added twice
// from two screens. Every opportunity therefore has ONE canonical id plus `legacyIds` (what older code
// used), and anything matching any of them counts as already added.

import { computeSiteAuditIssues } from "./auditIssues.js";
import { analyzeMarket } from "./marketChecks.js";
import { isWorldwide, normalizeCountry } from "./market.js";
import { isStaleForCrawl } from "./crawlState.js";
import { searchOpportunities } from "./gscAnalysis.js";

export const OPPORTUNITY_TYPES = {
  technical: { label: "Technical", order: 0 },
  market: { label: "Market / Location", order: 1 },
  search: { label: "Search data", order: 2 },
  keyword: { label: "Keywords", order: 3 },
  aeo: { label: "AEO", order: 4 },
  geo: { label: "GEO / AI Visibility", order: 5 },
  internal_link: { label: "Internal links", order: 6 },
  competitor: { label: "Competitors", order: 7 },
  content: { label: "Content ideas", order: 8 },
};

const PRIORITIES = ["Critical", "High", "Medium", "Low"];
const PRIORITY_POINTS = { Critical: 100, High: 75, Medium: 50, Low: 25 };
const CONFIDENCE_FACTOR = { High: 1, Medium: 0.85, Low: 0.7 };
const MAX_BREADTH_BONUS = 10;

const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : []);
const str = (v, max = 2000) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));
const slug = (v) => str(v, 200).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
const normPriority = (p) => PRIORITIES.find((x) => x.toLowerCase() === str(p).toLowerCase()) || "Medium";
const normConfidence = (c) => ["High", "Medium", "Low"].find((x) => x.toLowerCase() === str(c).toLowerCase()) || "Medium";
const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search || "/"; } catch { return str(u); } };

/* ------------------------------------------------------------------ */
/* ids                                                                */
/* ------------------------------------------------------------------ */

/**
 * Canonical id for an audit/market finding. Findings whose own ids are stable keep them; findings whose ids are
 * positional (rec_3, site_duptitle_0) get an id derived from what they describe, so they don't change between crawls.
 */
export function issueOpportunityId(issue) {
  const id = str(issue?.id);
  if (id.startsWith("mkt_")) return `mkt:${id}`;
  if (id.startsWith("tech_") || id === "site_orphan" || id === "site_weak") return `tech:${id}`;
  const base = id.replace(/_\d+$/, "");
  if (base === "rec") return `tech:rec:${slug(`${issue.category} ${issue.title}`)}`;
  return `tech:${base}:${slug([...(issue.urls || [])].sort().slice(0, 3).join("|") || issue.title)}`;
}

/** What older code used as the Action Center sourceId for an audit finding (only where that id was stable). */
export function issueLegacyIds(issue) {
  const id = str(issue?.id);
  return /_\d+$/.test(id) ? [] : [id];
}

/* ------------------------------------------------------------------ */
/* normalisers: one per source                                        */
/* ------------------------------------------------------------------ */

function fromIssues(issues, type) {
  return issues.map((i) => ({
    id: issueOpportunityId(i), legacyIds: issueLegacyIds(i), type,
    module: type === "market" ? "Market / Location" : "Site-wide Audit",
    title: str(i.title),
    evidence: i.urls?.length ? `Affects ${i.urls.length} URL${i.urls.length === 1 ? "" : "s"}: ${i.urls.slice(0, 3).join(", ")}${i.urls.length > 3 ? "…" : ""}` : str(i.why),
    why: str(i.why), recommendedAction: str(i.fix),
    priority: normPriority(i.severity), confidence: "High", source: "Crawled Data",
    actionType: i.category === "Content" ? "Content Update" : i.category === "Schema" ? "Schema Markup" : i.category === "On-Page" ? "Meta Fix" : i.category === "Internal Linking" ? "Internal Link" : "Technical Fix",
    urls: arr(i.urls).slice(0, 50), breadth: arr(i.urls).length,
  }));
}

function fromKeywords(data) {
  if (!data) return [];
  const out = [];
  arr(data.opportunities).forEach((o) => out.push({
    id: `kw:${o.id}`, legacyIds: [str(o.id), `uni_kw_${o.id}`], type: "keyword", module: "Site-wide Keyword Intelligence",
    title: str(o.problem), evidence: str(o.evidence), recommendedAction: str(o.recommendedAction),
    priority: normPriority(o.priority), confidence: normConfidence(o.confidence), source: str(o.source) || "VertexRank AI", actionType: "Content Update",
  }));
  arr(data.cannibalizationGuidance).forEach((g) => out.push({
    id: `cannib:${g.id}`, legacyIds: [str(g.id)], type: "keyword", module: "Site-wide Keyword Intelligence",
    title: `${str(g.recommendedAction)} competing pages`, evidence: str(g.explanation), recommendedAction: str(g.reasoning),
    priority: "High", confidence: "Medium", source: str(g.source) || "VertexRank AI", actionType: "Content Update",
  }));
  return out;
}

function fromAeo(data) {
  if (!data) return [];
  const out = [];
  arr(data.contentRecommendations).forEach((r) => out.push({
    id: `aeo:rec:${r.id}`, legacyIds: [`saeor_${r.id}`, `uni_aeo_${r.id}`], type: "aeo", module: "Site-wide AEO",
    title: str(r.recommendation), evidence: str(r.why), recommendedAction: str(r.recommendation),
    priority: normPriority(r.priority), confidence: "Medium", source: str(r.source) || "VertexRank AI", actionType: "Content Update",
  }));
  arr(data.questions).filter((q) => str(q.coverage) !== "Answered").forEach((q) => out.push({
    id: `aeo:q:${q.id}`, legacyIds: [`saeoq_${q.id}`], type: "aeo", module: "Site-wide AEO",
    title: `Answer: "${str(q.question)}"`, evidence: str(q.missingInfo), recommendedAction: str(q.recommendedAnswer),
    priority: normPriority(q.priority), confidence: "Medium", source: str(q.source) || "VertexRank AI", actionType: "FAQ Addition",
  }));
  arr(data.weakestPages).filter((p) => arr(p.fixes).length > 0).forEach((p) => out.push({
    id: `aeo:page:${p.url}`, legacyIds: [`saeop_${p.url}`], type: "aeo", module: "Site-wide AEO",
    title: `Improve AEO on: ${str(p.title) || pathOf(p.url)}`,
    evidence: `Scores ${p.score}/100 on the AEO signal checklist (${p.url}).`,
    recommendedAction: arr(p.fixes).map((f) => `${f.label} (+${f.points}): ${f.action}`).join("\n"),
    priority: normPriority(p.priority), confidence: "High", source: "VertexRank crawl signals", actionType: "Content Update", urls: [p.url],
  }));
  return out;
}

function fromGeo(geo, simulation) {
  const out = [];
  arr(geo?.opportunities).forEach((o) => out.push({
    id: `geo:${o.id}`, legacyIds: [`sgeoo_${o.id}`, `uni_geo_${o.id}`], type: "geo", module: "Site-wide GEO",
    title: str(o.title), evidence: str(o.why), recommendedAction: str(o.title),
    priority: normPriority(o.priority), confidence: "Medium", source: str(o.source) || "VertexRank AI", actionType: "Schema Markup",
  }));
  arr(simulation?.questions).filter((q) => str(q.answerReadiness) !== "Strong").forEach((q) => out.push({
    id: `sim:${q.id}`, legacyIds: [`sim_${q.id}`], type: "geo", module: "AI Visibility Simulator",
    title: `Be a better answer to: "${str(q.query)}"`, evidence: str(q.missingInfo), recommendedAction: str(q.recommendedImprovement),
    priority: str(q.answerReadiness) === "Weak" ? "High" : "Medium", confidence: "Medium", source: "VertexRank AI Visibility Simulation", actionType: "Schema Markup",
  }));
  return out;
}

function fromCompetitors(competitors, crawl) {
  const out = [];
  for (const c of arr(competitors)) {
    const interp = c?.siteAnalysis?.interpretation;
    if (!interp) continue;
    // A comparison made against an earlier crawl of OUR site is less trustworthy: keep it, flag it, rank it lower.
    const stale = isStaleForCrawl(c.siteAnalysis, crawl);
    const note = stale ? "Compared against an earlier crawl of your site — re-analyze this competitor to refresh." : undefined;
    const base = { type: "competitor", confidence: stale ? "Low" : "Medium", note, competitor: str(c.name) };
    arr(interp.gaps).forEach((g) => out.push({
      ...base, id: `comp:${c.id}:${g.id}`, legacyIds: [`${c.id}_${g.id}`], module: `Competitor: ${str(c.name)}`,
      title: str(g.gap), evidence: str(g.evidence), recommendedAction: str(g.recommendedAction),
      priority: normPriority(g.priority), source: str(g.source) || "Competitor comparison", actionType: "Content Update",
    }));
    arr(interp.aeoGeoDifferences).forEach((d) => out.push({
      ...base, id: `comp:${c.id}:${d.id}`, legacyIds: [`${c.id}_${d.id}`], module: `Competitor: ${str(c.name)} (AEO/GEO)`,
      title: str(d.difference), evidence: "", recommendedAction: str(d.recommendedAction),
      priority: normPriority(d.priority), source: str(d.source) || "Competitor comparison", actionType: "Schema Markup",
    }));
  }
  return out;
}

/** Search Console opportunities. A report older than two weeks is kept but demoted and labelled: search data goes stale. */
function fromSearch(report, crawl, nowMs) {
  if (!report) return [];
  const ageDays = Math.floor((nowMs - Date.parse(report.fetchedAt || "")) / 86400000);
  const stale = Number.isFinite(ageDays) && ageDays > 14;
  return searchOpportunities(report, crawl, { host: crawl?.domain }).map((o) => (stale ? { ...o, confidence: "Low", note: `Search data is ${ageDays} days old (${report.range?.startDate} to ${report.range?.endDate}). Refresh the Search data report to update this.` } : o));
}

function fromInternalLinks(recs, crawl, tracked) {
  if (!recs) return [];
  const orphans = new Set(arr(crawl?.siteWide?.orphanPages));
  return arr(recs.recommendations).filter((r) => arr(r.links).length > 0).map((r) => {
    const orphan = orphans.has(r.targetUrl);
    const links = arr(r.links);
    const trackedCount = links.filter((l) => arr(tracked).some((t) => t.source === l.fromUrl && t.target === r.targetUrl)).length;
    const appliedCount = links.filter((l) => arr(tracked).some((t) => t.source === l.fromUrl && t.target === r.targetUrl && t.status === "Applied")).length;
    return {
      id: `link:${r.targetUrl}`, legacyIds: [], type: "internal_link", module: "Internal Linking",
      title: `Add internal links to ${pathOf(r.targetUrl)}`,
      evidence: orphan ? "Orphan page: no other crawled page links to it." : "Weakly linked: only one other crawled page links to it.",
      recommendedAction: links.slice(0, 3).map((l) => `Link from ${pathOf(l.fromUrl)} with anchor "${str(l.anchorText)}" — ${str(l.reason)}`).join("\n"),
      priority: orphan ? "Medium" : "Low", confidence: "Medium", source: "Crawled link graph + VertexRank AI", actionType: "Internal Link",
      urls: [r.targetUrl, ...links.map((l) => l.fromUrl)].slice(0, 10), breadth: 1,
      tracking: { total: links.length, tracked: trackedCount, applied: appliedCount },
    };
  });
}

function fromContentIdeas(ideas) {
  return arr(ideas).filter((c) => str(c.status) === "Idea").map((c) => ({
    id: `content:${c.id}`, legacyIds: [], type: "content", module: "Content Planner",
    title: `Create: ${str(c.title)}`,
    evidence: [str(c.primaryKeyword) && `Primary keyword: ${str(c.primaryKeyword)}`, str(c.intent) && `Intent: ${str(c.intent)}`, arr(c.questions).length && `${arr(c.questions).length} question${arr(c.questions).length === 1 ? "" : "s"} to answer`].filter(Boolean).join(" · "),
    recommendedAction: arr(c.outline).length ? `Outline: ${arr(c.outline).slice(0, 5).join(" → ")}` : `Write and publish "${str(c.title)}".`,
    priority: "Medium", confidence: "Medium", source: "Content Planner", actionType: "Content Update",
  }));
}

/* ------------------------------------------------------------------ */
/* scoring, dedupe, action state                                      */
/* ------------------------------------------------------------------ */

/** score = priority points × confidence factor + a small bonus for how many URLs are affected (technical/market only). */
export function scoreOf(o) {
  const points = PRIORITY_POINTS[o.priority] ?? PRIORITY_POINTS.Medium;
  const factor = CONFIDENCE_FACTOR[o.confidence] ?? CONFIDENCE_FACTOR.Medium;
  const bonus = Math.min(MAX_BREADTH_BONUS, o.breadth || 0);
  return {
    score: Math.round(points * factor + bonus),
    explanation: `${o.priority} priority (${points}) × ${o.confidence} confidence (${factor})${bonus ? ` + ${bonus} for ${o.bonusLabel || `affecting ${o.breadth} URL${o.breadth === 1 ? "" : "s"}`}` : ""}`,
  };
}

const titleKey = (t) => str(t).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
export const opportunityIds = (o) => [o.id, ...arr(o.legacyIds), ...arr(o.aliases)];

/** The Action Center item (if any) created from this opportunity under any of its ids. */
export function findAction(actions, o) {
  const ids = new Set(opportunityIds(o));
  return arr(actions).find((a) => ids.has(a?.detail?.sourceId)) || null;
}
export const isOpportunityAdded = (actions, o) => !!findAction(actions, o);

function stateOf(o, actions) {
  const a = findAction(actions, o);
  if (a) {
    if (a.status === "Applied" || a.status === "Verified") return { state: "done", actionId: a.id, actionStatus: a.status };
    if (a.status === "Rejected") return { state: "rejected", actionId: a.id, actionStatus: a.status };
    return { state: "in_actions", actionId: a.id, actionStatus: a.status };
  }
  if (o.tracking?.total > 0 && o.tracking.applied === o.tracking.total) return { state: "done" };
  if (o.tracking?.total > 0 && o.tracking.tracked === o.tracking.total) return { state: "in_actions", actionStatus: "Tracked in Internal Links" };
  return { state: "new" };
}

/**
 * Builds the queue for one website bundle.
 * opts.country: the website's selected market (adds market checks; flags AI results computed for another market).
 * opts.limit:   keep only the top N (after sorting).
 */
export function buildOpportunityQueue(b, { country, limit = Infinity, nowMs = Date.now() } = {}) {
  if (!b) return [];
  const market = normalizeCountry(country);
  const crawl = b.siteCrawl || null;

  const auditIssues = crawl?.siteWide ? computeSiteAuditIssues(crawl) : [];
  const marketIssues = crawl ? analyzeMarket(crawl, market) : [];

  const raw = [
    ...fromIssues(auditIssues, "technical"),
    ...fromIssues(marketIssues, "market").map((o) => ({ ...o, market })),
    // AI analyses carry the market they were computed for (stamped when stored); results from before market
    // targeting existed carry none and are treated as market-neutral.
    ...fromSearch(b.gscReport, crawl, nowMs),
    ...fromKeywords(b.siteKeywordClusters).map((o) => ({ ...o, market: b.siteKeywordClusters?.market })),
    ...fromAeo(b.siteAeoAnalysis).map((o) => ({ ...o, market: b.siteAeoAnalysis?.market })),
    ...fromGeo(b.siteGeoAnalysis, b.aiVisibility).map((o) => ({ ...o, market: (o.id.startsWith("sim:") ? b.aiVisibility : b.siteGeoAnalysis)?.market || (o.id.startsWith("sim:") ? b.aiVisibility?.country : undefined) })),
    ...fromCompetitors(b.competitors, crawl),
    ...fromInternalLinks(b.internalLinkRecs, crawl, b.internalLinks),
    ...fromContentIdeas(b.contentIdeas),
  ].filter((o) => o.title);

  const scored = raw.map((o) => {
    let item = { ...o, aliases: [] };
    // An AI result written for a different market than the one now selected is less trustworthy: keep it, flag it.
    if (!isWorldwide(market) && o.market && normalizeCountry(o.market) !== market && o.type !== "market" && o.type !== "technical") {
      item.confidence = "Low";
      item.note = `Written for ${o.market}; the selected market is ${market}. Re-run this analysis to refresh it.`;
      item.marketMismatch = true;
    }
    return { ...item, ...scoreOf(item) };
  });

  // Same opportunity surfaced by two sources (identical normalised title): keep the stronger one and remember the other's ids.
  const byTitle = new Map();
  for (const o of scored) {
    const k = titleKey(o.title);
    const prev = byTitle.get(k);
    if (!prev) { byTitle.set(k, o); continue; }
    const [keep, drop] = o.score > prev.score ? [o, prev] : [prev, o];
    keep.aliases = [...keep.aliases, ...opportunityIds(drop)];
    keep.alsoFrom = [...(keep.alsoFrom || []), drop.module];
    byTitle.set(k, keep);
  }

  const withState = [...byTitle.values()].map((o) => ({ ...o, ...stateOf(o, b.actions) }));
  withState.sort((a, c) => c.score - a.score || OPPORTUNITY_TYPES[a.type].order - OPPORTUNITY_TYPES[c.type].order || a.title.localeCompare(c.title));
  return withState.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* filtering and summaries (used by the UI)                           */
/* ------------------------------------------------------------------ */

/** states: which of new|in_actions|done|rejected to show (default: new + in_actions — i.e. not yet finished). */
export function filterQueue(queue, { types, priorities, states = ["new", "in_actions"], search = "" } = {}) {
  const q = str(search).toLowerCase();
  return arr(queue).filter((o) =>
    (!types?.length || types.includes(o.type)) &&
    (!priorities?.length || priorities.includes(o.priority)) &&
    (!states?.length || states.includes(o.state)) &&
    (!q || `${o.title} ${o.evidence} ${o.recommendedAction} ${o.module}`.toLowerCase().includes(q))
  );
}

export function summarizeQueue(queue) {
  const list = arr(queue);
  const count = (fn) => list.filter(fn).length;
  return {
    total: list.length,
    open: count((o) => o.state === "new"),
    inActions: count((o) => o.state === "in_actions"),
    done: count((o) => o.state === "done"),
    byType: Object.fromEntries(Object.keys(OPPORTUNITY_TYPES).map((t) => [t, count((o) => o.type === t && (o.state === "new" || o.state === "in_actions"))])),
    byPriority: Object.fromEntries(PRIORITIES.map((p) => [p, count((o) => o.priority === p && o.state === "new")])),
  };
}
