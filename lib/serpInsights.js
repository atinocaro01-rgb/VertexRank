// Turns saved live-search checks (the Live Results tab) into things the rest of VertexRank can use: competitor prospects and
// Opportunity Queue items. Pure and deterministic — no AI, no network, no React. Unit-tested in tests/serpInsights.test.mjs.
//
// What is OBSERVED: which pages a search provider returned for one query, country and device at one moment, and where the
// website appeared in them. What is NOT claimed: search volume, difficulty, or that this is "your rank" for everyone — a
// snapshot varies by person and location. Every opportunity below says so in its confidence (never higher than Medium).

import { hostOf, sameSite, findSiteRank } from "./serpMatch.js";
import { normalizeCountry, isWorldwide } from "./market.js";

export const MAX_CHECKS = 40; // per website; checks live in the browser with the workspace, so they are bounded
const STALE_DAYS = 14;

const str = (v, max = 300) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const slug = (v) => str(v, 200).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search || "/"; } catch { return str(u, 200); } };
const dateOf = (iso) => (typeof iso === "string" ? iso.slice(0, 10) : "");

/** Stable id of one check: the same query, country and device always map to the same id (a re-check replaces the old one). */
export const checkId = (query, country, device) => `serp:${slug(query)}:${slug(normalizeCountry(country))}:${device === "mobile" ? "mobile" : "desktop"}`;

/** A /api/serp/search response -> the small snapshot saved with the website (snippets dropped to keep storage small). */
export function slimCheck(resp) {
  const query = str(resp?.query, 150);
  if (!query || !Array.isArray(resp?.results) || !Number.isFinite(Date.parse(resp?.observedAt))) return null;
  const device = resp.device === "mobile" ? "mobile" : "desktop";
  const country = normalizeCountry(resp.country);
  const results = [];
  for (const r of resp.results) {
    const rank = Number(r?.rank);
    if (!Number.isInteger(rank) || rank < 1 || !hostOf(r?.url)) continue;
    results.push({ rank, title: str(r.title), url: str(r.url, 2000) });
    if (results.length >= 10) break;
  }
  const list = (v, n) => [...new Set((Array.isArray(v) ? v : []).map((x) => str(x, 160)).filter((x) => x.length >= 3))].slice(0, n);
  return { id: checkId(query, country, device), query, country, device, observedAt: new Date(resp.observedAt).toISOString(), source: str(resp.source, 80) || "Search provider", results, related: { searches: list(resp.related?.searches, 12), questions: list(resp.related?.questions, 8) } };
}

/** Adds a snapshot (newest first), replacing an earlier check of the same query/country/device, keeping at most `max`. */
export function upsertCheck(checks, snap, max = MAX_CHECKS) {
  if (!snap) return Array.isArray(checks) ? checks : [];
  const rest = (Array.isArray(checks) ? checks : []).filter((c) => c && c.id !== snap.id);
  return [snap, ...rest].slice(0, max);
}

/* ------------------------------------------------------------------ */
/* competitor prospects                                               */
/* ------------------------------------------------------------------ */

// Hosts that rank for almost everything but are not business competitors. Left out of prospects so the list stays useful;
// the person can still add any result by hand from the Live Results tab.
const GENERIC = [
  "wikipedia.org", "youtube.com", "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com", "pinterest.com", "tiktok.com",
  "reddit.com", "quora.com", "medium.com", "amazon.com", "ebay.com", "tripadvisor.com", "yelp.com", "google.com", "apple.com", "github.com", "stackoverflow.com",
];
export const isGenericHost = (host) => GENERIC.some((g) => host === g || host.endsWith(`.${g}`));

/**
 * Domains that keep appearing across the saved checks, excluding the website itself, big general platforms and competitors
 * already tracked. Sorted by how many checks they appear in, then by best position. All of it is observed.
 */
export function competitorProspects(checks, { site, tracked = [], limit = 8 } = {}) {
  const have = new Set((Array.isArray(tracked) ? tracked : []).map((c) => hostOf(c?.url || c?.name)).filter(Boolean));
  const by = new Map();
  for (const c of Array.isArray(checks) ? checks : []) {
    const seenHere = new Set();
    for (const r of Array.isArray(c?.results) ? c.results : []) {
      const host = hostOf(r?.url);
      if (!host || sameSite(host, site) || isGenericHost(host) || have.has(host) || seenHere.has(host)) continue;
      seenHere.add(host);
      const e = by.get(host) || { host, name: host, url: `https://${host}`, appearances: 0, queries: [], ranks: [] };
      e.appearances += 1; e.queries.push(c.query); e.ranks.push(r.rank);
      by.set(host, e);
    }
  }
  return [...by.values()]
    .map((e) => ({ host: e.host, name: e.name, url: e.url, appearances: e.appearances, queries: e.queries.slice(0, 5), bestRank: Math.min(...e.ranks), averageRank: Math.round((e.ranks.reduce((a, b) => a + b, 0) / e.ranks.length) * 10) / 10 }))
    .sort((a, b) => b.appearances - a.appearances || a.bestRank - b.bestRank || a.host.localeCompare(b.host))
    .slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* opportunities for the queue                                        */
/* ------------------------------------------------------------------ */

/** The crawled page whose title or H1 contains every word of the query, if any (observed from the crawl, not guessed). */
function pageTargeting(crawl, query) {
  const words = str(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return null;
  for (const p of Array.isArray(crawl?.pages) ? crawl.pages : []) {
    const hay = `${p?.title || ""} ${p?.h1Text || ""}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) return p;
  }
  return null;
}

const gscRow = (report, query) => (Array.isArray(report?.queries) ? report.queries.find((q) => String(q?.query).toLowerCase() === query.toLowerCase()) : null);
const demand = (row) => (row ? `Search Console shows ${Number(row.impressions).toLocaleString("en-US")} impressions at average position ${Number(row.position).toFixed(1)} for this query (observed). ` : "");
const ahead = (results, limit = 3) => results.slice(0, limit).map((r) => `#${r.rank} ${hostOf(r.url)}${r.title ? ` — ${r.title}` : ""}`).join("; ");

/**
 * One opportunity per saved check where the website is not already in the top three:
 *   - ranks #4–#10: room to climb (the page that ranks is the one to improve);
 *   - not in the results: the query isn't won yet (a crawled page that already targets it is the one to strengthen, otherwise one is missing).
 * Priority is raised when there is evidence of real demand (Search Console impressions, or the query is a tracked keyword).
 * Confidence is Medium at best: one snapshot, one provider. Checks older than two weeks are kept but demoted and annotated.
 */
export function serpOpportunities(checks, { site, crawl = null, keywords = [], gscReport = null, nowMs = Date.now() } = {}) {
  if (!hostOf(site)) return []; // without a site there is nothing to compare the results against
  const tracked = new Set((Array.isArray(keywords) ? keywords : []).map((k) => str(k?.keyword).toLowerCase()).filter(Boolean));
  const out = [];
  for (const c of Array.isArray(checks) ? checks : []) {
    if (!c?.query || !Array.isArray(c.results)) continue;
    const results = c.results.filter((r) => r && Number.isInteger(r.rank) && hostOf(r.url)); // hostile or corrupted rows are ignored
    if (results.length === 0) continue;
    const mine = findSiteRank(results, site);
    if (mine && mine.rank <= 3) continue;
    const row = gscRow(gscReport, c.query);
    const wanted = (row && row.impressions >= 50) || tracked.has(c.query.toLowerCase());
    const ageDays = Math.floor((nowMs - Date.parse(c.observedAt || "")) / 86400000);
    const stale = Number.isFinite(ageDays) && ageDays > STALE_DAYS;
    const where = `${c.source || "Search provider"}, ${isWorldwide(c.country) ? "no specific country" : c.country}, ${c.device}, ${dateOf(c.observedAt)}`;
    const base = {
      id: c.id || checkId(c.query, c.country, c.device), legacyIds: [], type: "search", module: "Live search results",
      source: `${c.source || "Search provider"} (observed)`, actionType: "Content Update", market: c.country, confidence: stale ? "Low" : "Medium",
      ...(stale ? { note: `This search was checked ${ageDays} days ago. Re-run it in Keyword Intelligence → Live Results to refresh.` } : {}),
    };
    if (mine) {
      out.push({
        ...base, priority: row && row.impressions >= 100 ? "High" : "Medium",
        title: `"${c.query}": ranks #${mine.rank}, with room to climb`,
        evidence: `Observed (${where}): ${hostOf(site)} ranks #${mine.rank}${mine.rank > 1 ? `; ahead of it: ${ahead(results.filter((r) => r.rank < mine.rank))}` : ""}. ${demand(row)}A single snapshot — results vary by person and location.`,
        recommendedAction: `Compare ${pathOf(mine.result.url)} with the pages above it: align its title and H1 with "${c.query}", answer the question directly near the top, cover the subtopics they cover that it doesn't, and link to it from related pages.`,
        urls: [mine.result.url],
      });
    } else {
      const page = pageTargeting(crawl, c.query);
      out.push({
        ...base, priority: wanted ? "High" : "Medium",
        title: `Not in the top ${results.length} for "${c.query}"`,
        evidence: `Observed (${where}): ${hostOf(site)} isn't among the first ${results.length} results. Ranking instead: ${ahead(results)}. ${demand(row)}${page ? `Your crawl shows ${pathOf(page.url)} already has every word of this query in its title or H1.` : "No crawled page has every word of this query in its title or H1."} A single snapshot — results vary by person and location.`,
        recommendedAction: page
          ? `Strengthen ${pathOf(page.url)} for "${c.query}": make its content at least as complete as the pages ranking, match the search intent they satisfy, and add internal links to it.`
          : `Create or retarget a page for "${c.query}": study what the ranking pages cover, match their search intent, put the query in the title and H1, and link to the page from related content.`,
        urls: page ? [page.url] : [],
      });
    }
  }
  return out;
}
