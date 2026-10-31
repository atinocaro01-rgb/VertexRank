// Turns a Search Console report (lib/gscReport.js) into concrete, ranked opportunities for the Opportunity Queue.
// Pure and deterministic: no AI, no network. Unit-tested in tests/gscAnalysis.test.mjs.
//
// What is OBSERVED (straight from Search Console): impressions, clicks, CTR, average position, per query and page.
// What is an ESTIMATE: "extra clicks if this improved". Estimates compare a page with what the SITE'S OWN data shows is
// typical at that position (its median CTR for queries in the same position bucket), falling back to a rough generic CTR
// curve only when the site has too little data. They are labelled as estimates and never promises.
//
// Thresholds scale with the report length (a 90-day report needs roughly 3x the impressions of a 28-day one to be
// equally "meaningful"), so the same rules work for 7, 28, 90 and 180 days.

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const pathOf = (u) => { try { const x = new URL(u); return (x.pathname + x.search) || "/"; } catch { return String(u); } };
const pct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const stripHost = (h) => h.replace(/^www\./i, "").toLowerCase();

/** URL identity for comparing a Search Console page with a crawled page: ignores hash, protocol, www and trailing slash. */
export function pageKey(u) {
  try {
    const x = new URL(u);
    const p = x.pathname.length > 1 ? x.pathname.replace(/\/+$/, "") : "/";
    return `${stripHost(x.host)}${p}${x.search}`;
  } catch { return String(u || "").toLowerCase(); }
}

// Rough, widely-cited CTR by position. ONLY a fallback when a site has too little data of its own.
const GENERIC_CTR = { 1: 0.28, 2: 0.15, 3: 0.1, 4: 0.07, 5: 0.055, 6: 0.045, 7: 0.035, 8: 0.03, 9: 0.025, 10: 0.02 };
const genericCtr = (pos) => GENERIC_CTR[Math.min(10, Math.max(1, Math.round(pos)))] ?? (pos <= 20 ? 0.01 : 0.004);

/** The scale factor for thresholds written for a 28-day report. */
const scaled = (n, days) => Math.max(1, Math.round((n * days) / 28));

/**
 * Builds a function position -> { ctr, basis } using the site's own queries (median CTR of queries in the same rounded
 * position bucket, needing at least 5 of them) and the generic curve otherwise.
 */
export function ctrModel(report) {
  const minImpr = scaled(20, report.days || 28);
  const buckets = new Map();
  for (const q of report.queries || []) {
    if (q.impressions < minImpr || !q.position) continue;
    const b = Math.min(20, Math.max(1, Math.round(q.position)));
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(q.ctr);
  }
  return (position) => {
    const b = Math.min(20, Math.max(1, Math.round(position)));
    const own = buckets.get(b);
    if (own && own.length >= 5) return { ctr: median(own), basis: "your own queries at this position" };
    return { ctr: genericCtr(position), basis: "a rough generic benchmark (too little data of your own at this position)" };
  };
}

const priorityFor = (gain, days) => (gain >= scaled(100, days) ? "High" : gain >= scaled(30, days) ? "Medium" : "Low");
const bonus = (gain, days) => Math.min(10, Math.ceil(gain / scaled(20, days)));

function topQueriesFor(report, page) {
  const k = pageKey(page);
  return (report.queryPages || []).filter((r) => pageKey(r.page) === k).sort((a, b) => b.impressions - a.impressions).slice(0, 5).map((r) => r.query);
}

/**
 * Returns opportunities (the queue's raw shape) for a report. `crawl` (optional) enables the "no impressions" check.
 * Every opportunity: { id, legacyIds, type:"search", module, title, evidence, recommendedAction, priority, confidence,
 * source, actionType, urls, breadth, bonusLabel?, prIssue? }.
 */
export function searchOpportunities(rawReport, crawl = null, { host } = {}) {
  if (!rawReport || !Array.isArray(rawReport.queries)) return [];
  // A domain property covers every subdomain; judge only the pages of the website being analysed.
  const wanted = host ? stripHost(String(host)) : null;
  const onHost = (u) => { try { return stripHost(new URL(u).host) === wanted; } catch { return false; } };
  const report = wanted && String(rawReport.property || "").startsWith("sc-domain:")
    ? { ...rawReport, pages: (rawReport.pages || []).filter((p) => onHost(p.page)), previousPages: (rawReport.previousPages || []).filter((p) => onHost(p.page)), queryPages: (rawReport.queryPages || []).filter((p) => onHost(p.page)) }
    : rawReport;
  const days = report.days || 28;
  const model = ctrModel(report);
  const out = [];
  const base = { legacyIds: [], type: "search", module: "Search Console", source: "Google Search Console" };

  /* ---- low click-through rate on pages that already rank ---- */
  for (const p of report.pages || []) {
    if (p.impressions < scaled(100, days) || p.position > 20 || p.position < 1) continue;
    const { ctr: expected, basis } = model(p.position);
    if (p.ctr >= expected * 0.6) continue;
    const gain = Math.round((expected - p.ctr) * p.impressions);
    if (gain < scaled(10, days)) continue;
    const queries = topQueriesFor(report, p.page);
    out.push({
      ...base, id: `gsc:lowctr:${slug(pageKey(p.page))}`, actionType: "Meta Fix", confidence: "Medium", priority: priorityFor(gain, days),
      title: `Low click-through rate on ${pathOf(p.page)} (${pct(p.ctr)} at position ${p.position.toFixed(1)})`,
      evidence: `${p.impressions.toLocaleString("en-US")} impressions and ${p.clicks.toLocaleString("en-US")} clicks in ${days} days (observed). Typical CTR at this position is ${pct(expected)}, based on ${basis}. Closing the gap would mean roughly ${gain} more clicks per ${days} days (estimate).${queries.length ? ` Top queries: ${queries.join(", ")}.` : ""}`,
      recommendedAction: `Rewrite the title and meta description of ${pathOf(p.page)} so they promise what searchers want${queries.length ? ` for "${queries[0]}"` : ""}. Test one change at a time and check the CTR again after a few weeks.`,
      urls: [p.page], breadth: bonus(gain, days), bonusLabel: `~${gain} extra clicks per ${days} days (estimate)`,
      prIssue: { id: "gsc_lowctr", title: "Low click-through rate", category: "On-Page", severity: priorityFor(gain, days), urls: [p.page], queries, why: "The page already ranks, but few searchers click it.", fix: "Rewrite the title and meta description." },
    });
  }

  /* ---- striking distance: queries on page 2 with real demand ---- */
  const strike = [];
  for (const q of report.queries) {
    if (q.position < 8 || q.position > 20 || q.impressions < scaled(50, days)) continue;
    const target = model(5).ctr;
    const gain = Math.round(Math.max(0, target - q.ctr) * q.impressions);
    if (gain < scaled(5, days)) continue;
    strike.push({ q, gain });
  }
  strike.sort((a, b) => b.gain - a.gain);
  for (const { q, gain } of strike.slice(0, 15)) {
    const page = (report.queryPages || []).filter((r) => r.query === q.query).sort((a, b) => b.impressions - a.impressions)[0]?.page;
    out.push({
      ...base, id: `gsc:strike:${slug(q.query)}`, actionType: "Content Update", confidence: "Medium", priority: priorityFor(gain, days),
      title: `"${q.query}" is stuck at position ${q.position.toFixed(1)} (${q.impressions.toLocaleString("en-US")} impressions)`,
      evidence: `Observed: ${q.impressions.toLocaleString("en-US")} impressions, ${q.clicks} clicks, average position ${q.position.toFixed(1)} in ${days} days${page ? `, mostly on ${pathOf(page)}` : ""}. Reaching around position 5 could bring roughly ${gain} more clicks per ${days} days (estimate).`,
      recommendedAction: `Strengthen ${page ? pathOf(page) : "the page that ranks"} for "${q.query}": answer the question directly near the top, align the title and H1 with it, add internal links to it, and fill any gaps competitors cover.`,
      urls: page ? [page] : [], breadth: bonus(gain, days), bonusLabel: `~${gain} extra clicks per ${days} days (estimate)`,
    });
  }

  /* ---- cannibalisation: several of your pages share a query ---- */
  const byQuery = new Map();
  for (const r of report.queryPages || []) {
    if (!byQuery.has(r.query)) byQuery.set(r.query, new Map());
    const m = byQuery.get(r.query);
    const k = pageKey(r.page);
    const cur = m.get(k);
    if (!cur || r.impressions > cur.impressions) m.set(k, r); // URL variants of the same page count once
  }
  const groups = new Map(); // page-set key -> { pages, queries[] }
  for (const [query, pagesMap] of byQuery) {
    const rows = [...pagesMap.values()].sort((a, b) => b.impressions - a.impressions);
    const total = rows.reduce((s, r) => s + r.impressions, 0);
    if (rows.length < 2 || total < scaled(50, days)) continue;
    const contenders = rows.filter((r, i) => i === 0 || (r.impressions >= scaled(10, days) && r.impressions >= rows[0].impressions * 0.25));
    if (contenders.length < 2) continue;
    const key = contenders.map((r) => pageKey(r.page)).sort().join("|");
    if (!groups.has(key)) groups.set(key, { pages: contenders, queries: [] });
    groups.get(key).queries.push({ query, impressions: total });
  }
  for (const [key, g] of [...groups].sort((a, b) => b[1].queries.reduce((s, q) => s + q.impressions, 0) - a[1].queries.reduce((s, q) => s + q.impressions, 0)).slice(0, 8)) {
    const qs = g.queries.sort((a, b) => b.impressions - a.impressions);
    const total = qs.reduce((s, q) => s + q.impressions, 0);
    out.push({
      ...base, id: `gsc:cannibal:${slug(key)}`, actionType: "Content Update", confidence: "Medium", priority: total >= scaled(500, days) ? "High" : "Medium",
      title: `${g.pages.length} of your pages compete for ${qs.length === 1 ? `"${qs[0].query}"` : `${qs.length} queries (e.g. "${qs[0].query}")`}`,
      evidence: `Observed: ${g.pages.map((p) => `${pathOf(p.page)} (${p.impressions} impressions, position ${p.position.toFixed(1)})`).join("; ")} all appear for the same ${qs.length === 1 ? "query" : "queries"}, splitting clicks and signals between them.`,
      recommendedAction: `Decide which page should own ${qs.length === 1 ? "this query" : "these queries"}. Either merge the weaker page into the stronger one with a 301 redirect, or differentiate their focus so each targets a distinct intent, and point internal links at the one that should rank.`,
      urls: g.pages.map((p) => p.page), breadth: Math.min(10, g.pages.length * 2),
    });
  }

  /* ---- pages losing clicks vs the previous period ---- */
  const prev = new Map((report.previousPages || []).map((p) => [pageKey(p.page), p]));
  const now = new Map((report.pages || []).map((p) => [pageKey(p.page), p]));
  for (const [k, before] of prev) {
    if (before.clicks < scaled(20, days)) continue;
    const after = now.get(k);
    if (!after && report.truncated?.pages) continue; // absent from a truncated list may just mean "below the cutoff"
    const clicks = after ? after.clicks : 0;
    if (clicks > before.clicks * 0.7) continue;
    const lost = before.clicks - clicks;
    const drop = lost / before.clicks;
    out.push({
      ...base, id: `gsc:decline:${slug(k)}`, actionType: "Content Update", confidence: "High", priority: lost >= scaled(50, days) ? "High" : "Medium",
      title: `${pathOf(before.page)} lost ${Math.round(drop * 100)}% of its clicks (${before.clicks} → ${clicks})`,
      evidence: `Observed: ${before.clicks} clicks in ${report.previousRange.startDate} to ${report.previousRange.endDate} versus ${clicks} in ${report.range.startDate} to ${report.range.endDate}${after ? `; average position ${before.position.toFixed(1)} → ${after.position.toFixed(1)}` : "; it no longer appears in the top pages"}. Seasonal demand can explain some of this.`,
      recommendedAction: `Check which queries for ${pathOf(before.page)} dropped, whether the page changed or was redirected, if it is still indexed (URL Inspection in Search Console), and whether competitors overtook it. Refresh the content if it is out of date.`,
      urls: [before.page], breadth: bonus(lost, days), bonusLabel: `${lost} clicks lost vs the previous period (observed)`,
    });
  }

  /* ---- site-wide trend ---- */
  const t = report.totals, pt = report.previousTotals;
  if (pt && pt.clicks >= scaled(100, days) && t.clicks <= pt.clicks * 0.8) {
    const drop = (pt.clicks - t.clicks) / pt.clicks;
    out.push({
      ...base, id: "gsc:trend", actionType: "Technical Fix", confidence: "High", priority: drop >= 0.4 ? "High" : "Medium",
      title: `Search clicks are down ${Math.round(drop * 100)}% versus the previous period`,
      evidence: `Observed: ${pt.clicks.toLocaleString("en-US")} clicks → ${t.clicks.toLocaleString("en-US")} (${report.previousRange.startDate} to ${report.previousRange.endDate} versus ${report.range.startDate} to ${report.range.endDate}); impressions ${pt.impressions.toLocaleString("en-US")} → ${t.impressions.toLocaleString("en-US")}.`,
      recommendedAction: "Look at the pages and queries that lost the most (listed separately), check for indexing or technical problems, recent site changes, and seasonality.",
      urls: [], breadth: 8,
    });
  }

  /* ---- crawled indexable pages with no impressions at all ---- */
  if (crawl?.pages?.length && !report.truncated?.pages) {
    const seen = new Set((report.pages || []).map((p) => pageKey(p.page)));
    const missing = crawl.pages.filter((p) => !p.noindex && (p.statusCode ?? 200) === 200 && !seen.has(pageKey(p.finalUrl || p.url)));
    if (missing.length > 0 && (report.pages || []).length > 0) {
      out.push({
        ...base, id: "gsc:noimpr", actionType: "Technical Fix", confidence: "Medium", priority: missing.length >= 5 ? "Medium" : "Low",
        title: `${missing.length} crawled page${missing.length === 1 ? "" : "s"} got no search impressions in ${days} days`,
        evidence: `Observed: Search Console shows no impressions for ${missing.slice(0, 5).map((p) => pathOf(p.finalUrl || p.url)).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}, although the crawler found them indexable. New or low-demand pages can legitimately have none, but it can also mean they aren't indexed.`,
        recommendedAction: "Inspect these URLs in Search Console (URL Inspection) to see whether they are indexed, make sure they are in the sitemap and linked from other pages, and check each targets a topic people search for.",
        urls: missing.slice(0, 25).map((p) => p.finalUrl || p.url), breadth: Math.min(10, missing.length),
      });
    }
  }
  return out;
}
