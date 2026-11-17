// Audit findings that need more than one page, or data beyond the crawl (pure, client-safe). Tests: tests/playbookChecks.test.mjs.
//   - https: is the site served over https, and are any crawled pages on plain http?
//   - keyword placement: does each page use the query Search Console says it ranks for in its title, H1 and opening words?
// Per-page signals (viewport, mixed content, URL length, heading levels, vague anchors) are detected in lib/siteCrawler.js.

import { pageKey } from "./gscAnalysis.js";

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "is", "are", "how", "what", "your", "you", "do", "does", "vs", "by", "at", "from", "as", "it", "this", "that", "my", "i", "me", "near", "best"]);
const scaled = (n, days) => Math.max(1, Math.round((n * days) / 28));
const tokens = (s) => String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
const hostLabel = (d) => { const h = String(d || "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split(".")[0]; return h.toLowerCase(); };

/** Plain-http findings. Needs only the crawl. */
export function httpsFindings(crawl) {
  const out = [];
  const pages = Array.isArray(crawl?.pages) ? crawl.pages : [];
  const landed = crawl?.startUrl || pages[0]?.url || "";
  if (/^http:\/\//i.test(landed)) {
    out.push({
      id: "play_https_site", category: "Technical", severity: "Critical",
      title: "The site is served over http, not https",
      why: "Browsers label http sites \"Not secure\", Google prefers https, and visitors' data (forms, logins) travels unprotected.",
      fix: "Install an SSL certificate (most hosts offer one free), redirect every http:// URL to its https:// version with a 301, and update internal links, canonicals and the sitemap to https.",
      urls: [landed], evidence: [{ url: landed, note: "the crawl ended on an http:// URL" }],
    });
    return out;
  }
  const insecure = pages.filter((p) => /^http:\/\//i.test(p.url || ""));
  if (insecure.length) out.push({
    id: "play_https_pages", category: "Technical", severity: "High",
    title: `${insecure.length} crawled ${insecure.length === 1 ? "page is" : "pages are"} on http inside an https site`,
    why: "Pages on plain http show \"Not secure\" and split ranking signals between two versions of the URL.",
    fix: "301-redirect these URLs to their https versions and link to the https URLs everywhere.",
    urls: insecure.map((p) => p.url), evidence: insecure.slice(0, 25).map((p) => ({ url: p.url, note: "served over http" })),
  });
  return out;
}

/** The query each crawled page gets the most impressions for, from Search Console (brand queries left out). */
export function topQueryByPage(report, crawl) {
  const brand = hostLabel(crawl?.domain || crawl?.startUrl);
  const days = report?.days || 28;
  const best = new Map();
  for (const r of report?.queryPages || []) {
    if (!r?.query || !r?.page || r.impressions < scaled(20, days)) continue;
    if (brand && brand.length > 2 && r.query.toLowerCase().replace(/\s+/g, "").includes(brand)) continue;
    const k = pageKey(r.page);
    const cur = best.get(k);
    if (!cur || r.impressions > cur.impressions) best.set(k, r);
  }
  return best;
}

/** Does `text` contain (almost) all of the query's meaningful words? */
export function containsQuery(text, query) {
  const need = [...new Set(tokens(query))];
  if (!need.length) return true; // nothing meaningful to check
  const have = new Set(tokens(text));
  const hit = need.filter((w) => have.has(w) || [...have].some((h) => h.startsWith(w) || w.startsWith(h) && h.length >= 4)).length;
  return hit / need.length >= (need.length <= 2 ? 1 : 0.75);
}

/** Pages whose top Search Console query is missing from the title, H1 or opening ~100 words. Needs the crawl and a report. */
export function keywordPlacementFindings(crawl, report) {
  if (!crawl?.pages?.length || !report?.queryPages?.length) return [];
  const top = topQueryByPage(report, crawl);
  const rows = { title: [], h1: [], early: [] };
  for (const p of crawl.pages) {
    const r = top.get(pageKey(p.url));
    if (!r) continue;
    const q = r.query;
    const first100 = String(p.fullText || "").split(/\s+/).slice(0, 100).join(" ");
    if (p.title && !containsQuery(p.title, q)) rows.title.push({ url: p.url, note: `ranks for "${q}" (${r.impressions.toLocaleString("en-US")} impressions) but the title doesn't use it` });
    if (p.h1Text && !containsQuery(p.h1Text, q)) rows.h1.push({ url: p.url, note: `ranks for "${q}" but the H1 doesn't use it` });
    if (first100 && !containsQuery(first100, q)) rows.early.push({ url: p.url, note: `ranks for "${q}" but the first 100 words don't use it` });
  }
  const mk = (id, severity, title, why, fix, list) => list.length ? [{ id, category: "On-Page", severity, title: `${list.length} ${list.length === 1 ? "page doesn't" : "pages don't"} ${title}`, why, fix, urls: list.map((x) => x.url), evidence: list.slice(0, 25) }] : [];
  return [
    ...mk("play_kw_title", "Medium", "use their top search query in the title", "The title is the strongest on-page signal. If the words people actually search aren't in it, the page is a weaker match and the snippet looks less relevant.", "Rework the title so it naturally includes the query (closest wording first), keeping it under 60 characters and still readable.", rows.title),
    ...mk("play_kw_h1", "Low", "use their top search query in the H1", "The H1 should confirm what the page is about in the searcher's own words.", "Rewrite the H1 to include the query naturally. Do not stuff it.", rows.h1),
    ...mk("play_kw_early", "Low", "use their top search query in the first 100 words", "Mentioning the topic early tells readers and search engines the page answers what they searched for.", "Open with a sentence that answers the query directly, using its wording once.", rows.early),
  ];
}

/** Everything above in one list. `gscReport` is optional. */
export function playbookFindings(crawl, gscReport) {
  return [...httpsFindings(crawl), ...keywordPlacementFindings(crawl, gscReport)];
}
