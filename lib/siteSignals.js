// Turns a per-page signal computer (computeAeoSignals or computeGeoSignals
// from lib/textIntelligence.js) into SITE-LEVEL signals. Shared by
// site-aeo-analysis, site-geo-analysis, and site-competitor-analysis so the
// three routes can't drift on how "does the site have X" is defined.
//
// The core judgment call: most of these signals (e.g. "has Organization
// schema", "has a Contact signal") are naturally site-level facts, not
// per-page ones — a business clearly has an About page or it doesn't,
// even though that signal is only literally true on one URL. So a site
// flag is true if ANY crawled page establishes it, with evidence tracking
// which page(s) did, rather than (say) averaging the boolean across pages,
// which would produce a meaningless fractional "0.14 has Organization
// schema."
import { scoreFromFlags } from "./textIntelligence";

/**
 * @param pages - array of crawled page objects (from lib/siteCrawler.js)
 * @param computeFn - computeAeoSignals or computeGeoSignals
 * @returns {
 *   siteFlags: { [key]: boolean } — true if any page has this signal
 *   evidence: { [key]: { count, pages: [url,...] } } — which/how many pages
 * }
 */
export function aggregateSiteFlags(pages, computeFn) {
  const siteFlags = {};
  const evidence = {};

  for (const page of pages) {
    const flags = computeFn(page);
    for (const [key, val] of Object.entries(flags)) {
      if (!evidence[key]) evidence[key] = { count: 0, pages: [] };
      if (!(key in siteFlags)) siteFlags[key] = false;
      if (val) {
        siteFlags[key] = true;
        evidence[key].count++;
        if (evidence[key].pages.length < 5) evidence[key].pages.push(page.url);
      }
    }
  }
  return { siteFlags, evidence };
}

/** Per-page scores for the same signal set, sorted weakest-first so a
 * caller can point directly at which pages need attention rather than only
 * reporting one opaque site-wide number. */
export function rankPagesByScore(pages, computeFn, weights) {
  return pages
    .map((p) => {
      const flags = computeFn(p);
      const { score } = scoreFromFlags(flags, weights);
      return { url: p.url, title: p.title || "(untitled)", score };
    })
    .sort((a, b) => a.score - b.score);
}

/** Picks a small, token-budget-conscious sample of pages to describe in an
 * AI prompt. Order of preference:
 *   1. the homepage/start URL (always),
 *   2. the WEAKEST-scoring pages — they need the most attention and are the
 *      ones most likely to change the analysis (only when a `scoreFn` +
 *      `weights` are supplied; up to half the remaining slots so the AI
 *      still sees enough strong pages to judge what IS already covered),
 *   3. the highest word-count pages (usually the most substantive content)
 *      to fill whatever is left.
 * Returns at most `limit` pages, never crashes on an empty list. */
export function samplePagesForPrompt(pages, startUrl, limit = 20, { scoreFn, weights } = {}) {
  if (pages.length <= limit) return pages;
  const chosen = new Map();
  const home = pages.find((p) => p.url === startUrl);
  if (home) chosen.set(home.url, home);

  if (scoreFn && weights) {
    const byUrl = new Map(pages.map((p) => [p.url, p]));
    const weakest = rankPagesByScore(pages, scoreFn, weights);
    const weakQuota = Math.ceil((limit - chosen.size) / 2);
    let taken = 0;
    for (const w of weakest) {
      if (taken >= weakQuota || chosen.size >= limit) break;
      if (chosen.has(w.url)) continue;
      chosen.set(w.url, byUrl.get(w.url));
      taken++;
    }
  }

  const byWordCount = [...pages].sort((a, b) => (b.wordCount || 0) - (a.wordCount || 0));
  for (const p of byWordCount) {
    if (chosen.size >= limit) break;
    if (!chosen.has(p.url)) chosen.set(p.url, p);
  }
  return [...chosen.values()];
}
