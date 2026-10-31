// Crawl identity and stale-data protection (no React, no I/O — unit-tested in tests/crawlState.test.mjs).
//
// The problems this solves:
//   1. A re-crawl finishes while an AEO/GEO/keyword request that was computed from the OLD crawl
//      is still in flight. When it lands it used to overwrite the new state with stale results.
//   2. Two runs of the same analysis overlap and the slower (older) one lands last and wins.
//   3. A website is deleted, or its URL is edited, while a crawl/analysis is in flight; the late
//      response resurrected a ghost bundle or attached old-site data to the new URL.
//
// How:
//   - Every crawl result carries a `crawlId` (minted by the server in lib/siteCrawler.js).
//   - Before an analysis request is sent the caller takes a TICKET: { siteId, field, seq, crawlId }.
//   - When the response arrives, checkAnalysis(ticket) says whether it may still be applied:
//       "ok"          apply it
//       "recrawled"   the site's crawl changed (or was cleared) since the request was sent -> discard
//       "superseded"  a newer request for the same analysis was started -> discard
//       "gone"        the website was deleted -> discard
//   - Applied results are stamped with the crawlId they were computed from, so anything derived
//     from an older crawl can be recognised later (isStaleForCrawl).

/** Analyses computed from a crawl. Cleared whenever the crawl they came from is replaced. */
export const DERIVED_ANALYSIS_FIELDS = [
  "siteKeywordClusters",
  "siteAeoAnalysis",
  "siteGeoAnalysis",
  "internalLinkRecs",
  "siteInsights",
  "aiVisibility",
];

/** The "same website" key used to decide whether an edited URL is really a different URL. */
export function normalizeSiteKey(url) {
  return String(url || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** Records which crawl (and, when given, which target market) a result was computed for. */
export function stampResult(result, crawlId, market) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return { ...result, crawlId: crawlId ?? null, ...(market !== undefined ? { market } : {}) };
}

/** True when a result was written for a different market than the one now selected (results without a market are neutral). */
export function isStaleForMarket(result, country) {
  return !!(result?.market && country && result.market !== country);
}

/** True only when both sides are identified and differ (unidentified legacy data is never called stale). */
export function isStaleForCrawl(result, crawl) {
  return !!(result?.crawlId && crawl?.crawlId && result.crawlId !== crawl.crawlId);
}

/**
 * Clears everything derived from the crawl. Used when a crawl is replaced.
 * newSite: the website's URL changed, so the crawl itself and anything describing the OLD site
 * go too. User-curated lists (keywords, actions, content ideas, backlinks, internal links,
 * competitors' names/URLs) are kept — they are the user's work, not derived data.
 */
export function resetDerived(bundle, { newSite = false } = {}) {
  if (!bundle) return bundle;
  const next = { ...bundle };
  for (const f of DERIVED_ANALYSIS_FIELDS) next[f] = null;
  next.scores = { ...(bundle.scores || {}), aeo: null, geo: null, keyword: null };
  if (newSite) {
    next.siteCrawl = null;
    next.gscReport = null; // a Search Console report belongs to the old property
    next.competitorSuggestions = [];
    next.geoFactors = {};
    next.scores = { overall: null, aeo: null, geo: null, technical: null, keyword: null, content: null };
    next.competitors = (bundle.competitors || []).map((c) => ({ ...c, siteAnalysis: null }));
  }
  return next;
}

/**
 * Data saved before crawl IDs existed has none. Give it a stable legacy ID and stamp the analyses
 * that came with it, so existing workspaces keep working and are not flagged stale.
 */
export function migrateLegacyBundle(bundle) {
  const crawl = bundle?.siteCrawl;
  if (!crawl || typeof crawl !== "object" || crawl.crawlId) return bundle;
  const id = `legacy-${crawl.crawledAt || "unknown"}`;
  const next = { ...bundle, siteCrawl: { ...crawl, crawlId: id } };
  for (const f of DERIVED_ANALYSIS_FIELDS) {
    if (next[f] && typeof next[f] === "object" && !next[f].crawlId) next[f] = { ...next[f], crawlId: id };
  }
  if (Array.isArray(next.competitors)) {
    next.competitors = next.competitors.map((c) =>
      c?.siteAnalysis && !c.siteAnalysis.crawlId ? { ...c, siteAnalysis: { ...c.siteAnalysis, crawlId: id } } : c
    );
  }
  return next;
}

export function discardMessage(status) {
  if (status === "recrawled") {
    return "Your site was re-crawled (or its URL changed) while that was running, so the result was discarded. Run it again on the new crawl.";
  }
  return null; // "superseded" / "gone": nothing useful to tell the user
}

/**
 * Tracks crawl runs and analysis requests per website.
 * getBundles: () => ({ [siteId]: bundle }) — must always return the LATEST bundles map.
 */
export function createTracker(getBundles) {
  const crawlRuns = {}; // siteId -> latest crawl run number
  const seqs = {}; // `${siteId}:${field}` -> latest request number
  const currentCrawlId = (siteId) => getBundles()?.[siteId]?.siteCrawl?.crawlId ?? null;

  return {
    /** Start a crawl for a site. Any crawl started before this one becomes "superseded". */
    beginCrawl(siteId) {
      crawlRuns[siteId] = (crawlRuns[siteId] || 0) + 1;
      return { siteId, run: crawlRuns[siteId] };
    },
    /** "ok" | "superseded" | "gone" */
    crawlStatus(t) {
      if (!getBundles()?.[t.siteId]) return "gone";
      return crawlRuns[t.siteId] === t.run ? "ok" : "superseded";
    },
    /** Invalidate in-flight crawls for a site (URL edited / site deleted). */
    invalidate(siteId) {
      crawlRuns[siteId] = (crawlRuns[siteId] || 0) + 1;
    },
    /** Invalidate every in-flight analysis for one field (e.g. its inputs changed). */
    supersede(siteId, field) {
      const key = `${siteId}:${field}`;
      seqs[key] = (seqs[key] || 0) + 1;
    },
    /**
     * Take a ticket BEFORE sending an analysis request. Pass crawlId explicitly when the crawl was
     * only just stored and the bundles map may not reflect it yet.
     */
    beginAnalysis(siteId, field, crawlId) {
      const key = `${siteId}:${field}`;
      seqs[key] = (seqs[key] || 0) + 1;
      return { siteId, field, seq: seqs[key], crawlId: crawlId !== undefined ? crawlId : currentCrawlId(siteId) };
    },
    /** "ok" | "gone" | "recrawled" | "superseded" */
    checkAnalysis(t) {
      if (!getBundles()?.[t.siteId]) return "gone";
      if (currentCrawlId(t.siteId) !== t.crawlId) return "recrawled";
      if (seqs[`${t.siteId}:${t.field}`] !== t.seq) return "superseded";
      return "ok";
    },
    reset() {
      for (const k of Object.keys(crawlRuns)) delete crawlRuns[k];
      for (const k of Object.keys(seqs)) delete seqs[k];
    },
  };
}
