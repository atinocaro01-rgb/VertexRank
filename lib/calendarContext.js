// Client-side: collects the real data a content calendar is built from (Search Console queries, keyword gaps, unanswered questions,
// GEO gaps, live-search checks, tracked keywords, the site's own pages) and gives each item an id the model must cite.
// Pure and client-safe. Tests: tests/contentCalendar.test.mjs.

import { questionBank, outlineGaps } from "./competitorIntel.js";

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
  // Competitor crawls (observed): topics they cover that this site doesn't, questions their pages ask that this site doesn't answer,
  // and topics several competitors have a page on that this site has no page for. Text is the topic/question, never their copy.
  const comps = Array.isArray(b?.competitors) ? b.competitors : [];
  if (comps.some((c) => c?.crawlSummary || c?.siteAnalysis?.observed)) {
    const rows = [];
    for (const c of comps) for (const t of (c.siteAnalysis?.observed?.competitorOnlyTopics || []).slice(0, 4)) rows.push({ text: t, note: `a topic ${c.name || "a competitor"} covers that this site doesn't (competitor crawl)` });
    const answeredAeo = (b?.siteAeoAnalysis?.questions || []).filter((q) => q.coverage === "Answered").map((q) => q.question);
    for (const q of questionBank(comps, crawl, { answeredAeo }).items.filter((i) => i.answered === "no").slice(0, 8)) rows.push({ text: q.question, note: `${q.count} competitor${q.count === 1 ? "" : "s"} ask this question; this site doesn't answer it (competitor crawl)` });
    for (const g of outlineGaps(comps, crawl).filter((x) => x.kind === "missing_page").slice(0, 5)) rows.push({ text: g.theirTitle, note: `${g.competitors} competitor${g.competitors === 1 ? " has" : "s have"} a page on this; this site has none. Sections: ${g.sections.slice(0, 4).join("; ")}` });
    const seen = new Set();
    add("C", rows.filter((r) => { const k = clip(r.text, 80).toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 18));
  }
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
