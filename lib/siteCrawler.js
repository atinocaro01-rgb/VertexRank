// Full-site crawling. Discovers and fetches multiple pages on a domain (not
// just one), extracts the same rich per-page data /api/scan already computes
// for a single page, and layers on site-wide analysis that only makes sense
// once more than one page is known: orphan pages, weak internal linking,
// duplicate content, and recurring technical issues.
//
// This is intentionally a NEW, additive file — it does not modify
// app/api/scan/route.js or its behavior. The per-page extraction and issue
// rules below are deliberately kept identical to that route's so a page
// scanned once (via /api/scan) and the same page found during a site crawl
// produce consistent results. If the two ever need to diverge, this is the
// place to factor out a shared lib/pageExtractor.js — not done here to avoid
// touching the existing, working single-page route.
//
// Design constraints this works within:
//   - Runs inside a single Vercel serverless invocation, so total wall time
//     must stay well under the platform's 60s function ceiling (see
//     maxDuration in app/api/site-scan/route.js). Crawling is therefore
//     bounded by BOTH a page count (maxPages) and a wall-clock time budget
//     (timeBudgetMs), whichever is hit first — if the budget runs out with
//     pages still undiscovered/unfetched, the result is returned with
//     truncated: true rather than silently claiming full coverage. That
//     honesty matters: this app's whole design language (see ⑤ below and
//     lib/dataLabel.js) is about never presenting partial/estimated data as
//     complete observed fact.
//   - Pages are fetched in bounded-concurrency waves (concurrency, default
//     5) rather than one at a time (too slow) or all at once (hammers the
//     target site and this app's own outbound connection pool).
//   - robots.txt is honored using lib/robotsTxt.js (user-agent groups, * and $
//     wildcards, longest-match precedence — the behaviour Google documents).
//   - Besides on-page data, the crawl records what technical SEO needs: HTTP
//     status and redirect chain of every URL it requests, noindex (meta and
//     X-Robots-Tag), canonical declarations, and — within a time reserve at the
//     end — header-only status checks of internal link targets, canonical
//     targets and sitemap URLs. lib/technicalChecks.js turns those facts into
//     findings (broken links, redirects, canonicals, sitemap consistency).

import * as cheerio from "cheerio";
import { randomUUID } from "node:crypto";
import { safeFetchText, validatePublicUrl } from "./safeFetch.js";
import { parseRobotsTxt, matcherFor } from "./robotsTxt.js";
import { collectSchemaSignals } from "./marketChecks.js";
import {
  parseRobotsDirectives, classifyCanonical, analyzeTechnical, selectLinkCheckCandidates, runLinkChecks, buildInbound, normKey,
} from "./technicalChecks.js";

const USER_AGENT = "Mozilla/5.0 (compatible; VertexRankBot/1.0; +https://vertexrank.app/bot)";
const BOT_TOKEN = "vertexrankbot"; // robots.txt group we identify as (falls back to "*")
const LINK_CHECK_RESERVE_MS = 8000; // end-of-crawl time kept for header-only status checks
const MAX_LINK_CHECKS = 40;
const MAX_SITEMAP_URLS = 5000;

const SEVERITY_PENALTY = { Critical: 22, High: 14, Medium: 8, Low: 3 };
function clampScore(n) {
  return Math.max(5, Math.min(100, Math.round(n)));
}

export function normalizeUrl(input, base) {
  let value = String(input || "").trim();
  if (!value) return null;
  try {
    const u = base ? new URL(value, base) : new URL(/^https?:\/\//i.test(value) ? value : "https://" + value);
    u.hash = "";
    // Treat /path and /path/ as the same page for discovery/de-duplication.
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u;
  } catch {
    return null;
  }
}

// Every outbound request goes through lib/safeFetch.js (SSRF protection:
// connect-time IP validation, per-hop redirect validation, response-size and
// content-type limits). Never call bare fetch() on a crawled URL.
//
// Redirects are only followed within the same site (an apex <-> www move is
// fine; a redirect to a different domain is not), so a crawl can't be steered
// onto an arbitrary third-party host by a page, sitemap or robots.txt.
const stripWww = (h) => h.replace(/^www\./i, "").toLowerCase();
const sameSiteRedirect = (from, to) => stripWww(from.hostname) === stripWww(to.hostname);

const FETCH_KINDS = {
  page: { accept: ["text/html", "application/xhtml+xml"], maxBytes: 2 * 1024 * 1024 },
  sitemap: { accept: ["application/xml", "text/xml", "text/plain", "application/octet-stream"], maxBytes: 3 * 1024 * 1024 },
  robots: { accept: ["text/"], maxBytes: 256 * 1024 },
};

async function fetchWithTimeout(url, timeoutMs = 8000, kind = "page") {
  const k = FETCH_KINDS[kind] || FETCH_KINDS.page;
  return safeFetchText(url, {
    timeoutMs,
    accept: k.accept,
    maxBytes: k.maxBytes,
    redirectPolicy: sameSiteRedirect,
    headers: { "User-Agent": USER_AGENT },
  });
}

/** Parses a sitemap or sitemap-index XML body into { urls, incomplete }. Follows up to
 * `maxSubSitemaps` same-host nested sitemaps if given an index (no unbounded recursion).
 * `incomplete` is true when some sub-sitemaps were skipped or failed, so callers never
 * claim to have seen the whole sitemap when they haven't. Throws if the body isn't a sitemap. */
async function parseSitemap(xmlText, originHost, depth, maxSubSitemaps) {
  const $ = cheerio.load(xmlText, { xmlMode: true });
  const isIndex = $("sitemapindex").length > 0;
  if (!isIndex && $("urlset").length === 0) throw new Error("not a sitemap");
  if (!isIndex) return { urls: $("url > loc").map((_, el) => $(el).text().trim()).get(), incomplete: false };
  if (depth >= 1) return { urls: [], incomplete: true };
  // Sub-sitemaps must live on the same site: a crawled sitemap must not be able to make this
  // server fetch arbitrary third-party URLs.
  const all = $("sitemap > loc").map((_, el) => $(el).text().trim()).get()
    .filter((u) => { const n = normalizeUrl(u); return n && stripWww(n.host) === stripWww(originHost); });
  const subUrls = all.slice(0, maxSubSitemaps);
  let incomplete = all.length > subUrls.length;
  const results = await Promise.all(subUrls.map(async (u) => {
    const res = await fetchWithTimeout(u, 6000, "sitemap");
    if (!res.ok || !res.text) { incomplete = true; return []; }
    try {
      const r = await parseSitemap(res.text, originHost, depth + 1, maxSubSitemaps);
      if (r.incomplete) incomplete = true;
      return r.urls;
    } catch { incomplete = true; return []; }
  }));
  return { urls: results.flat(), incomplete };
}

async function discoverViaSitemap(origin, robotsSitemaps, originHost, maxPages, prefetchedDefault) {
  const defaultUrl = `${origin}/sitemap.xml`;
  // robots.txt may list sitemaps anywhere; only follow ones on this site.
  const sameSiteSitemaps = robotsSitemaps.filter((u) => { const n = normalizeUrl(u); return n && stripWww(n.host) === stripWww(originHost); });
  const candidates = sameSiteSitemaps.length ? sameSiteSitemaps : [defaultUrl];
  // What we learned about the sitemap even when it isn't usable for discovery (feeds the consistency checks).
  const info = { found: false, sourceUrl: null, missingConfirmed: false, parseError: false, hostMismatch: null, complete: false };
  for (const sitemapUrl of candidates) {
    // /sitemap.xml was already requested alongside robots.txt (see crawlSite).
    const res = sitemapUrl === defaultUrl && prefetchedDefault ? prefetchedDefault : await fetchWithTimeout(sitemapUrl, 6000, "sitemap");
    if (!res.ok || !res.text) {
      if (sitemapUrl === defaultUrl && sameSiteSitemaps.length === 0 && (res.status === 404 || res.status === 410)) info.missingConfirmed = true;
      continue;
    }
    info.found = true;
    info.sourceUrl = sitemapUrl;
    try {
      const parsed = await parseSitemap(res.text, originHost, 0, 5);
      const normalized = parsed.urls.map((u) => normalizeUrl(u)).filter(Boolean);
      const sameHost = normalized.filter((u) => u.host === originHost);
      // Same site, other host variant (www vs apex): search engines ignore these entries.
      const otherVariant = normalized.filter((u) => u.host !== originHost && stripWww(u.host) === stripWww(originHost));
      if (otherVariant.length > 0) info.hostMismatch = { count: otherVariant.length, host: otherVariant[0].host };
      info.complete = !parsed.incomplete && sameHost.length <= MAX_SITEMAP_URLS;
      if (sameHost.length >= 2) {
        return {
          urls: sameHost.slice(0, maxPages), allUrls: sameHost.slice(0, MAX_SITEMAP_URLS).map((u) => u.toString()),
          totalFound: sameHost.length, source: sitemapUrl, info,
        };
      }
    } catch {
      info.parseError = true; // not valid sitemap XML — fall through to the next candidate / BFS
    }
  }
  return { urls: [], allUrls: [], totalFound: 0, source: null, info };
}

/** Extracts the same shape of per-page data as /api/scan's `meta` object,
 * plus the actual internal link URLs (needed for site-wide orphan/weak-link
 * detection, which a single-page scan has no use for). */
function extractPage(html, targetUrl) {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  const metaDescription = $('meta[name="description"]').attr("content")?.trim() || "";
  const canonical = $('link[rel="canonical"]').attr("href") || "";
  // Every rel=canonical tag (rel can hold several tokens), kept raw so conflicts/empties can be detected.
  const canonicalHrefs = $("link[rel]")
    .filter((_, el) => ($(el).attr("rel") || "").toLowerCase().split(/\s+/).includes("canonical"))
    .map((_, el) => $(el).attr("href") || "").get();
  const robotsMeta = $("meta[name]")
    .filter((_, el) => ["robots", "googlebot"].includes(($(el).attr("name") || "").toLowerCase()))
    .map((_, el) => $(el).attr("content") || "").get();
  const h1s = $("h1");
  const h1Text = h1s.first().text().trim();
  const h2Count = $("h2").length;
  const h2Texts = $("h2").slice(0, 6).map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const h3Texts = $("h3").slice(0, 10).map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const images = $("img");
  const imagesMissingAlt = images.filter((_, el) => !$(el).attr("alt")?.trim()).length;

  const bodyClone = $("body").clone();
  bodyClone.find("script,style,noscript").remove();
  const bodyText = bodyClone.text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(" ").filter(Boolean).length : 0;
  const fullText = bodyText.slice(0, 4000);

  // Market signals (lib/marketChecks.js judges these against the website's selected country).
  const htmlLang = ($("html").attr("lang") || "").trim();
  const hreflangs = $('link[rel="alternate"][hreflang]')
    .map((_, el) => ({ lang: ($(el).attr("hreflang") || "").trim(), href: ($(el).attr("href") || "").trim() })).get().slice(0, 30);
  const telLinks = [];

  const internalLinkUrls = new Set();
  const externalLinks = []; // { url, host, anchorText } — kept (not just counted) for backlink-opportunity mining
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href && href.toLowerCase().startsWith("tel:") && telLinks.length < 5) {
      let num = href.slice(4);
      try { num = decodeURIComponent(num); } catch { /* keep raw */ }
      if (num.trim()) telLinks.push(num.trim());
    }
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) return;
    const linkUrl = normalizeUrl(href, targetUrl);
    if (!linkUrl) return;
    if (linkUrl.host === targetUrl.host) {
      internalLinkUrls.add(linkUrl.toString());
    } else {
      const anchorText = $(el).text().replace(/\s+/g, " ").trim().slice(0, 120);
      externalLinks.push({ url: linkUrl.toString(), host: linkUrl.host, anchorText });
    }
  });

  const jsonLdBlocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { jsonLdBlocks.push(JSON.parse($(el).contents().text())); } catch { /* ignore malformed JSON-LD */ }
  });
  const schemaSignals = collectSchemaSignals(jsonLdBlocks);
  const schemaTypes = [...new Set(jsonLdBlocks.flatMap((b) => (Array.isArray(b) ? b : [b])).map((x) => x?.["@type"]).filter(Boolean))];

  return {
    url: targetUrl.toString(),
    title, titleLength: title.length,
    metaDescription, metaDescriptionLength: metaDescription.length,
    canonical, canonicalHrefs, robotsMeta, htmlLang, hreflangs, telLinks, schemaSignals, h1Text, h1Count: h1s.length, h2Count, h2Texts, h3Texts,
    imagesTotal: images.length, imagesMissingAlt, wordCount, fullText,
    internalLinkUrls: [...internalLinkUrls], externalLinkUrls: externalLinks, externalLinkCount: externalLinks.length,
    schemaTypes, listItemCount: $("ul li, ol li").length, tableCount: $("table").length,
  };
}

/** Same issue rules as app/api/scan/route.js, applied to one crawled page.
 * Kept deliberately parallel to that route so per-page results are
 * consistent whether a page was scanned individually or found in a crawl. */
function detectPageIssues(p, loadMs) {
  const issues = [];
  const add = (category, severity, title, why, fix) => issues.push({ category, severity, title, why, fix });

  if (!p.title) add("On-Page", "Critical", "Missing page title", "The title tag is the first thing a searcher reads in results.", "Add a unique, descriptive <title> tag under 60 characters.");
  else if (p.titleLength > 60) add("On-Page", "Low", `Title tag is ${p.titleLength} characters (recommended under 60)`, "Long titles get truncated in search results.", "Shorten the title to the most important keyword and brand name.");

  if (!p.metaDescription) add("On-Page", "Medium", "Missing meta description", "Without a description, search engines write their own, often less compelling, snippet.", "Write a unique 150–160 character description.");
  else if (p.metaDescriptionLength > 160) add("On-Page", "Low", `Meta description is ${p.metaDescriptionLength} characters (recommended under 160)`, "Long descriptions get cut off in search results.", "Trim the description to the essential value proposition.");

  if (p.h1Count === 0) add("On-Page", "High", "Missing H1 heading", "The H1 tells readers and search engines what the page is about at a glance.", "Add a single, descriptive H1.");
  else if (p.h1Count > 1) add("On-Page", "Low", `Page has ${p.h1Count} H1 tags (recommended: 1)`, "Multiple H1s dilute the page's topical signal.", "Keep one H1 and demote the others to H2/H3.");

  if (!p.canonical) add("Technical", "Medium", "Missing canonical tag", "Without a canonical signal, ranking signals can split across duplicate URLs.", "Add a self-referencing canonical tag.");

  if (p.noindex) add("Technical", "Low", "Page is set to noindex", "Search engines are told to keep this page out of their results.", "Remove the noindex directive if the page should rank; leave it for pages like thank-you or account pages.");

  if (p.imagesMissingAlt > 0) add("On-Page", "Medium", `${p.imagesMissingAlt} image${p.imagesMissingAlt > 1 ? "s" : ""} missing ALT text`, "Alt text is the only description of an image available to assistive technology.", "Add concise, descriptive alt text to every content image.");

  if (p.wordCount > 0 && p.wordCount < 300) add("Content", "High", `Thin content: only ${p.wordCount} words`, "Pages under 300 words rarely give enough context to judge relevance.", "Expand with concrete detail, examples, and answers to real buyer questions.");

  if (p.schemaTypes.length === 0) add("Schema", "High", "No structured data (schema.org) found", "Structured data helps search and AI systems understand the page with confidence.", "Add relevant JSON-LD schema.");

  if (loadMs > 3000) add("Technical", "Medium", `Page took ${(loadMs / 1000).toFixed(1)}s to respond`, "A slow server response delays everything else and can cause visitors to leave.", "Investigate server response time, hosting, and caching.");

  const technicalIssues = issues.filter((i) => ["Technical", "Schema"].includes(i.category));
  const onPageIssues = issues.filter((i) => ["On-Page", "Content"].includes(i.category));
  const technicalScore = clampScore(100 - technicalIssues.reduce((s, i) => s + (SEVERITY_PENALTY[i.severity] || 0), 0));
  const contentScore = clampScore(100 - onPageIssues.reduce((s, i) => s + (SEVERITY_PENALTY[i.severity] || 0), 0));
  return { issues, scores: { technical: technicalScore, content: contentScore } };
}

/** Jaccard similarity of two texts' word sets — a cheap, deterministic,
 * explainable near-duplicate-content signal. Not a substitute for real
 * shingling/simhash, but transparent and fast enough for a same-request
 * O(n^2) pass over a bounded page count (<= ~40 pages => <= ~780 pairs). */
function wordSet(text) {
  return new Set(text.toLowerCase().match(/[a-z0-9']{3,}/g) || []);
}
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Header-only status check of one URL (no body download) — used for link, canonical and sitemap checks. */
function statusRecord(url, res, source) {
  return {
    url, status: res.status || 0, errorCode: res.errorCode, redirects: res.redirects || [],
    finalUrl: res.redirects?.length ? res.finalUrl : undefined, contentType: res.headers?.["content-type"], source,
  };
}
async function fetchStatusOnly(url, timeoutMs = 4000) {
  const res = await safeFetchText(url, {
    timeoutMs, headersOnly: true, redirectPolicy: sameSiteRedirect, headers: { "User-Agent": USER_AGENT },
  });
  return statusRecord(url, res, "linkcheck");
}

/**
 * Crawls up to `maxPages` pages of a site, bounded by `timeBudgetMs` total
 * wall time. Returns per-page results plus site-wide aggregates.
 *
 * Discovery: sitemap.xml first (fast, authoritative, and doesn't require
 * fetching pages just to find more pages); falls back to a breadth-first
 * crawl of internal links if no usable sitemap is found.
 *
 * Time: the page crawl stops LINK_CHECK_RESERVE_MS before the budget ends so the
 * header-only link/canonical/sitemap status checks have time to run.
 */
export async function crawlSite(rawUrl, opts = {}) {
  const {
    maxPages: requestedMaxPages = 30,
    timeBudgetMs = 45000,
    // SPEED: 8 pages in flight instead of 5 — a typical site is fetched in
    // fewer rounds. Still a bounded pool, so the target site isn't hammered.
    concurrency: requestedConcurrency = 8,
    perPageTimeoutMs = 8000,
  } = opts;
  // Hard ceilings regardless of what a caller passes.
  const maxPages = Math.max(1, Math.min(requestedMaxPages, 60));
  const concurrency = Math.max(1, Math.min(requestedConcurrency, 8));

  const start = Date.now();
  const overallLeft = () => timeBudgetMs - (Date.now() - start);
  const crawlTimeLeft = () => overallLeft() - LINK_CHECK_RESERVE_MS;

  let startUrl = normalizeUrl(rawUrl);
  if (!startUrl) return { error: "That doesn't look like a valid URL." };
  // Early, friendly refusal of private/internal targets (the connect-time
  // checks in lib/safeFetch.js are the real enforcement for every request).
  const allowedStart = await validatePublicUrl(startUrl);
  if (!allowedStart.ok) return { error: allowedStart.message };
  const inputUrl = startUrl.toString();

  // Where does the start URL really land (http -> https, apex -> www)? Crawl that host, so internal
  // links, the sitemap and robots.txt are all judged against the host the site actually serves.
  const statuses = []; // one record per URL we learned a status for
  let startRedirect = null;
  const probe = await safeFetchText(startUrl.toString(), {
    timeoutMs: 6000, headersOnly: true, redirectPolicy: sameSiteRedirect, headers: { "User-Agent": USER_AGENT },
  });
  if (probe.redirects?.length) {
    statuses.push(statusRecord(startUrl.toString(), probe, "crawl"));
    const landed = probe.ok ? normalizeUrl(probe.finalUrl) : null;
    if (landed) {
      startRedirect = { from: startUrl.toString(), to: landed.toString(), hops: probe.redirects.length };
      startUrl = landed;
    }
  }
  const origin = `${startUrl.protocol}//${startUrl.host}`;

  // SPEED: robots.txt and the default sitemap don't depend on each other, so
  // they're fetched at the same time instead of one after the other. (If
  // robots.txt names a different sitemap, this extra request is simply unused.)
  const [robotsRes, defaultSitemapRes] = await Promise.all([
    fetchWithTimeout(`${origin}/robots.txt`, 5000, "robots"),
    fetchWithTimeout(`${origin}/sitemap.xml`, 6000, "sitemap"),
  ]);
  const robotsParsed = robotsRes.ok ? parseRobotsTxt(robotsRes.text) : null;
  const botRules = matcherFor(robotsParsed, BOT_TOKEN);
  const googleRules = matcherFor(robotsParsed, "googlebot");
  const allowed = (u) => botRules.isAllowed(u.pathname + u.search);
  const allowedStr = (s) => { try { return allowed(new URL(s)); } catch { return true; } };
  if (!allowed(startUrl)) {
    return {
      error: `robots.txt on ${startUrl.host} tells crawlers not to fetch ${startUrl.pathname}, so VertexRank can't audit it. ` +
        "VertexRank respects robots.txt — relax that Disallow rule (or crawl a different URL) and try again.",
    };
  }
  const robotsFacts = {
    url: `${origin}/robots.txt`, fetched: (robotsRes.status || 0) > 0, status: robotsRes.status || 0,
    blocksGooglebot: robotsParsed ? googleRules.blocksWholeSite() : false,
  };

  const sitemapResult = await discoverViaSitemap(origin, robotsParsed?.sitemaps || [], startUrl.host, maxPages, defaultSitemapRes);

  const pages = [];
  const visited = new Set();
  const aliases = new Map(); // requested URL -> final URL it redirected to
  const blockedAttempted = [];
  let pagesDiscovered = 0;

  async function fetchAndExtract(u) {
    const key = u.toString();
    if (visited.has(key)) return null;
    visited.add(key);
    if (!allowed(u)) return { url: key, blockedByRobots: true };
    // Never start a fetch whose own timeout could run past the page-crawl budget — clamp to whichever is smaller.
    const budgetedTimeout = Math.max(500, Math.min(perPageTimeoutMs, crawlTimeLeft()));
    const res = await fetchWithTimeout(key, budgetedTimeout);
    const record = statusRecord(key, res, "crawl");
    if (!res.ok || !res.text) {
      return { url: key, error: res.error || (res.ok ? "empty response" : `HTTP ${res.status}`), ms: res.ms, records: [record] };
    }
    // Key the page by where it actually landed, so relative links resolve against the right URL and
    // a redirected URL and its target are never crawled (or counted) twice.
    let finalU = u;
    if (res.redirects?.length) { const f = normalizeUrl(res.finalUrl); if (f) finalU = f; }
    const finalKey = finalU.toString();
    const records = [record];
    if (finalKey !== key) {
      aliases.set(key, finalKey);
      if (visited.has(finalKey)) return { url: key, duplicateOf: finalKey, records };
      visited.add(finalKey);
      if (!allowed(finalU)) return { url: finalKey, blockedByRobots: true, records };
      records.push({ url: finalKey, status: res.status, redirects: [], contentType: res.headers?.["content-type"], source: "crawl" });
    }
    const extracted = extractPage(res.text, finalU);
    const directives = parseRobotsDirectives(extracted.robotsMeta, res.headers?.["x-robots-tag"]);
    const { issues, scores } = detectPageIssues({ ...extracted, noindex: directives.noindex }, res.ms);
    return {
      ...extracted, issues, scores, statusCode: res.status, loadTimeMs: res.ms,
      noindex: directives.noindex, nofollow: directives.nofollow, noindexSource: directives.noindexSource,
      xRobotsTag: res.headers?.["x-robots-tag"] || "",
      redirectChain: res.redirects || [], requestedUrl: key !== finalKey ? key : undefined,
      records,
    };
  }

  /** Files one fetchAndExtract result: its status records, robots-blocked URLs; returns the page or null. */
  function collect(raw) {
    if (!raw) return null;
    for (const rec of raw.records || []) statuses.push(rec);
    if (raw.blockedByRobots) { blockedAttempted.push(raw.url); return null; }
    if (raw.error || raw.duplicateOf) return null;
    const { records, ...page } = raw;
    return page;
  }

  async function runBoundedConcurrent(urls) {
    let cursor = 0;
    async function worker() {
      while (cursor < urls.length && crawlTimeLeft() > 0) {
        const u = urls[cursor++];
        const page = collect(await fetchAndExtract(u));
        if (page) pages.push(page);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  }

  if (sitemapResult.urls.length >= 2) {
    pagesDiscovered = sitemapResult.totalFound;
    // Always crawl the originally requested URL even if the sitemap didn't
    // happen to list it (e.g. a redirected/canonical variant was listed
    // instead) — the user asked about THIS url specifically.
    const urls = [startUrl, ...sitemapResult.urls.filter((u) => u.toString() !== startUrl.toString())].slice(0, maxPages);
    await runBoundedConcurrent(urls);
  } else {
    // BFS fallback: discover links as we go.
    let queue = [startUrl];
    const queued = new Set([startUrl.toString()]);
    while (queue.length && pages.length < maxPages && crawlTimeLeft() > 0) {
      const wave = queue.slice(0, concurrency);
      queue = queue.slice(concurrency);
      const results = await Promise.all(wave.map(fetchAndExtract));
      const nextLinks = [];
      for (const raw of results) {
        const r = collect(raw);
        if (!r) continue;
        pages.push(r);
        for (const link of r.internalLinkUrls) {
          if (!queued.has(link) && queued.size < maxPages * 4) { // cap discovery fan-out too
            queued.add(link);
            const lu = normalizeUrl(link);
            if (lu) nextLinks.push(lu);
          }
        }
      }
      pagesDiscovered = queued.size;
      queue.push(...nextLinks);
    }
  }

  const truncated = pages.length < pagesDiscovered || crawlTimeLeft() <= 0;
  const aliasOf = (u) => aliases.get(u) || u;

  // ---- technical facts: bounded header-only status checks of URLs we saw but didn't fetch ----
  const knownKeys = new Set(statuses.map((r) => normKey(r.url)));
  for (const p of pages) knownKeys.add(normKey(p.url));
  const canonicalTargets = pages
    .map((p) => classifyCanonical(p.url, p.canonicalHrefs || []))
    .filter((c) => c.state === "other_page").map((c) => c.target);
  const { candidates, totalUnknown } = selectLinkCheckCandidates({
    pages, knownKeys, sitemapUrls: sitemapResult.allUrls, canonicalTargets, isAllowed: allowedStr, cap: MAX_LINK_CHECKS,
  });
  const linkChecks = await runLinkChecks({
    candidates, concurrency, timeLeft: overallLeft,
    fetchStatus: (u) => fetchStatusOnly(u, Math.max(500, Math.min(4000, overallLeft() - 300))),
  });
  statuses.push(...linkChecks.results);
  // A link-checked URL that redirected to a page we crawled counts as a link to that page (orphan/weak-link maths below).
  for (const rec of linkChecks.results) {
    const landed = rec.redirects?.length && rec.finalUrl ? normalizeUrl(rec.finalUrl) : null;
    if (landed) aliases.set(rec.url, landed.toString());
  }

  // Internal URLs robots.txt forbids (that we therefore never requested).
  const blockedSet = new Set(blockedAttempted);
  for (const k of buildInbound(pages).keys()) if (!allowedStr(k)) blockedSet.add(k);
  const blockedByRobots = [...blockedSet].slice(0, 50);
  const sitemapBlockedByRobots = sitemapResult.allUrls.filter((u) => !allowedStr(u)).slice(0, 50);

  const technical = analyzeTechnical({
    startUrl: startUrl.toString(), pages, statuses,
    sitemap: { urls: sitemapResult.allUrls, ...sitemapResult.info },
    robots: robotsFacts, blockedByRobots, sitemapBlockedByRobots,
  });

  // ---- site-wide aggregation (only meaningful with 2+ pages crawled) ----
  const linkGraph = new Map(); // url -> incoming link count from OTHER crawled pages
  for (const p of pages) linkGraph.set(p.url, 0);
  for (const p of pages) {
    for (const link of p.internalLinkUrls) {
      const target = aliasOf(link); // a link to a URL that redirected counts as a link to the page it landed on
      if (target !== p.url && linkGraph.has(target)) linkGraph.set(target, linkGraph.get(target) + 1);
    }
  }
  const orphanPages = pages.filter((p) => (linkGraph.get(p.url) || 0) === 0 && p.url !== startUrl.toString()).map((p) => p.url);
  const weakLinkedPages = pages.filter((p) => (linkGraph.get(p.url) || 0) === 1).map((p) => p.url);

  function findDuplicateGroups(keyFn) {
    const groups = new Map();
    for (const p of pages) {
      const key = keyFn(p);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p.url);
    }
    return [...groups.entries()].filter(([, urls]) => urls.length > 1).map(([value, urls]) => ({ value, urls }));
  }
  const duplicateTitles = findDuplicateGroups((p) => p.title);
  const duplicateMetaDescriptions = findDuplicateGroups((p) => p.metaDescription);

  const nearDuplicateContentPairs = [];
  const sets = pages.map((p) => wordSet(p.fullText));
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const sim = jaccard(sets[i], sets[j]);
      if (sim >= 0.85) nearDuplicateContentPairs.push({ urlA: pages[i].url, urlB: pages[j].url, similarity: Math.round(sim * 100) });
    }
  }

  const issueFrequency = new Map(); // "category::title" -> { count, sample, urls }
  for (const p of pages) {
    for (const issue of p.issues) {
      const key = `${issue.category}::${issue.title}`;
      if (!issueFrequency.has(key)) issueFrequency.set(key, { ...issue, count: 0, urls: [] });
      const entry = issueFrequency.get(key);
      entry.count++;
      entry.urls.push(p.url);
    }
  }
  const recurringIssues = [...issueFrequency.values()].filter((e) => e.count >= 2).sort((a, b) => b.count - a.count);

  // Technical score = average of the pages' scores, minus a capped, explainable penalty for the
  // site-level findings (see SEVERITY_PENALTY / MAX_SITE_PENALTY in lib/technicalChecks.js).
  const pageTechnicalAvg = pages.length ? pages.reduce((s, p) => s + p.scores.technical, 0) / pages.length : 0;
  const siteScores = pages.length
    ? {
        technical: clampScore(pageTechnicalAvg - technical.penalty),
        content: clampScore(pages.reduce((s, p) => s + p.scores.content, 0) / pages.length),
        technicalDetail: { pageAverage: Math.round(pageTechnicalAvg), siteLevelPenalty: technical.penalty },
      }
    : null;

  return {
    // Identity of THIS crawl. Everything computed from it (AEO, GEO, keyword clusters, ...) is tied to
    // this ID on the client so results from an older crawl can never overwrite a newer one.
    crawlId: randomUUID(),
    domain: startUrl.host,
    inputUrl,
    startUrl: startUrl.toString(),
    startRedirect,
    discoveryMethod: sitemapResult.urls.length >= 2 ? "sitemap" : "links",
    pagesDiscovered: Math.max(pagesDiscovered, pages.length),
    pagesCrawled: pages.length,
    truncated,
    crawledAt: new Date().toISOString(),
    pages,
    siteScores,
    siteWide: {
      orphanPages,
      weakLinkedPages,
      duplicateTitles,
      duplicateMetaDescriptions,
      nearDuplicateContentPairs,
      recurringIssues,
      technical: {
        findings: technical.findings,
        penalty: technical.penalty,
        summary: technical.summary,
        // Honest coverage: link/sitemap checks are a bounded sample, never the whole site.
        coverage: {
          linkChecks: { checked: linkChecks.checked, candidates: totalUnknown, skipped: linkChecks.skipped, scope: "internal links, canonical targets and sitemap URLs" },
          sitemap: { found: sitemapResult.info.found, source: sitemapResult.info.sourceUrl, listed: sitemapResult.allUrls.length, complete: sitemapResult.info.complete },
          robots: { status: robotsFacts.status, fetched: robotsFacts.fetched },
        },
      },
    },
  };
}
