// Collects everything the client-ready report shows from one website's saved data (pure, client-safe).
// Tests: tests/clientReport.test.mjs. Nothing is invented: every number comes from the saved crawl, Search Console report,
// PageSpeed tests, planner, Local SEO data or Action Center, and each section states where it came from and when.

import { computeAuditIssuesForMarket } from "./auditIssues.js";
import { evaluatePlaybook } from "./playbook.js";
import { enrichQueries, filterQueries } from "./searchTools.js";
import { refreshCandidates } from "./contentRefresh.js";
import { ideaStage } from "./contentIdeas.js";
import { runLocalChecks, checklistProgress, parseAreas } from "./localSeo.js";
import { buildOpportunityQueue, filterQueue } from "./opportunityQueue.js";
import { weakVitals, fmtMetric, METRIC_LABEL } from "./pagespeed.js";

export const REPORT_SECTIONS = [
  { id: "summary", label: "Summary" },
  { id: "playbook", label: "Playbook scorecard" },
  { id: "search", label: "Search performance" },
  { id: "issues", label: "Issues found" },
  { id: "vitals", label: "Page speed (Core Web Vitals)" },
  { id: "content", label: "Content" },
  { id: "local", label: "Local SEO" },
  { id: "nextSteps", label: "Recommended next steps" },
];
export const DEFAULT_REPORT_SETTINGS = { preparedBy: "", clientName: "", notes: "", sections: Object.fromEntries(REPORT_SECTIONS.map((s) => [s.id, true])) };

const SEV = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search || "/"; } catch { return String(u || ""); } };
const pctChange = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

export const cleanReportSettings = (s) => ({
  preparedBy: String(s?.preparedBy || "").replace(/\s+/g, " ").trim().slice(0, 80),
  clientName: String(s?.clientName || "").replace(/\s+/g, " ").trim().slice(0, 80),
  notes: String(s?.notes || "").trim().slice(0, 1500),
  sections: Object.fromEntries(REPORT_SECTIONS.map((x) => [x.id, s?.sections?.[x.id] !== false])),
});

export function buildReportData(b, site = {}, { now = new Date(), country = "Worldwide", settings } = {}) {
  const st = cleanReportSettings(settings || b?.reportSettings);
  const crawl = b?.siteCrawl || null;
  const pages = crawl?.pages || [];
  const gsc = b?.gscReport || null;
  const domain = String(site.url || crawl?.domain || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const issues = pages.length ? computeAuditIssuesForMarket(crawl, country, { gscReport: gsc }) : [];
  const sevCounts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const i of issues) if (i.severity in sevCounts) sevCounts[i.severity] += 1;
  const topIssues = [...issues].sort((a, b2) => (SEV[a.severity] ?? 9) - (SEV[b2.severity] ?? 9) || (b2.urls?.length || 0) - (a.urls?.length || 0)).slice(0, 8)
    .map((i) => ({ severity: i.severity, category: i.category, title: i.title, why: i.why || "", fix: i.fix || "", pages: (i.urls || []).length }));

  const playbook = evaluatePlaybook(b, { country });

  // Search performance
  let search = { has: false };
  if (gsc?.totals) {
    const t = gsc.totals, p = gsc.previousTotals || null;
    const rows = enrichQueries(gsc, { tracked: (b?.keywords || []).map((k) => k.keyword) });
    search = {
      has: true, days: gsc.days, property: gsc.property, fetchedAt: gsc.fetchedAt, range: gsc.range, previousRange: gsc.previousRange,
      totals: { clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position },
      previous: p ? { clicks: p.clicks, impressions: p.impressions, ctr: p.ctr, position: p.position } : null,
      change: p ? { clicks: pctChange(t.clicks, p.clicks), impressions: pctChange(t.impressions, p.impressions) } : null,
      topQueries: rows.slice(0, 8).map((r) => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, position: r.position })),
      quickWins: filterQueries(rows, "quickWin").slice(0, 6).map((r) => ({ query: r.query, impressions: r.impressions, position: r.position, page: r.topPage ? pathOf(r.topPage) : "" })),
      refresh: refreshCandidates(gsc, crawl, { limit: 5 }).map((c) => ({ path: c.path, title: c.title, reasons: c.reasons.map((r) => r.text) })),
    };
  }

  // Core Web Vitals (latest mobile test per page; falls back to any device)
  const all = b?.pageSpeed || [];
  const mobile = all.filter((r) => r.strategy === "mobile");
  const vitals = (mobile.length ? mobile : all).slice(0, 6).map((r) => ({
    path: pathOf(r.url), strategy: r.strategy, score: r.score, testedAt: r.fetchedAt, basis: r.field ? "real users" : "lab test",
    weak: weakVitals(r).map((w) => `${METRIC_LABEL[w.metric].split(" (")[0]} ${fmtMetric(w.metric, w.value)} (${w.rating})`),
  }));

  // Content
  const ideas = b?.contentIdeas || [];
  const counts = { idea: 0, draft: 0, published: 0 };
  for (const c of ideas) counts[ideaStage(c)] += 1;
  const upcoming = ideas.filter((c) => ideaStage(c) !== "published" && /^\d{4}-\d{2}-\d{2}$/.test(c.scheduledFor || "")).sort((a, b2) => a.scheduledFor.localeCompare(b2.scheduledFor)).slice(0, 6).map((c) => ({ title: c.title, date: c.scheduledFor, stage: ideaStage(c) }));
  const publishedNow = ideas.filter((c) => ideaStage(c) === "published").slice(-6).map((c) => c.title);

  // Local
  const lr = pages.length ? runLocalChecks(crawl, b?.localProfile) : null;
  const prog = checklistProgress(b?.localChecklist || {});
  const areas = lr?.areas || [];
  const local = {
    has: !!(lr && !lr.needsProfile) || prog.done > 0,
    checks: lr ? lr.checks.filter((c) => c.status !== "info").map((c) => ({ status: c.status, title: c.title })) : [],
    checklist: prog, areas: areas.map((a) => ({ area: a.area, status: a.status })), areasConfigured: parseAreas(b?.localProfile?.areas).length,
  };

  const queue = filterQueue(buildOpportunityQueue(b, { country }), { states: ["new", "in_actions"] }).slice(0, 6);
  const nextSteps = queue.map((o) => ({ priority: o.priority, title: o.title, action: o.recommendedAction || "" }));

  // Highlights: only what the data shows
  const highlights = [];
  if (search.has && search.change) {
    const { clicks, impressions } = search.change;
    if (clicks !== null) highlights.push({ kind: clicks >= 0 ? "win" : "watch", text: `Clicks from Google ${clicks >= 0 ? "up" : "down"} ${Math.abs(clicks)}% (${search.previous.clicks.toLocaleString("en-US")} to ${search.totals.clicks.toLocaleString("en-US")}) compared with the previous ${search.days} days.` });
    if (impressions !== null) highlights.push({ kind: impressions >= 0 ? "win" : "watch", text: `Impressions ${impressions >= 0 ? "up" : "down"} ${Math.abs(impressions)}% (${search.previous.impressions.toLocaleString("en-US")} to ${search.totals.impressions.toLocaleString("en-US")}).` });
  }
  const done = (b?.actions || []).filter((a) => a.status === "Applied" || a.status === "Verified").length;
  if (done > 0) highlights.push({ kind: "win", text: `${done} recommended ${done === 1 ? "fix has" : "fixes have"} been marked done.` });
  if (counts.published > 0) highlights.push({ kind: "win", text: `${counts.published} content ${counts.published === 1 ? "topic is" : "topics are"} marked published.` });
  if (sevCounts.Critical > 0) highlights.push({ kind: "watch", text: `${sevCounts.Critical} critical ${sevCounts.Critical === 1 ? "issue needs" : "issues need"} attention.` });

  return {
    meta: { siteName: site.name || domain, domain, generatedAt: now.toISOString(), preparedBy: st.preparedBy, clientName: st.clientName, notes: st.notes, country },
    sections: st.sections,
    summary: { pagesCrawled: pages.length, crawledAt: crawl?.crawledAt || null, severity: sevCounts, totalIssues: issues.length, technicalScore: crawl?.siteScores?.technical ?? null, contentScore: crawl?.siteScores?.content ?? null },
    playbook: { overall: playbook.overall, groups: playbook.groups.map((g) => ({ title: g.title, score: g.score, measured: g.measured, total: g.total, unknown: g.unknown, weak: g.items.filter((i) => i.status === "fail" || i.status === "warn").slice(0, 3).map((i) => i.text) })) },
    search, issues: topIssues, vitals, content: { counts, upcoming, publishedNow, total: ideas.length }, local, competitors: (b?.competitors || []).map((c) => c.name).slice(0, 8),
    nextSteps, highlights,
    sources: [
      crawl ? `Site crawl of ${pages.length} pages${crawl.crawledAt ? ` on ${crawl.crawledAt.slice(0, 10)}` : ""}.` : "",
      search.has ? `Google Search Console, last ${search.days} days (fetched ${String(search.fetchedAt || "").slice(0, 10)}), compared with the previous ${search.days} days.` : "",
      vitals.length ? `Google PageSpeed Insights tests (${vitals.length} ${vitals.length === 1 ? "page" : "pages"}).` : "",
    ].filter(Boolean),
  };
}
