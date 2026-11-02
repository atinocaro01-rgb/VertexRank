// Client-side: collects the real data a content calendar is built from (Search Console queries, keyword gaps, unanswered questions,
// GEO gaps, live-search checks, tracked keywords, the site's own pages) and gives each item an id the model must cite.
// Pure and client-safe. Tests: tests/contentCalendar.test.mjs.

const clip = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

export function buildCalendarInput(b, { startDate } = {}) {
  const crawl = b?.siteCrawl;
  const home = crawl?.pages?.find((p) => p.url === crawl.startUrl) || crawl?.pages?.[0];
  const items = [];
  const add = (prefix, rows) => rows.forEach((r, i) => items.push({ id: `${prefix}${i + 1}`, text: clip(r.text, 240), note: clip(r.note, 200) }));

  add("Q", (b?.gscReport?.queries || []).filter((q) => q?.query && q.impressions >= 20).sort((a, c) => c.impressions - a.impressions).slice(0, 25)
    .map((q) => ({ text: q.query, note: `${q.impressions} impressions, ${q.clicks ?? 0} clicks, average position ${Number(q.position).toFixed(1)} (Search Console)` })));
  add("K", (b?.siteKeywordClusters?.opportunities || []).slice(0, 12).map((o) => ({ text: o.problem, note: o.evidence })));
  add("A", (b?.siteAeoAnalysis?.questions || []).filter((q) => q.coverage !== "Answered").slice(0, 15).map((q) => ({ text: q.question, note: q.missingInfo })));
  add("E", (b?.siteGeoAnalysis?.opportunities || []).slice(0, 10).map((o) => ({ text: o.title, note: o.why })));
  add("S", (b?.serpChecks || []).slice(0, 10).map((c) => {
    const mine = (c.results || []).find((r) => host(r.url) && crawl?.domain && (host(r.url) === crawl.domain.replace(/^www\./, "") || host(r.url).endsWith(`.${crawl.domain.replace(/^www\./, "")}`)));
    const ahead = (c.results || []).slice(0, 3).map((r) => host(r.url)).filter(Boolean).join(", ");
    return { text: c.query, note: `live search (${c.country}): ${mine ? `site ranks #${mine.rank}` : "site not in the top 10"}; ranking: ${ahead}` };
  }));
  add("T", (b?.keywords || []).map((k) => k?.keyword).filter(Boolean).slice(0, 12).map((k) => ({ text: k, note: "a keyword you track" })));
  add("P", (crawl?.pages || []).filter((p) => p.title).slice(0, 15).map((p) => ({ text: p.title, note: `existing page ${p.url}` })));

  return {
    site: { domain: crawl?.domain || "", title: home?.title, metaDescription: home?.metaDescription, h1Text: home?.h1Text, text: home?.fullText },
    items,
    existingTitles: [...(crawl?.pages || []).map((p) => p.title), ...(b?.contentIdeas || []).map((c) => c.title)].filter(Boolean).slice(0, 120),
    knownUrls: (crawl?.pages || []).slice(0, 40).map((p) => ({ url: p.url, title: p.title })),
    competitors: (b?.competitors || []).map((c) => c.name).filter(Boolean),
    startDate: startDate || "",
  };
}
