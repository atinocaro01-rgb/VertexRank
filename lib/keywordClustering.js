// Feature ②: groups keyword candidates from every crawled page into topic
// clusters, and flags cannibalization — multiple DIFFERENT pages strongly
// targeting the same cluster (competing for the same search intent instead
// of supporting each other).
//
// Clustering method: deterministic shared-significant-token grouping via
// union-find, not embeddings — no ML infrastructure is available here, and
// this keeps every cluster fully explainable ("these keywords are grouped
// because they share the word 'accounting'"), which matches this app's
// existing "Observed" evidence layer philosophy in lib/textIntelligence.js.
//
// The one real failure mode of shared-token clustering: a single very
// common word can chain-merge unrelated topics into one giant blob (e.g.
// "services" appearing in plumbing, legal, and catering candidates would
// wrongly merge three unrelated businesses into one cluster). Mitigated
// below by gating each token on how many DISTINCT PAGES use it — not how
// many candidate phrases contain it. Phrase count is the wrong signal: a
// single content-rich page naturally produces many overlapping n-gram
// variants of its own topic ("accounting", "accounting software",
// "accounting firm offers" can all come from ONE page's text), which would
// wrongly trip a phrase-count-based cap. A token spread across many
// DIFFERENT pages, on the other hand, really is a generic, cross-topic word.
import { extractKeywordCandidates, extractEntityCandidates } from "./textIntelligence";

function significantTokens(phrase) {
  // Words under 4 letters ("ai", "crm", "seo") carry real topical meaning
  // too often to safely use as a general clustering signal alongside
  // longer words, so they're left out of clustering (a phrase like "SEO"
  // simply won't cluster with anything via token overlap) rather than
  // risking bad merges — still returned as its own valid keyword.
  return [...new Set(phrase.toLowerCase().split(/\s+/).filter((t) => t.length >= 4))];
}

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) { const next = this.parent.get(cur); this.parent.set(cur, root); cur = next; }
    return root;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * @param pages - crawled page objects (lib/siteCrawler.js output)
 * @returns {
 *   clusters: [{ id, label, keywords: [...], totalScore, pages: [{url,title,strong}] }],
 *   cannibalization: [{ clusterId, label, keywords, competingPages }]
 * }
 * "strong" = the page uses that keyword in its title or H1 (a real signal
 * the page is actually targeting that term, not just mentioning it once in
 * body text).
 */
export function clusterSiteKeywords(pages, { perPageLimit = 25, maxClusters = 40 } = {}) {
  const allCandidates = [];
  for (const page of pages) {
    for (const c of extractKeywordCandidates(page, perPageLimit)) {
      allCandidates.push({ ...c, pageUrl: page.url, pageTitle: page.title || "(untitled)" });
    }
  }
  if (allCandidates.length === 0) return { clusters: [], cannibalization: [] };

  const uniquePhrases = [...new Set(allCandidates.map((c) => c.keyword))];
  const tokenToPhrases = new Map();   // token -> [phrase,...]  (for the actual union step)
  const tokenToPages = new Map();     // token -> Set<pageUrl>  (for the generic-word gate)
  for (const c of allCandidates) {
    for (const tok of significantTokens(c.keyword)) {
      if (!tokenToPhrases.has(tok)) tokenToPhrases.set(tok, new Set());
      tokenToPhrases.get(tok).add(c.keyword);
      if (!tokenToPages.has(tok)) tokenToPages.set(tok, new Set());
      tokenToPages.get(tok).add(c.pageUrl);
    }
  }

  // A token spread across more than this many DISTINCT pages is treated as
  // too generic a signal to cluster on (scales with site size: small sites
  // tolerate a word appearing on most pages before calling it "generic";
  // larger sites need a tighter absolute cap).
  const maxGenericTokenPages = Math.max(4, Math.ceil(pages.length * 0.4));

  const uf = new UnionFind();
  for (const phrase of uniquePhrases) uf.find(phrase); // every phrase gets at least its own cluster
  for (const [tok, phraseSet] of tokenToPhrases) {
    if (phraseSet.size < 2) continue;
    if (tokenToPages.get(tok).size > maxGenericTokenPages) continue; // too generic — spans too many different pages
    const phrases = [...phraseSet];
    for (let i = 1; i < phrases.length; i++) uf.union(phrases[0], phrases[i]);
  }

  const clusterMap = new Map(); // root -> Map<phrase, {keyword, score, pages: Map<url,{url,title,strong}>}>
  for (const c of allCandidates) {
    const root = uf.find(c.keyword);
    if (!clusterMap.has(root)) clusterMap.set(root, new Map());
    const phraseMap = clusterMap.get(root);
    if (!phraseMap.has(c.keyword)) phraseMap.set(c.keyword, { keyword: c.keyword, score: 0, pages: new Map() });
    const entry = phraseMap.get(c.keyword);
    entry.score += c.score || 0;
    const strong = !!(c.usage?.title || c.usage?.h1);
    const existing = entry.pages.get(c.pageUrl);
    if (!existing || (strong && !existing.strong)) entry.pages.set(c.pageUrl, { url: c.pageUrl, title: c.pageTitle, strong });
  }

  // Same generic-word principle as the token gate above, applied to whole
  // phrases: a single BARE WORD candidate (e.g. "services") that itself
  // shows up on many different pages isn't a meaningful topical link
  // between them, even though it's technically the same literal phrase —
  // it's excluded from PAGE-linking evidence (cluster membership /
  // cannibalization), though still listed in the cluster's keyword list for
  // transparency. Multi-word phrases are left alone here: two UNRELATED
  // pages coincidentally sharing an exact multi-word phrase is rare enough
  // that it's a real signal worth keeping, not noise to filter.
  const phraseToPages = new Map();
  for (const c of allCandidates) {
    if (!phraseToPages.has(c.keyword)) phraseToPages.set(c.keyword, new Set());
    phraseToPages.get(c.keyword).add(c.pageUrl);
  }
  const isGenericBareWord = (phrase) => !phrase.includes(" ") && phraseToPages.get(phrase).size > maxGenericTokenPages;

  const clusters = [...clusterMap.values()]
    .map((phraseMap) => {
      const phrases = [...phraseMap.values()].sort((a, b) => b.score - a.score);
      const pagesInvolved = new Map();
      for (const p of phrases) {
        if (isGenericBareWord(p.keyword)) continue;
        for (const [url, info] of p.pages) {
          const existing = pagesInvolved.get(url);
          if (!existing || (info.strong && !existing.strong)) pagesInvolved.set(url, info);
        }
      }
      return {
        id: phrases[0].keyword.replace(/\s+/g, "-"),
        label: phrases[0].keyword, // deterministic fallback label; the AI layer gives a nicer human topic name
        keywords: phrases.map((p) => p.keyword),
        totalScore: Math.round(phrases.reduce((s, p) => s + p.score, 0)),
        pages: [...pagesInvolved.values()],
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, maxClusters);

  const cannibalization = clusters
    .map((c) => ({ ...c, competingPages: c.pages.filter((p) => p.strong) }))
    .filter((c) => c.competingPages.length >= 2)
    .map((c) => ({ clusterId: c.id, label: c.label, keywords: c.keywords.slice(0, 8), competingPages: c.competingPages }));

  return { clusters, cannibalization };
}

/** Aggregates each page's real, deterministic keyword candidates
 * (lib/textIntelligence.js) into one site-wide ranked list — same keyword
 * phrase used on multiple pages gets its score summed and its usage counts
 * merged, so a term that's title-cased on 3 different pages ranks higher
 * than one that only appears once in body text on one page. Only the
 * facts (type/intent classification, usage counts, relative relevance) are
 * computed here; difficulty and written recommendations are the AI layer's
 * job (see app/api/site-keyword-clusters/route.js), same "crawl gives facts,
 * AI gives judgment" split used everywhere else in this app. */
export function aggregateSiteKeywords(pages, limit = 24) {
  const map = new Map();
  for (const page of pages) {
    for (const c of extractKeywordCandidates(page, 25)) {
      if (!map.has(c.keyword)) {
        map.set(c.keyword, {
          keyword: c.keyword, score: 0, type: c.type, intent: c.intent, pages: new Set(),
          usage: { title: 0, metaDescription: 0, h1: 0, h2h3: 0, body: 0, alt: 0, schema: 0 },
        });
      }
      const agg = map.get(c.keyword);
      agg.score += c.score;
      agg.pages.add(page.url);
      if (c.usage.title) agg.usage.title++;
      if (c.usage.metaDescription) agg.usage.metaDescription++;
      if (c.usage.h1) agg.usage.h1++;
      if (c.usage.h2h3) agg.usage.h2h3++;
      agg.usage.body += c.usage.body || 0;
      if (c.usage.alt) agg.usage.alt++;
      if (c.usage.schema) agg.usage.schema++;
    }
  }
  const list = [...map.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const maxScore = list[0]?.score || 1;
  return list.map((k) => ({
    keyword: k.keyword, type: k.type, intent: k.intent,
    relevance: Math.round(Math.min(100, (k.score / maxScore) * 100)),
    pagesUsedOn: k.pages.size,
    usage: k.usage,
  }));
}

/** Aggregates each page's real proper-noun entity candidates into one
 * site-wide list, occurrence counts summed across every crawled page. */
export function aggregateSiteEntities(pages, limit = 20) {
  const map = new Map();
  for (const page of pages) {
    for (const e of extractEntityCandidates(page, 25)) {
      map.set(e.entity, (map.get(e.entity) || 0) + e.occurrences);
    }
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([entity, occurrences]) => ({ entity, occurrences }));
}
