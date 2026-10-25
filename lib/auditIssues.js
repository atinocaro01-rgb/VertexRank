// Site-wide SEO Audit issues derived from a crawl. Lives in its own module (not copyExport.js) so the
// opportunity queue can use it without a circular import; copyExport.js re-exports it for existing callers.

import { analyzeMarket } from "./marketChecks.js";

const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : []);

const AUDIT_SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

/** The full list of site-wide SEO Audit issues (orphan pages, duplicate
 *  titles/meta, near-duplicate content, plus every recurring per-page issue)
 *  for a full-site crawl — sorted the same way the Site-wide Audit screen
 *  sorts them. Pure function of `crawl` (lib/siteCrawler.js output) so the
 *  UI and the copy-export can share this and never drift. */
export function computeSiteAuditIssues(crawl) {
  if (!crawl) return [];
  const sw = crawl.siteWide;
  const siteLevel = [];
  if (sw.orphanPages.length > 0) siteLevel.push({
    id: "site_orphan", category: "Internal Linking", severity: "Medium",
    title: `${sw.orphanPages.length} orphan page${sw.orphanPages.length === 1 ? "" : "s"} — no internal links point to them`,
    why: "A page nothing else on the site links to is hard for search engines (and visitors) to find, even if it's in the sitemap.",
    fix: "Add at least one contextual internal link to each orphan page from a related page.", urls: sw.orphanPages,
  });
  if (sw.weakLinkedPages.length > 0) siteLevel.push({
    id: "site_weak", category: "Internal Linking", severity: "Low",
    title: `${sw.weakLinkedPages.length} page${sw.weakLinkedPages.length === 1 ? "" : "s"} with only one internal link pointing to them`,
    why: "A page with only one inbound internal link passes very little authority and is easy to lose track of.",
    fix: "Add a second contextual internal link from another related page.", urls: sw.weakLinkedPages,
  });
  sw.duplicateTitles.forEach((g, idx) => siteLevel.push({
    id: `site_duptitle_${idx}`, category: "On-Page", severity: "High",
    title: `Duplicate page title used on ${g.urls.length} pages: "${g.value}"`,
    why: "Identical titles make it hard for search engines to tell these pages apart, and one may simply be ignored.",
    fix: "Write a unique, specific title for each of these pages.", urls: g.urls,
  }));
  sw.duplicateMetaDescriptions.forEach((g, idx) => siteLevel.push({
    id: `site_dupmeta_${idx}`, category: "On-Page", severity: "Medium",
    title: `Duplicate meta description used on ${g.urls.length} pages`,
    why: "A duplicated description wastes the chance to differentiate each page in search results.",
    fix: "Write a unique meta description for each page summarizing what's actually on it.", urls: g.urls,
  }));
  sw.nearDuplicateContentPairs.forEach((p, idx) => siteLevel.push({
    id: `site_dupcontent_${idx}`, category: "Content", severity: "Medium",
    title: `Near-duplicate content (${p.similarity}% similar)`,
    why: "Two pages that say almost the same thing compete with each other in search instead of ranking together for more.",
    fix: "Differentiate the two pages' angle and content, or merge them and redirect one to the other.", urls: [p.urlA, p.urlB],
  }));
  const recurring = sw.recurringIssues.map((e, idx) => ({ ...e, id: `rec_${idx}` }));
  // Technical-SEO findings from the crawl (broken links, redirects, canonicals, indexability, sitemap).
  // Absent on crawls saved before those checks existed, hence the fallback.
  const technical = arr(sw.technical?.findings);
  return [...siteLevel, ...technical, ...recurring].sort((a, c) => (AUDIT_SEVERITY_RANK[a.severity] ?? 9) - (AUDIT_SEVERITY_RANK[c.severity] ?? 9) || c.urls.length - a.urls.length);
}

/** Audit issues plus the deterministic market (country) findings for the selected market, sorted like the audit screen. */
export function computeAuditIssuesForMarket(crawl, country) {
  const base = computeSiteAuditIssues(crawl);
  const market = crawl ? analyzeMarket(crawl, country) : [];
  if (market.length === 0) return base;
  return [...base, ...market].sort((a, c) => (AUDIT_SEVERITY_RANK[a.severity] ?? 9) - (AUDIT_SEVERITY_RANK[c.severity] ?? 9) || c.urls.length - a.urls.length);
}
