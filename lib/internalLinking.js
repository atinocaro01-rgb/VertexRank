// Feature: Internal Linking. For each orphan/weakly-linked page (already
// identified deterministically by lib/siteCrawler.js's link-graph
// analysis), ranks every OTHER crawled page by content similarity as a
// candidate to add an internal link FROM — reusing the same word-set
// Jaccard technique as the crawler's near-duplicate-content detector, but
// at a much lower threshold: near-duplicate detection wants "almost the
// same page" (>=0.85), this wants "topically related enough that a link
// would make sense to a reader" (any positive overlap, ranked, not
// thresholded — the AI layer makes the final relevance call, this just
// narrows the field from "every page on the site" to "the plausible few").
function wordSet(text) {
  return new Set((text || "").toLowerCase().match(/[a-z0-9']{3,}/g) || []);
}
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * @param pages - crawled page objects (lib/siteCrawler.js output)
 * @param targetUrls - URLs (typically siteWide.orphanPages +
 *   siteWide.weakLinkedPages) that need more internal links pointing at them
 * @returns [{ targetUrl, targetTitle, targetH1, candidates: [{url,title,h1Text,similarity}] }]
 *   candidates sorted by similarity descending, most-related first
 */
export function findLinkCandidates(pages, targetUrls, { topN = 5 } = {}) {
  const sets = new Map(pages.map((p) => [p.url, wordSet(p.fullText)]));
  const byUrl = new Map(pages.map((p) => [p.url, p]));

  const results = [];
  for (const targetUrl of targetUrls) {
    const target = byUrl.get(targetUrl);
    if (!target) continue; // target URL not actually in this crawl (stale reference) — skip rather than crash
    const targetSet = sets.get(targetUrl);

    const candidates = pages
      .filter((p) => p.url !== targetUrl)
      .map((p) => ({
        url: p.url,
        title: p.title || "(untitled)",
        h1Text: p.h1Text || "",
        similarity: Math.round(jaccard(targetSet, sets.get(p.url)) * 100),
      }))
      .filter((c) => c.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topN);

    results.push({ targetUrl, targetTitle: target.title || "(untitled)", targetH1: target.h1Text || "", candidates });
  }
  return results;
}
