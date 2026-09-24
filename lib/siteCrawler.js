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
//   - robots.txt is honored on a best-effort basis: a literal path-prefix
//     match against Disallow rules for User-agent: * . This is not a full
//     robots.txt parser (no wildcard/$ support), which covers the
//     overwhelming majority of real-world robots.txt files without pulling
//     in a dependency.

import * as cheerio from "cheerio";

const USER_AGENT = "Mozilla/5.0 (compatible; VertexRankBot/1.0; +https://vertexrank.app/bot)";

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

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/xml,text/plain" },
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, finalUrl: res.url, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, status: 0, text: "", ms: Date.now() - start, error: err.name === "AbortError" ? "timed out" : "could not connect" };
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal, explainable robots.txt handling: literal path-prefix Disallow
 * matching for "*" (applies to every crawler) — no wildcards, no $ anchors.
 * Good enough to respect the common case without a full parser dependency. */
function parseRobots(text) {
  const lines = (text || "").split("\n").map((l) => l.trim());
  const disallow = [];
  let sitemaps = [];
  let inStarGroup = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (!key) continue;
    if (key === "user-agent") inStarGroup = value === "*";
    if (key === "disallow" && inStarGroup && value) disallow.push(value);
    if (key === "sitemap" && value) sitemaps.push(value);
  }
  return { disallow, sitemaps };
}
function isDisallowed(pathname, disallowRules) {
  return disallowRules.some((rule) => rule === "/" || pathname.startsWith(rule));
}

/** Parses a sitemap or sitemap-index XML body into a flat list of page URLs.
 * Follows up to `maxSubSitemaps` nested sitemaps if given an index, so a
 * typical sitemap_index.xml -> sitemap-1.xml, sitemap-2.xml... setup works
 * without unbounded recursion. */
async function parseSitemap(xmlText, originHost, depth, maxSubSitemaps) {
  const $ = cheerio.load(xmlText, { xmlMode: true });
  const isIndex = $("sitemapindex").length > 0;
  if (isIndex && depth < 1) {
    const subUrls = $("sitemap > loc").map((_, el) => $(el).text().trim()).get().slice(0, maxSubSitemaps);
    const results = await Promise.all(subUrls.map(async (u) => {
      const res = await fetchWithTimeout(u, 6000);
      if (!res.ok || !res.text) return [];
      return parseSitemap(res.text, originHost, depth + 1, maxSubSitemaps);
    }));
    return results.flat();
  }
  return $("url > loc").map((_, el) => $(el).text().trim()).get();
}

async function discoverViaSitemap(origin, robotsSitemaps, originHost, maxPages) {
  const candidates = robotsSitemaps.length ? robotsSitemaps : [`${origin}/sitemap.xml`];
  for (const sitemapUrl of candidates) {
    const res = await fetchWithTimeout(sitemapUrl, 6000);
    if (!res.ok || !res.text) continue;
    try {
      const urls = await parseSitemap(res.text, originHost, 0, 5);
      const sameHost = urls
        .map((u) => normalizeUrl(u))
        .filter((u) => u && u.host === originHost);
      if (sameHost.length >= 2) return { urls: sameHost.slice(0, maxPages), totalFound: sameHost.length, source: sitemapUrl };
    } catch {
      /* malformed sitemap XML — fall through to the next candidate / BFS */
    }
  }
  return { urls: [], totalFound: 0, source: null };
}

/** Extracts the same shape of per-page data as /api/scan's `meta` object,
 * plus the actual internal link URLs (needed for site-wide orphan/weak-link
 * detection, which a single-page scan has no use for). */
function extractPage(html, targetUrl) {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  const metaDescription = $('meta[name="description"]').attr("content")?.trim() || "";
  const canonical = $('link[rel="canonical"]').attr("href") || "";
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

  const internalLinkUrls = new Set();
  const externalLinks = []; // { url, host, anchorText } — kept (not just counted) for backlink-opportunity mining
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
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
  const schemaTypes = [...new Set(jsonLdBlocks.flatMap((b) => (Array.isArray(b) ? b : [b])).map((x) => x?.["@type"]).filter(Boolean))];

  return {
    url: targetUrl.toString(),
    title, titleLength: title.length,
    metaDescription, metaDescriptionLength: metaDescription.length,
    canonical, h1Text, h1Count: h1s.length, h2Count, h2Texts, h3Texts,
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

/**
 * Crawls up to `maxPages` pages of a site, bounded by `timeBudgetMs` total
 * wall time. Returns per-page results plus site-wide aggregates.
 *
 * Discovery: sitemap.xml first (fast, authoritative, and doesn't require
 * fetching pages just to find more pages); falls back to a breadth-first
 * crawl of internal links if no usable sitemap is found.
 */
export async function crawlSite(rawUrl, opts = {}) {
  const {
    maxPages = 30,
    timeBudgetMs = 45000,
    concurrency = 5,
    perPageTimeoutMs = 8000,
  } = opts;

  const start = Date.now();
  const timeLeft = () => timeBudgetMs - (Date.now() - start);

  const startUrl = normalizeUrl(rawUrl);
  if (!startUrl) return { error: "That doesn't look like a valid URL." };
  const origin = `${startUrl.protocol}//${startUrl.host}`;

  const robotsRes = await fetchWithTimeout(`${origin}/robots.txt`, 5000);
  const robots = robotsRes.ok ? parseRobots(robotsRes.text) : { disallow: [], sitemaps: [] };
  const allowed = (u) => !isDisallowed(u.pathname, robots.disallow);

  const sitemapResult = await discoverViaSitemap(origin, robots.sitemaps, startUrl.host, maxPages);

  const pages = [];
  const visited = new Set();
  let pagesDiscovered = 0;

  async function fetchAndExtract(u) {
    if (visited.has(u.toString())) return null;
    visited.add(u.toString());
    if (!allowed(u)) return null;
    // Never start a fetch whose own timeout could run past the overall
    // budget — clamp to whichever is smaller.
    const budgetedTimeout = Math.max(500, Math.min(perPageTimeoutMs, timeLeft()));
    const res = await fetchWithTimeout(u.toString(), budgetedTimeout);
    if (!res.ok || !res.text) return { url: u.toString(), error: res.error || `HTTP ${res.status}`, ms: res.ms };
    const extracted = extractPage(res.text, u);
    const { issues, scores } = detectPageIssues(extracted, res.ms);
    return { ...extracted, issues, scores, statusCode: res.status, loadTimeMs: res.ms };
  }

  async function runBoundedConcurrent(urls) {
    let cursor = 0;
    async function worker() {
      while (cursor < urls.length && timeLeft() > 0) {
        const u = urls[cursor++];
        const result = await fetchAndExtract(u);
        if (result && !result.error) pages.push(result);
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
    while (queue.length && pages.length < maxPages && timeLeft() > 0) {
      const wave = queue.slice(0, concurrency);
      queue = queue.slice(concurrency);
      const results = await Promise.all(wave.map(fetchAndExtract));
      const nextLinks = [];
      for (const r of results) {
        if (!r || r.error) continue;
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

  const truncated = pages.length < pagesDiscovered || timeLeft() <= 0;

  // ---- site-wide aggregation (only meaningful with 2+ pages crawled) ----
  const linkGraph = new Map(); // url -> incoming link count from OTHER crawled pages
  for (const p of pages) linkGraph.set(p.url, 0);
  for (const p of pages) {
    for (const link of p.internalLinkUrls) {
      if (link !== p.url && linkGraph.has(link)) linkGraph.set(link, linkGraph.get(link) + 1);
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

  const siteScores = pages.length
    ? {
        technical: clampScore(pages.reduce((s, p) => s + p.scores.technical, 0) / pages.length),
        content: clampScore(pages.reduce((s, p) => s + p.scores.content, 0) / pages.length),
      }
    : null;

  return {
    domain: startUrl.host,
    startUrl: startUrl.toString(),
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
    },
  };
}
