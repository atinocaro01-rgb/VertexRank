// Client-side: turns a recommendation + the website's crawl into the small, real context the fix route needs. Picks the pages the
// recommendation is about (its URLs, or any page URL mentioned in its text), trims them, and lists the site's real URLs for linking.
// Pure and client-safe; tests/recommendationFix.test.mjs.

const URL_RE = /https?:\/\/[^\s"'<>)\],]+/g;

export function pagesFor(rec, crawl, max = 2) {
  const pages = Array.isArray(crawl?.pages) ? crawl.pages : [];
  if (!pages.length) return [];
  const mentioned = [...String(`${rec?.evidence || ""} ${rec?.recommendedAction || ""} ${rec?.title || ""} ${rec?.why || ""}`).matchAll(URL_RE)].map((m) => m[0].replace(/[.;:]+$/, ""));
  const wanted = [...(Array.isArray(rec?.urls) ? rec.urls : []), ...mentioned];
  const out = [];
  for (const u of wanted) {
    const p = pages.find((x) => x.url === u || x.url === u.replace(/\/$/, "") || `${x.url}/` === u);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= max) break;
  }
  if (out.length === 0) { const home = pages.find((p) => p.url === crawl?.startUrl) || pages[0]; if (home) out.push(home); }
  return out;
}

const slimPage = (p) => ({
  url: p.url, title: p.title, metaDescription: p.metaDescription, h1Text: p.h1Text, headings: [...(p.h2Texts || []), ...(p.h3Texts || [])].slice(0, 10),
  excerpt: String(p.fullText || "").slice(0, 1500), wordCount: p.wordCount,
  schemaTypes: Array.isArray(p.schemaSignals?.types) ? p.schemaSignals.types : [],
});

export function buildFixInput(rec, crawl, { language } = {}) {
  const pages = pagesFor(rec, crawl);
  return {
    rec: { title: rec.title, why: rec.why, evidence: rec.evidence, recommendedAction: rec.recommendedAction, module: rec.module, source: rec.source, actionType: rec.actionType, priority: rec.priority, urls: rec.urls || [] },
    site: { domain: crawl?.domain || "", language: language || pages[0]?.htmlLang || "" },
    pages: pages.map(slimPage),
    knownUrls: (crawl?.pages || []).slice(0, 40).map((p) => ({ url: p.url, title: p.title })),
  };
}

/** A stable key so reopening the same recommendation reuses its generated fix instead of spending another AI call. */
export const fixCacheKey = (rec, siteId) => `${siteId || ""}|${rec?.module || ""}|${rec?.title || ""}|${String(rec?.recommendedAction || "").slice(0, 80)}`;
