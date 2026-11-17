// Pages worth refreshing, found from Search Console's current vs previous period plus the crawl (pure, client-safe).
// Tests: tests/contentRefresh.test.mjs. Everything is observed data: no AI guesses which pages are "stale".
//
// A page is a refresh candidate when, compared with the previous period of the same length, it
//   - lost 30%+ of its clicks (with enough clicks before to mean something), or
//   - lost 30%+ of its impressions, or
//   - slipped 3+ average positions while still being shown a lot, or
// and separately when it is thin (under 500 words) yet already gets impressions, so there is something to build on.

import { pageKey } from "./gscAnalysis.js";
import { queriesForPage } from "./searchTools.js";

const scaled = (n, days) => Math.max(1, Math.round((n * days) / 28));
const pathOf = (u) => { try { const x = new URL(u); return (x.pathname + x.search) || "/"; } catch { return String(u || ""); } };
const pct = (n) => `${Math.round(n * 100)}%`;
export const THIN_WORDS = 500;

export function refreshCandidates(report, crawl, { limit = 12 } = {}) {
  const days = report?.days || 28;
  const crawled = new Map((crawl?.pages || []).map((p) => [pageKey(p.url), p]));
  const prev = new Map((report?.previousPages || []).map((r) => [pageKey(r.page), r]));
  const rows = [];
  for (const cur of report?.pages || []) {
    const k = pageKey(cur.page);
    const before = prev.get(k);
    const cp = crawled.get(k);
    const reasons = [];
    let weight = 0;
    if (before) {
      const lostClicks = before.clicks - cur.clicks;
      if (before.clicks >= scaled(10, days) && lostClicks / before.clicks >= 0.3) { reasons.push({ kind: "clicks", text: `Clicks fell ${pct(lostClicks / before.clicks)} (${before.clicks} to ${cur.clicks})` }); weight += lostClicks * 2; }
      const lostImpr = before.impressions - cur.impressions;
      if (before.impressions >= scaled(100, days) && lostImpr / before.impressions >= 0.3) { reasons.push({ kind: "impressions", text: `Impressions fell ${pct(lostImpr / before.impressions)} (${before.impressions.toLocaleString("en-US")} to ${cur.impressions.toLocaleString("en-US")})` }); weight += lostImpr / 50; }
      if (before.position && cur.position - before.position >= 3 && cur.impressions >= scaled(100, days)) { reasons.push({ kind: "position", text: `Average position slipped from ${before.position.toFixed(1)} to ${cur.position.toFixed(1)}` }); weight += (cur.position - before.position) * 3; }
    }
    if (cp && cp.wordCount > 0 && cp.wordCount < THIN_WORDS && cur.impressions >= scaled(50, days)) { reasons.push({ kind: "thin", text: `Only ${cp.wordCount} words, yet shown ${cur.impressions.toLocaleString("en-US")} times` }); weight += 5; }
    if (!reasons.length) continue;
    const queries = queriesForPage(report, cur.page, 5);
    rows.push({
      page: cur.page, path: pathOf(cur.page), title: cp?.title || pathOf(cur.page), wordCount: cp?.wordCount || 0,
      clicks: cur.clicks, prevClicks: before?.clicks ?? null, impressions: cur.impressions, prevImpressions: before?.impressions ?? null,
      position: cur.position, prevPosition: before?.position ?? null, reasons, weight,
      topQueries: queries.map((q) => ({ query: q.query, impressions: q.impressions, position: q.position })), primaryQuery: queries[0]?.query || "",
    });
  }
  return rows.sort((a, b) => b.weight - a.weight).slice(0, limit);
}

/** Thin pages from the crawl alone, for sites without Search Console connected. */
export function thinPages(crawl, { limit = 8 } = {}) {
  return (crawl?.pages || []).filter((p) => p.wordCount > 0 && p.wordCount < THIN_WORDS && p.title)
    .sort((a, b) => a.wordCount - b.wordCount).slice(0, limit)
    .map((p) => ({ page: p.url, path: pathOf(p.url), title: p.title, wordCount: p.wordCount, reasons: [{ kind: "thin", text: `Only ${p.wordCount} words` }], topQueries: [], primaryQuery: "", weight: 0, clicks: null, impressions: null }));
}

const evidence = (c) => c.reasons.map((r) => r.text).join("; ") + (c.topQueries.length ? `. Top queries: ${c.topQueries.slice(0, 3).map((q) => `"${q.query}"`).join(", ")}` : "");

/** An unscheduled blue topic in the Content Planner for updating this page. Marked as yours, so a regenerate never replaces it. */
export function contentIdeaFromRefresh(c, id, websiteId) {
  return {
    id, websiteId, internalLinks: 0, status: "Idea",
    title: `Refresh: ${c.title}`.slice(0, 140), primaryKeyword: c.primaryQuery || "", secondaryKeywords: c.topQueries.slice(1, 5).map((q) => q.query), intent: "Informational",
    funnel: "", pillar: "", format: "", scheduledFor: "", internalLinkTargets: [c.page],
    angle: "Update the existing page instead of writing a new one: check every fact and date, answer the queries below more directly, add what competitors now cover, and improve the title and intro.",
    grounding: { id: "Q0", kind: "Q", text: c.path, note: evidence(c) },
    questions: [], outline: [], aeoRecs: "", geoRecs: "", rationale: evidence(c), source: "Content refresh",
  };
}

export function fixRecForRefresh(c) {
  return {
    title: `Refresh ${c.path}`, evidence: `${evidence(c)} (Search Console and crawl, observed.)`,
    recommendedAction: `Update this page rather than replacing it: verify facts, dates and prices; answer ${c.primaryQuery ? `"${c.primaryQuery}"` : "its top queries"} directly near the top; ${c.wordCount && c.wordCount < THIN_WORDS ? "expand the thin sections with concrete detail and examples; " : ""}refresh the title and meta description; add internal links from newer related pages.`,
    module: "Content refresh", source: "Search Console + crawl (observed)", actionType: "Content Update", priority: c.reasons.some((r) => r.kind === "clicks") ? "High" : "Medium", urls: [c.page],
  };
}
