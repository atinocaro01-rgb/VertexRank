// Things you can DO with Search Console query data (pure, client-safe). Tests: tests/searchTools.test.mjs.
//
// Everything here reads what Search Console reported: clicks, impressions, CTR, average position, and which page each query was
// seen on. The labels ("quick win", "low CTR", "pages compete") are simple rules over those numbers, not AI guesses and not
// promises of results.

import { ctrModel, pageKey } from "./gscAnalysis.js";

const scaled = (n, days) => Math.max(1, Math.round((n * days) / 28));
const QUESTION = /^(who|what|when|where|why|how|which|can|could|does|do|did|is|are|was|were|should|will|would|has|have)\b/i;
const pathOf = (u) => { try { const x = new URL(u); return (x.pathname + x.search) || "/"; } catch { return String(u || ""); } };

export const QUERY_FILTERS = [
  { id: "all", label: "All", hint: "Every query in the report." },
  { id: "quickWin", label: "Quick wins", hint: "Average position 4–20 with real impressions: close enough to page one (or the top of it) that improving the page can pay off." },
  { id: "lowCtr", label: "Low CTR", hint: "Ranking on page one but clicked less than your own typical rate at that position: rewrite the title and meta description." },
  { id: "question", label: "Questions", hint: "Searched as a question: good FAQ entries and article topics." },
  { id: "compete", label: "Pages compete", hint: "More than one of your pages shows for the same query: consider merging or clearly separating them." },
  { id: "notTracked", label: "Not tracked yet", hint: "Not in your tracked keywords." },
];

/** Adds the labels above and the pages each query shows on. Returns rows sorted by impressions. */
export function enrichQueries(report, { tracked = [] } = {}) {
  const days = report?.days || 28;
  const model = ctrModel(report || { queries: [] });
  const have = new Set((tracked || []).map((k) => String(k || "").toLowerCase().trim()));
  const byQuery = new Map();
  for (const r of report?.queryPages || []) {
    const k = String(r.query || "").toLowerCase();
    if (!byQuery.has(k)) byQuery.set(k, []);
    byQuery.get(k).push(r);
  }
  return (report?.queries || []).filter((q) => q?.query).map((q) => {
    const seen = (byQuery.get(q.query.toLowerCase()) || []).slice().sort((a, b) => b.impressions - a.impressions);
    const pages = seen.map((r) => ({ page: r.page, impressions: r.impressions, clicks: r.clicks, position: r.position }));
    const expected = q.position ? model(q.position).ctr : 0;
    const quickWin = q.position >= 4 && q.position <= 20 && q.impressions >= scaled(30, days);
    const lowCtr = q.position > 0 && q.position <= 10 && q.impressions >= scaled(50, days) && expected > 0 && q.ctr < expected * 0.6;
    const meaningful = pages.filter((p) => p.impressions >= Math.max(scaled(10, days), q.impressions * 0.15));
    return {
      ...q, pages, topPage: pages[0]?.page || "",
      quickWin, lowCtr, expectedCtr: expected,
      isQuestion: QUESTION.test(q.query.trim()) || q.query.trim().endsWith("?"),
      compete: meaningful.length >= 2,
      tracked: have.has(q.query.toLowerCase().trim()),
    };
  }).sort((a, b) => b.impressions - a.impressions);
}

export function filterQueries(rows, filter, text = "") {
  const t = String(text || "").trim().toLowerCase();
  return (rows || []).filter((r) => {
    if (t && !r.query.toLowerCase().includes(t)) return false;
    switch (filter) {
      case "quickWin": return r.quickWin;
      case "lowCtr": return r.lowCtr;
      case "question": return r.isQuestion;
      case "compete": return r.compete;
      case "notTracked": return !r.tracked;
      default: return true;
    }
  });
}

const csvCell = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** A CSV of the given rows (query, clicks, impressions, CTR, position, top page). Opens fine in Excel and Google Sheets. */
export function queriesToCsv(rows) {
  const head = ["query", "clicks", "impressions", "ctr", "position", "top_page"];
  const lines = [head.join(",")];
  for (const r of rows || []) lines.push([r.query, r.clicks, r.impressions, `${((r.ctr || 0) * 100).toFixed(2)}%`, Number(r.position || 0).toFixed(1), r.topPage || ""].map(csvCell).join(","));
  return lines.join("\n");
}

/** The queries one page shows for, best first (what to use as its headings, FAQ and meta description wording). */
export function queriesForPage(report, page, limit = 15) {
  const k = pageKey(page);
  return (report?.queryPages || []).filter((r) => pageKey(r.page) === k).sort((a, b) => b.impressions - a.impressions).slice(0, limit);
}

const cap = (s) => String(s || "").trim().replace(/\s+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** A content-planner topic for a query: an unscheduled blue "Idea" you can edit, fill in with AI, and write. Not generated text. */
export function contentIdeaFromQuery(row, id, websiteId) {
  const q = String(row.query || "").trim();
  return {
    id, websiteId, internalLinks: 0, status: "Idea",
    title: cap(q), primaryKeyword: q.toLowerCase(), secondaryKeywords: [], intent: row.isQuestion ? "Informational" : "Informational",
    funnel: "", pillar: "", format: row.isQuestion ? "FAQ-led guide" : "", angle: "", internalLinkTargets: row.topPage ? [row.topPage] : [], scheduledFor: "",
    grounding: { id: "Q0", kind: "Q", text: q, note: `${row.impressions} impressions, ${row.clicks ?? 0} clicks, average position ${Number(row.position).toFixed(1)} (Search Console)` },
    questions: row.isQuestion ? [cap(q.replace(/\?*$/, "")) + "?"] : [], outline: [], aeoRecs: "", geoRecs: "",
    rationale: row.quickWin ? "Already shows in Google at positions 4–20: a dedicated, better page can move it up." : "People already search for this and your site is shown for it.",
    source: "Search Console query",
  };
}

/** The Generate-fix input for a query that already has a page: improve that page for the query. */
export function fixRecForQuery(row) {
  const page = row.topPage;
  const where = page ? ` on ${pathOf(page)}` : "";
  const why = row.lowCtr
    ? `Shown ${row.impressions.toLocaleString("en-US")} times at position ${Number(row.position).toFixed(1)} but clicked ${((row.ctr || 0) * 100).toFixed(1)}% of the time (your typical rate at this position is about ${((row.expectedCtr || 0) * 100).toFixed(1)}%).`
    : `Shown ${row.impressions.toLocaleString("en-US")} times at average position ${Number(row.position).toFixed(1)} with ${row.clicks ?? 0} clicks.`;
  return {
    title: row.lowCtr ? `Raise the click-through rate for "${row.query}"${where}` : `Improve the page for "${row.query}"${where}`,
    evidence: `${why} (Search Console, observed.)`,
    recommendedAction: row.lowCtr
      ? `Rewrite the title tag and meta description${where} so they match what someone searching "${row.query}" wants, lead with the benefit, and include the query naturally.`
      : `Make sure the page${where} answers "${row.query}" directly near the top, uses the query in the title, H1 and one subheading, and links to it from related pages.`,
    module: "Search data", source: "Search Console (observed)", actionType: "Content Update", priority: row.impressions >= 200 ? "High" : "Medium", urls: page ? [page] : [],
  };
}
