// Feature: Backlink Opportunities. Classifies the external links found on a
// crawled site (typically a competitor's — see the route for how this is
// used) into candidate categories, using URL/anchor-text heuristics only —
// no claim is made or implied that any of these are real, existing, or
// obtainable backlinks for anyone. This file only produces the deterministic
// "Observed" evidence layer; the AI layer (in the route) explains relevance,
// and is explicitly instructed never to claim these are actual backlinks.
//
// Classification is necessarily heuristic and best-effort — domain-name and
// anchor-text pattern matching, not a lookup against any authoritative
// registry. It will misclassify some domains and miss others; it's meant to
// sort a long raw link list into a more reviewable shape, not to be
// authoritative.

const DIRECTORY_HINTS = [
  "directory", "listing", "yelp.com", "yellowpages", "g2.com", "capterra",
  "clutch.co", "crunchbase", "producthunt", "trustpilot", "bbb.org",
  "angi.com", "houzz.com", "manta.com", "foursquare.com",
];
const ASSOCIATION_HINTS = ["association", "chamber", "institute", "society", "alliance", "federation", "foundation"];
const PUBLICATION_HINTS = ["news", "times", "journal", "magazine", "press", "tribune", "gazette", "herald", "blog"];
const PARTNER_ANCHOR_HINTS = ["partner", "client", "powered by", "trusted by", "integration", "certified", "member"];
const RESOURCE_PAGE_HINTS = ["resource", "resources", "useful link", "link page", "partners", "tools we use", "recommended", "our partners"];

// Large general platforms whose links are almost always navigation/share
// icons rather than a genuine editorial backlink signal — excluded so they
// don't crowd out real candidates.
const SKIP_HOSTS = [
  "facebook.com", "twitter.com", "x.com", "instagram.com", "linkedin.com",
  "youtube.com", "tiktok.com", "pinterest.com", "reddit.com", "whatsapp.com",
  "google.com", "apple.com", "play.google.com", "apps.apple.com",
];

function hostMatches(host, list) {
  const h = host.toLowerCase();
  return list.some((k) => h.includes(k));
}

function classifyDestination(host, anchorText) {
  if (hostMatches(host, DIRECTORY_HINTS)) return "Directory";
  if (host.toLowerCase().endsWith(".org") || hostMatches(host, ASSOCIATION_HINTS)) return "Association/Publication";
  if (hostMatches(host, PUBLICATION_HINTS)) return "Association/Publication";
  const a = (anchorText || "").toLowerCase();
  if (PARTNER_ANCHOR_HINTS.some((k) => a.includes(k))) return "Partner mention";
  return "Other";
}

function isResourcePage(title, h1) {
  const text = `${title || ""} ${h1 || ""}`.toLowerCase();
  return RESOURCE_PAGE_HINTS.some((k) => text.includes(k));
}

export function isSkippedHost(host) {
  return hostMatches(host, SKIP_HOSTS);
}

/**
 * @param pages - crawled page objects (lib/siteCrawler.js output; must have
 *   externalLinkUrls: [{url,host,anchorText}] per page — see lib/siteCrawler.js)
 * @returns candidate domains, most-linked-and-best-context first:
 *   [{ host, destinationType, linkingPageCount, linkingPages: [url,...],
 *      resourcePageMentions, examples: [{url,anchorText,fromPage,fromPageTitle,isResourcePage}] }]
 */
export function classifyBacklinkOpportunities(pages) {
  const byDomain = new Map();

  for (const page of pages) {
    const resourceCtx = isResourcePage(page.title, page.h1Text);
    for (const link of page.externalLinkUrls || []) {
      if (isSkippedHost(link.host)) continue;
      if (!byDomain.has(link.host)) {
        byDomain.set(link.host, {
          host: link.host,
          destinationType: classifyDestination(link.host, link.anchorText),
          examples: [],
          resourcePageMentions: 0,
          linkingPages: new Set(),
        });
      }
      const entry = byDomain.get(link.host);
      entry.linkingPages.add(page.url);
      if (resourceCtx) entry.resourcePageMentions++;
      if (entry.examples.length < 3) {
        entry.examples.push({ url: link.url, anchorText: link.anchorText || "", fromPage: page.url, fromPageTitle: page.title || "(untitled)", isResourcePage: resourceCtx });
      }
    }
  }

  return [...byDomain.values()]
    .map((e) => ({ ...e, linkingPageCount: e.linkingPages.size, linkingPages: [...e.linkingPages] }))
    .sort((a, b) => b.linkingPageCount - a.linkingPageCount || b.resourcePageMentions - a.resourcePageMentions);
}
