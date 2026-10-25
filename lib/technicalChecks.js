// Technical SEO analysis over facts the crawler collected. Pure functions only — no network, no HTML
// parsing — so every rule here is unit-tested with synthetic data (tests/technicalChecks.test.mjs).
//
// What it finds: indexability problems (noindex, robots.txt), broken and error-returning internal
// links, redirect problems (links to redirecting URLs, chains, loops, https downgrades), canonical
// problems (missing/multiple/invalid targets, targets that are broken, redirecting or noindex,
// canonical chains), and sitemap consistency (broken, redirecting, noindex, blocked or non-canonical
// URLs, host mismatches, linked pages missing from the sitemap).
//
// Honesty rule: this only reports what was actually observed. Link and sitemap checks cover a bounded
// sample (the crawler has a time budget), so titles say "of N checked" and the result carries the
// coverage numbers; nothing here claims the whole site was verified.

const SEVERITY_PENALTY = { Critical: 11, High: 7, Medium: 4, Low: 2 };
const MAX_SITE_PENALTY = 35; // site-level findings can lower the Technical score by at most this much
const EVIDENCE_CAP = 25;
const SOURCES_PER_EVIDENCE = 5;

/* ------------------------------------------------------------------ */
/* small helpers                                                      */
/* ------------------------------------------------------------------ */

/** Same normalisation as normalizeUrl() in siteCrawler.js: no hash, no trailing slash (except root). */
export function normKey(u) {
  try {
    const x = new URL(String(u));
    x.hash = "";
    if (x.pathname.length > 1 && x.pathname.endsWith("/")) x.pathname = x.pathname.slice(0, -1);
    return x.toString();
  } catch {
    return String(u || "");
  }
}
const stripWww = (h) => String(h || "").replace(/^www\./i, "").toLowerCase();
const plural = (n, one, many) => (n === 1 ? one : many);
const unique = (arr) => [...new Set(arr)];

/* ------------------------------------------------------------------ */
/* robots directives (meta robots + X-Robots-Tag)                     */
/* ------------------------------------------------------------------ */

const VALUE_DIRECTIVES = new Set(["unavailable_after", "max-snippet", "max-image-preview", "max-video-preview"]);

/**
 * Combines <meta name="robots|googlebot"> contents and the X-Robots-Tag header into
 * { noindex, nofollow, noindexSource }. Directives scoped to other crawlers (e.g. "bingbot: noindex")
 * are ignored; "none" means noindex+nofollow.
 */
export function parseRobotsDirectives(metaContents = [], xRobotsTag = "") {
  const out = { noindex: false, nofollow: false, noindexSource: null };
  const apply = (token, source) => {
    if (token === "noindex" || token === "none") {
      if (!out.noindex) { out.noindex = true; out.noindexSource = source; }
    }
    if (token === "nofollow" || token === "none") out.nofollow = true;
  };
  for (const content of metaContents || []) {
    for (const t of String(content || "").toLowerCase().split(",")) apply(t.trim(), "meta");
  }
  // Header: "noindex", "googlebot: noindex, nofollow", or several comma-joined values.
  let agent = null; // null = applies to everyone
  for (const piece of String(xRobotsTag || "").toLowerCase().split(",")) {
    let token = piece.trim();
    const colon = token.indexOf(":");
    if (colon !== -1 && !VALUE_DIRECTIVES.has(token.slice(0, colon).trim())) {
      agent = token.slice(0, colon).trim();
      token = token.slice(colon + 1).trim();
    }
    if (agent === null || agent === "googlebot" || agent === "*") apply(token, "header");
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* canonical classification                                           */
/* ------------------------------------------------------------------ */

/**
 * Classifies a page's canonical declaration. `hrefs` is the raw href of every rel=canonical tag.
 * States: missing | invalid | multiple | self | protocol_mismatch | host_variant | other_page | cross_domain
 */
export function classifyCanonical(pageUrl, hrefs = []) {
  if (!hrefs || hrefs.length === 0) return { state: "missing", target: null };
  const distinct = unique(hrefs.map((h) => String(h || "").trim()).filter(Boolean));
  if (distinct.length === 0) return { state: "invalid", target: null };
  // Tags that resolve to the same URL (trailing slash, relative vs absolute) are one declaration, not a conflict.
  const resolvedKeys = unique(distinct.map((h) => { try { return normKey(new URL(h, pageUrl).toString()); } catch { return h; } }));
  if (resolvedKeys.length > 1) return { state: "multiple", target: distinct[0] };
  let page; let target;
  try {
    page = new URL(pageUrl);
    target = new URL(distinct[0], page);
  } catch {
    return { state: "invalid", target: distinct[0] };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return { state: "invalid", target: distinct[0] };
  const targetStr = normKey(target.toString());
  if (targetStr === normKey(page.toString())) return { state: "self", target: targetStr };
  const swapProtocol = new URL(target.toString());
  swapProtocol.protocol = page.protocol;
  if (normKey(swapProtocol.toString()) === normKey(page.toString())) return { state: "protocol_mismatch", target: targetStr };
  if (target.host !== page.host && stripWww(target.host) === stripWww(page.host)) return { state: "host_variant", target: targetStr };
  if (target.host === page.host) return { state: "other_page", target: targetStr };
  return { state: "cross_domain", target: targetStr };
}

/* ------------------------------------------------------------------ */
/* fetch + redirect classification                                    */
/* ------------------------------------------------------------------ */

/** What kind of redirect is this? slash | protocol | www | other */
export function redirectKind(from, to) {
  try {
    const a = new URL(from); const b = new URL(to);
    if (normKey(a.toString()) === normKey(b.toString())) return "slash";
    const swapped = new URL(b.toString()); swapped.protocol = a.protocol;
    if (a.protocol !== b.protocol && normKey(swapped.toString()) === normKey(a.toString())) return "protocol";
    if (a.protocol === b.protocol && a.host !== b.host && stripWww(a.host) === stripWww(b.host)
      && a.pathname === b.pathname && a.search === b.search) return "www";
  } catch { /* fall through */ }
  return "other";
}

/**
 * Collapses one URL's fetch record { status, errorCode, redirects } into a kind:
 * ok | redirect | broken | server_error | restricted | rate_limited | redirect_loop | redirect_offsite |
 * unreachable | timeout | non_html
 */
export function classifyFetch(rec) {
  const code = rec?.errorCode;
  if (code === "BAD_CONTENT_TYPE") return "non_html";
  if (code === "TIMEOUT") return "timeout";
  if (code === "TOO_MANY_REDIRECTS") return "redirect_loop";
  if (code === "REDIRECT_BLOCKED") return "redirect_offsite";
  const status = Number(rec?.status) || 0;
  if (status >= 200 && status < 300) return (rec.redirects?.length || 0) > 0 ? "redirect" : "ok";
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403 || status === 999) return "restricted"; // often bot-blocking, not a real error
  if (status >= 500) return "server_error";
  if (status >= 400) return "broken";
  if (code === "DNS_FAILED" || code === "CONNECTION" || code === "BLOCKED_ADDRESS" || code === "BLOCKED_HOST") return "unreachable";
  return "unreachable";
}

/* ------------------------------------------------------------------ */
/* link-check planning                                                */
/* ------------------------------------------------------------------ */

/**
 * url(normalised) -> Set of crawled pages that link to it, keyed by the URL exactly as it was linked.
 * Status findings (broken/redirecting links) need these literal targets; only the orphan/weak-link
 * maths in the crawler maps redirecting URLs onto the page they land on (aliasOf).
 */
export function buildInbound(pages, aliasOf = (u) => u) {
  const inbound = new Map();
  for (const p of pages) {
    for (const link of p.internalLinkUrls || []) {
      const target = normKey(aliasOf(link));
      if (target === normKey(p.url)) continue;
      if (!inbound.has(target)) inbound.set(target, new Set());
      inbound.get(target).add(p.url);
    }
  }
  return inbound;
}

/**
 * Chooses which not-yet-known URLs to status-check, most valuable first:
 * canonical targets, then internal link targets (most-linked first), then sitemap URLs.
 * `isAllowed(url)` keeps us from requesting URLs robots.txt disallows.
 */
export function selectLinkCheckCandidates({ pages, knownKeys, sitemapUrls = [], canonicalTargets = [], isAllowed = () => true, cap = 40 }) {
  const inbound = buildInbound(pages);
  const seen = new Set(knownKeys);
  const ordered = [];
  const take = (u) => {
    const k = normKey(u);
    if (seen.has(k) || !/^https?:\/\//i.test(k)) return;
    seen.add(k);
    if (isAllowed(u)) ordered.push(k);
  };
  canonicalTargets.forEach(take);
  [...inbound.entries()]
    .sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1))
    .forEach(([k]) => take(k));
  sitemapUrls.forEach(take);
  return { candidates: ordered.slice(0, cap), totalUnknown: ordered.length };
}

/**
 * Runs `fetchStatus(url)` over the candidates with bounded concurrency until `timeLeft()` runs low.
 * Returns the records fetched plus honest coverage numbers.
 */
export async function runLinkChecks({ candidates, fetchStatus, timeLeft, concurrency = 8, stopWhenLeftMs = 500 }) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length && timeLeft() > stopWhenLeftMs) {
      const url = candidates[cursor++];
      try {
        const rec = await fetchStatus(url);
        if (rec) results.push(rec);
      } catch { /* a failed probe is simply not counted as checked */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return { results, checked: results.length, skipped: Math.max(0, candidates.length - cursor) };
}

/* ------------------------------------------------------------------ */
/* the analysis                                                       */
/* ------------------------------------------------------------------ */

/**
 * facts: {
 *   startUrl,
 *   pages:    [{ url, finalUrl?, canonicalHrefs, noindex, noindexSource, internalLinkUrls }],
 *   statuses: [{ url, status, errorCode?, redirects: [{status,from,to}], finalUrl?, contentType? }],
 *   sitemap:  { urls, complete, missingConfirmed, parseError, hostMismatch: {count, host} | null } | null,
 *   robots:   { url, fetched, status, blocksGooglebot } | null,
 *   blockedByRobots: [url],       // internal URLs we skipped because robots.txt disallows them
 *   sitemapBlockedByRobots: [url],
 * }
 * Returns { findings, penalty, summary }.
 */
export function analyzeTechnical(facts) {
  const findings = [];
  const startKey = normKey(facts.startUrl);
  const pages = facts.pages || [];
  const inbound = buildInbound(pages);

  const statusByUrl = new Map();
  for (const r of facts.statuses || []) {
    const k = normKey(r.url);
    if (!statusByUrl.has(k)) statusByUrl.set(k, { ...r, kind: classifyFetch(r) });
  }
  const pageByUrl = new Map();
  for (const p of pages) {
    pageByUrl.set(normKey(p.url), p);
    if (p.finalUrl) pageByUrl.set(normKey(p.finalUrl), p);
  }
  const sitemapSet = new Set((facts.sitemap?.urls || []).map(normKey));
  const hasSitemap = sitemapSet.size > 0;

  const linkedFrom = (url) => [...(inbound.get(normKey(url)) || [])];
  const evidenceFor = (url, extra = {}) => {
    const sources = linkedFrom(url);
    const rec = statusByUrl.get(normKey(url));
    return {
      url,
      ...(rec ? { status: rec.status || undefined, kind: rec.kind } : {}),
      ...extra,
      ...(sources.length ? { linkedFrom: sources.slice(0, SOURCES_PER_EVIDENCE), linkedFromCount: sources.length } : {}),
    };
  };
  function add(f) {
    const urls = unique(f.urls || []).filter(Boolean);
    if (urls.length === 0) return;
    findings.push({ ...f, urls, evidence: (f.evidence || []).slice(0, EVIDENCE_CAP) });
  }

  /* ---------- indexability & robots ---------- */
  const home = pageByUrl.get(startKey);
  if (home?.noindex) {
    add({
      id: "tech_home_noindex", category: "Indexing", severity: "Critical",
      title: "The homepage is set to noindex",
      why: "A noindex directive tells search engines to keep this page out of their results. On the homepage that usually hides the whole site.",
      fix: `Remove the noindex directive (${home.noindexSource === "header" ? "X-Robots-Tag header" : "meta robots tag"}) from the homepage unless this is intentional.`,
      urls: [home.url], evidence: [{ url: home.url, note: `noindex via ${home.noindexSource || "meta"}` }],
    });
  }

  if (facts.robots?.blocksGooglebot) {
    add({
      id: "tech_robots_blocks_search", category: "Indexing", severity: "Critical",
      title: "robots.txt blocks Googlebot from the entire site",
      why: "Googlebot is disallowed from every URL, so Google cannot crawl these pages and they will not rank properly.",
      fix: "Edit robots.txt to remove the site-wide Disallow for Googlebot (and for * if it applies), unless the site is meant to stay out of search.",
      urls: [facts.robots.url], evidence: [{ url: facts.robots.url, note: "Disallow: / applies to Googlebot" }],
    });
  }
  if (facts.robots?.fetched && (facts.robots.status === 404 || facts.robots.status === 410)) {
    add({
      id: "tech_robots_missing", category: "Indexing", severity: "Low",
      title: "No robots.txt file found",
      why: "Without robots.txt, crawlers have no guidance and you can't declare your sitemap there.",
      fix: "Add a robots.txt at the site root that links to your XML sitemap (it can otherwise allow everything).",
      urls: [facts.robots.url], evidence: [{ url: facts.robots.url, status: facts.robots.status }],
    });
  }

  const noindexPages = pages.filter((p) => p.noindex && normKey(p.url) !== startKey);
  if (noindexPages.length > 0) {
    const share = noindexPages.length / Math.max(1, pages.length);
    add({
      id: "tech_noindex_pages", category: "Indexing", severity: share >= 0.25 ? "Medium" : "Low",
      title: `${noindexPages.length} crawled ${plural(noindexPages.length, "page is", "pages are")} set to noindex`,
      why: "Pages with noindex are excluded from search results. That's right for thank-you or admin pages and costly for pages meant to rank.",
      fix: "Review each URL and remove the noindex directive from any page that should appear in search.",
      urls: noindexPages.map((p) => p.url),
      evidence: noindexPages.map((p) => ({ url: p.url, note: `noindex via ${p.noindexSource || "meta"}` })),
    });
  }

  if ((facts.blockedByRobots || []).length > 0) {
    const list = unique(facts.blockedByRobots);
    add({
      id: "tech_links_blocked_by_robots", category: "Indexing", severity: "Low",
      title: `${list.length} internal ${plural(list.length, "URL", "URLs")} linked from your pages ${plural(list.length, "is", "are")} blocked by robots.txt`,
      why: "Search engines won't crawl these URLs, so anything on them can't be indexed from its content. VertexRank didn't crawl them either.",
      fix: "If these pages should rank, relax the matching Disallow rule; if not, consider removing the internal links to them.",
      urls: list, evidence: list.map((u) => evidenceFor(u)),
    });
  }

  /* ---------- status codes: broken links, server errors, restricted, unreachable ---------- */
  const linkedRecords = [...statusByUrl.values()].filter((r) => (inbound.get(normKey(r.url))?.size || 0) > 0 && normKey(r.url) !== startKey);
  const byKind = (kind) => linkedRecords.filter((r) => r.kind === kind);

  const broken = byKind("broken");
  if (broken.length > 0) {
    const codes = unique(broken.map((r) => r.status)).sort().join(", ");
    const fromHome = broken.some((r) => [...(inbound.get(normKey(r.url)) || [])].some((src) => normKey(src) === startKey));
    add({
      id: "tech_broken_links", category: "Technical", severity: fromHome ? "Critical" : "High",
      title: `${broken.length} broken internal ${plural(broken.length, "link", "links")} (${codes})`,
      why: "Links that lead to missing pages waste crawl budget, frustrate visitors and pass no ranking value.",
      fix: "Update each link to a working URL, or restore/redirect the missing page. The linking pages are listed with each URL.",
      urls: broken.map((r) => r.url), evidence: broken.map((r) => evidenceFor(r.url)),
    });
  }
  const serverErrors = byKind("server_error");
  if (serverErrors.length > 0) {
    add({
      id: "tech_server_errors", category: "Technical", severity: "High",
      title: `${serverErrors.length} internal ${plural(serverErrors.length, "URL returns", "URLs return")} a server error (5xx)`,
      why: "Server errors stop search engines and visitors from reaching the page, and repeated errors can get pages dropped from the index.",
      fix: "Check server logs for these URLs and fix the underlying error; if it was temporary, re-run the crawl to confirm.",
      urls: serverErrors.map((r) => r.url), evidence: serverErrors.map((r) => evidenceFor(r.url)),
    });
  }
  const restricted = byKind("restricted");
  if (restricted.length > 0) {
    add({
      id: "tech_restricted_links", category: "Technical", severity: "Low",
      title: `${restricted.length} internal ${plural(restricted.length, "link returns", "links return")} 401/403 to crawlers`,
      why: "These URLs refused our crawler. They may be login-only pages, or a firewall may be blocking bots — which could also be blocking search engines.",
      fix: "Confirm these are meant to be private. If not, allow crawlers through (and check your firewall/CDN bot rules).",
      urls: restricted.map((r) => r.url), evidence: restricted.map((r) => evidenceFor(r.url)),
    });
  }
  const unreachable = byKind("unreachable");
  if (unreachable.length > 0) {
    add({
      id: "tech_unreachable_links", category: "Technical", severity: "Medium",
      title: `${unreachable.length} internal ${plural(unreachable.length, "link points", "links point")} to ${plural(unreachable.length, "a URL", "URLs")} that could not be reached`,
      why: "The server didn't answer (DNS or connection failure), so neither visitors nor search engines can load these URLs.",
      fix: "Check the URLs for typos or a retired subdomain, and fix or remove the links.",
      urls: unreachable.map((r) => r.url), evidence: unreachable.map((r) => evidenceFor(r.url)),
    });
  }

  /* ---------- redirects ---------- */
  const redirected = linkedRecords.filter((r) => r.kind === "redirect");
  const realRedirects = redirected.filter((r) => redirectKind(r.redirects[0].from, r.finalUrl || r.redirects[r.redirects.length - 1].to) !== "slash");
  const slashRedirects = redirected.filter((r) => !realRedirects.includes(r));
  const finalOf = (r) => r.finalUrl || r.redirects[r.redirects.length - 1]?.to;
  if (realRedirects.length > 0) {
    add({
      id: "tech_redirecting_links", category: "Technical", severity: "Medium",
      title: `${realRedirects.length} internal ${plural(realRedirects.length, "link points", "links point")} to ${plural(realRedirects.length, "a URL that redirects", "URLs that redirect")}`,
      why: "Every redirect adds a round trip and dilutes the signal. Linking straight to the final URL is faster and cleaner.",
      fix: "Change each internal link to point at its final destination URL (shown in the evidence).",
      urls: realRedirects.map((r) => r.url),
      evidence: realRedirects.map((r) => evidenceFor(r.url, { finalUrl: finalOf(r), redirectStatus: r.redirects[0].status, redirectType: redirectKind(r.redirects[0].from, finalOf(r)) })),
    });
  }
  if (slashRedirects.length > 0) {
    add({
      id: "tech_slash_redirects", category: "Technical", severity: "Low",
      title: `${slashRedirects.length} ${plural(slashRedirects.length, "URL redirects", "URLs redirect")} only to add or remove a trailing slash`,
      why: "Mixing trailing-slash styles creates avoidable redirects and duplicate-URL risk.",
      fix: "Pick one style (with or without the trailing slash) and use it in internal links, canonicals and the sitemap.",
      urls: slashRedirects.map((r) => r.url), evidence: slashRedirects.map((r) => evidenceFor(r.url, { finalUrl: finalOf(r) })),
    });
  }
  const allRedirecting = [...statusByUrl.values()].filter((r) => (r.redirects?.length || 0) >= 2);
  if (allRedirecting.length > 0) {
    add({
      id: "tech_redirect_chains", category: "Technical", severity: allRedirecting.some((r) => r.redirects.length >= 3) ? "High" : "Medium",
      title: `${allRedirecting.length} redirect ${plural(allRedirecting.length, "chain", "chains")} with 2 or more hops`,
      why: "Chained redirects slow every request and search engines may stop following after a few hops.",
      fix: "Redirect the first URL straight to the final destination in a single hop, and update links to use the final URL.",
      urls: allRedirecting.map((r) => r.url),
      evidence: allRedirecting.map((r) => evidenceFor(r.url, { hops: r.redirects.length, chain: [r.redirects[0].from, ...r.redirects.map((h) => h.to)].join(" → ") })),
    });
  }
  const loops = [...statusByUrl.values()].filter((r) => r.kind === "redirect_loop");
  if (loops.length > 0) {
    add({
      id: "tech_redirect_loops", category: "Technical", severity: "High",
      title: `${loops.length} ${plural(loops.length, "URL gets", "URLs get")} stuck in a redirect loop`,
      why: "A redirect loop never resolves: visitors see an error and search engines drop the URL.",
      fix: "Fix the redirect rules for these URLs so each ends at a real page (check for conflicting www/https/slash rules).",
      urls: loops.map((r) => r.url), evidence: loops.map((r) => evidenceFor(r.url)),
    });
  }
  const downgrades = [...statusByUrl.values()].filter((r) => r.redirects?.length && /^https:/i.test(r.redirects[0].from) && /^http:/i.test(finalOf(r) || ""));
  if (downgrades.length > 0) {
    add({
      id: "tech_https_downgrade", category: "Technical", severity: "High",
      title: `${downgrades.length} ${plural(downgrades.length, "URL redirects", "URLs redirect")} from https to insecure http`,
      why: "Sending visitors from a secure page to http breaks HTTPS and trust signals, and browsers may warn users.",
      fix: "Make the redirect target the https version of the URL.",
      urls: downgrades.map((r) => r.url), evidence: downgrades.map((r) => evidenceFor(r.url, { finalUrl: finalOf(r) })),
    });
  }
  const offsite = byKind("redirect_offsite");
  if (offsite.length > 0) {
    add({
      id: "tech_offsite_redirects", category: "Technical", severity: "Low",
      title: `${offsite.length} internal ${plural(offsite.length, "link redirects", "links redirect")} to a different domain`,
      why: "These links leave your site via a redirect. VertexRank doesn't follow cross-domain redirects, so what lies beyond wasn't checked.",
      fix: "If the destination is intended, link to it directly (and consider rel attributes); if not, fix the redirect.",
      urls: offsite.map((r) => r.url), evidence: offsite.map((r) => evidenceFor(r.url)),
    });
  }

  /* ---------- canonicals ---------- */
  const canon = pages.map((p) => ({ page: p, ...classifyCanonical(p.finalUrl || p.url, p.canonicalHrefs || []) }));
  const withState = (...states) => canon.filter((c) => states.includes(c.state));
  const canonFinding = (id, severity, title, why, fix, list, note) => add({
    id, category: "Technical", severity, title, why, fix,
    urls: list.map((c) => c.page.url),
    evidence: list.map((c) => ({ url: c.page.url, canonical: c.target || "(empty)", ...(note ? { note: note(c) } : {}) })),
  });

  const multiple = withState("multiple");
  if (multiple.length) canonFinding("tech_canonical_multiple", "Medium",
    `${multiple.length} ${plural(multiple.length, "page declares", "pages declare")} more than one canonical URL`,
    "Conflicting canonical tags are ignored by search engines, so the signal is lost.",
    "Keep exactly one rel=canonical tag per page (check your theme and SEO plugin for duplicates).", multiple);
  const invalid = withState("invalid");
  if (invalid.length) canonFinding("tech_canonical_invalid", "High",
    `${invalid.length} ${plural(invalid.length, "page has", "pages have")} an empty or invalid canonical URL`,
    "A canonical that isn't a valid http(s) URL can't be used, so duplicate-URL signals aren't consolidated.",
    "Set the canonical to the absolute https URL of the preferred version of the page.", invalid);
  const proto = withState("protocol_mismatch");
  if (proto.length) canonFinding("tech_canonical_protocol", "High",
    `${proto.length} ${plural(proto.length, "page's canonical uses", "pages' canonicals use")} a different protocol (http vs https)`,
    "Pointing an https page at its http version tells search engines to prefer the insecure URL.",
    "Make canonicals use https.", proto, (c) => `page ${c.page.url} → canonical ${c.target}`);
  const hostVar = withState("host_variant");
  if (hostVar.length) canonFinding("tech_canonical_host", "Medium",
    `${hostVar.length} ${plural(hostVar.length, "page's canonical points", "pages' canonicals point")} to the www/non-www variant of the host`,
    "If your canonical host differs from the one the site actually serves, signals split across two hosts.",
    "Choose one host (www or not), redirect the other to it, and use it in every canonical.", hostVar, (c) => `canonical ${c.target}`);
  const cross = withState("cross_domain");
  if (cross.length) canonFinding("tech_canonical_cross_domain", "Medium",
    `${cross.length} ${plural(cross.length, "page's canonical points", "pages' canonicals point")} to a different domain`,
    "This tells search engines the content belongs to another site and your page may drop out of results. That's correct only for syndicated content.",
    "If unintentional, change the canonical to the page's own URL.", cross, (c) => `canonical ${c.target}`);

  // Canonicals pointing at other pages on this site: is the target healthy?
  const badTargets = [];
  const noindexTargets = [];
  const chains = [];
  for (const c of withState("other_page")) {
    const key = normKey(c.target);
    const rec = statusByUrl.get(key);
    const targetPage = pageByUrl.get(key);
    if (rec && (rec.kind === "broken" || rec.kind === "server_error")) badTargets.push({ c, why: `target returns ${rec.status}` });
    else if (rec && rec.kind === "redirect") badTargets.push({ c, why: `target redirects to ${finalOf(rec)}` });
    if (targetPage?.noindex) noindexTargets.push(c);
    if (targetPage) {
      const targetState = classifyCanonical(targetPage.finalUrl || targetPage.url, targetPage.canonicalHrefs || []).state;
      if (["other_page", "cross_domain", "host_variant"].includes(targetState)) chains.push(c);
    }
  }
  if (badTargets.length) add({
    id: "tech_canonical_bad_target", category: "Technical", severity: badTargets.some((b) => b.why.includes("returns")) ? "High" : "Medium",
    title: `${badTargets.length} ${plural(badTargets.length, "canonical points", "canonicals point")} to a URL that is broken or redirects`,
    why: "A canonical must point to a live, final URL. Otherwise search engines ignore it and may index the wrong version.",
    fix: "Point each canonical at the preferred page's final, working URL.",
    urls: badTargets.map((b) => b.c.page.url),
    evidence: badTargets.map((b) => ({ url: b.c.page.url, canonical: b.c.target, note: b.why })),
  });
  if (noindexTargets.length) canonFinding("tech_canonical_noindex_target", "High",
    `${noindexTargets.length} ${plural(noindexTargets.length, "canonical points", "canonicals point")} to a noindex page`,
    "Canonicalising to a page that's excluded from the index sends contradictory signals and can remove both URLs from results.",
    "Either remove the noindex from the target or canonicalise to an indexable page.", noindexTargets, (c) => `canonical ${c.target}`);
  if (chains.length) canonFinding("tech_canonical_chain", "Medium",
    `${chains.length} canonical ${plural(chains.length, "chain", "chains")} (the target's own canonical points elsewhere)`,
    "Search engines may not follow canonical chains, so the intended page may not receive the consolidated signals.",
    "Point every canonical directly at the final preferred URL.", chains, (c) => `canonical ${c.target}`);
  const noindexElsewhere = canon.filter((c) => c.page.noindex && ["other_page", "cross_domain", "host_variant"].includes(c.state));
  if (noindexElsewhere.length) canonFinding("tech_canonical_noindex_conflict", "Medium",
    `${noindexElsewhere.length} ${plural(noindexElsewhere.length, "page is", "pages are")} both noindex and canonicalised to another URL`,
    "These two directives conflict: noindex says to drop the page, canonical says to merge it into another.",
    "Use one: canonical to consolidate duplicates, or noindex to exclude the page.", noindexElsewhere, (c) => `canonical ${c.target}`);

  /* ---------- sitemap consistency ---------- */
  const sm = facts.sitemap;
  if (sm?.hostMismatch?.count > 0) {
    add({
      id: "tech_sitemap_host_mismatch", category: "Indexing", severity: "High",
      title: `Sitemap lists ${sm.hostMismatch.count} ${plural(sm.hostMismatch.count, "URL", "URLs")} on ${sm.hostMismatch.host}, not the host being crawled`,
      why: "A sitemap should only list URLs on the host it belongs to; URLs on another host (like www vs non-www) are ignored by search engines.",
      fix: "Make the sitemap use the same host as your canonical URLs (and redirect the other host to it).",
      urls: [sm.sourceUrl || facts.startUrl], evidence: [{ url: sm.sourceUrl || facts.startUrl, note: `${sm.hostMismatch.count} URLs on ${sm.hostMismatch.host}` }],
    });
  }
  if (sm?.missingConfirmed) {
    add({
      id: "tech_sitemap_missing", category: "Indexing", severity: "Medium",
      title: "No XML sitemap found",
      why: "A sitemap helps search engines discover every page you want indexed, especially new or deeply-linked ones.",
      fix: "Publish an XML sitemap (for example at /sitemap.xml) and reference it in robots.txt.",
      urls: [`${new URL(facts.startUrl).origin}/sitemap.xml`], evidence: [{ url: `${new URL(facts.startUrl).origin}/sitemap.xml`, status: 404 }],
    });
  }
  if (sm?.parseError) {
    add({
      id: "tech_sitemap_invalid", category: "Indexing", severity: "Medium",
      title: "The XML sitemap could not be parsed",
      why: "If the sitemap isn't valid XML, search engines can't read it and ignore it.",
      fix: "Validate the sitemap against the sitemaps.org format and fix the errors.",
      urls: [sm.sourceUrl || facts.startUrl], evidence: [{ url: sm.sourceUrl || facts.startUrl }],
    });
  }

  let sitemapChecked = 0;
  if (hasSitemap) {
    const sitemapRecs = [...sitemapSet].map((k) => statusByUrl.get(k)).filter(Boolean);
    sitemapChecked = sitemapRecs.length;
    const coverage = `${sitemapChecked} of ${sitemapSet.size} sitemap ${plural(sitemapSet.size, "URL", "URLs")} checked`;

    const smErrors = sitemapRecs.filter((r) => r.kind === "broken" || r.kind === "server_error");
    if (smErrors.length) add({
      id: "tech_sitemap_errors", category: "Indexing", severity: "High",
      title: `${smErrors.length} sitemap ${plural(smErrors.length, "URL returns", "URLs return")} an error (${coverage})`,
      why: "A sitemap should only list live pages. Error URLs waste crawl budget and make the whole sitemap look unreliable.",
      fix: "Remove these URLs from the sitemap or fix/redirect the pages.",
      urls: smErrors.map((r) => r.url), evidence: smErrors.map((r) => ({ url: r.url, status: r.status, kind: r.kind })),
    });
    const smRedirects = sitemapRecs.filter((r) => r.kind === "redirect" && redirectKind(r.redirects[0].from, finalOf(r)) !== "slash");
    if (smRedirects.length) add({
      id: "tech_sitemap_redirects", category: "Indexing", severity: "Medium",
      title: `${smRedirects.length} sitemap ${plural(smRedirects.length, "URL redirects", "URLs redirect")} (${coverage})`,
      why: "Sitemaps should list final URLs. Redirecting entries slow discovery and may be treated as low quality.",
      fix: "Replace each sitemap entry with its final destination URL.",
      urls: smRedirects.map((r) => r.url), evidence: smRedirects.map((r) => ({ url: r.url, finalUrl: finalOf(r), redirectStatus: r.redirects[0].status })),
    });
    const smNoindex = pages.filter((p) => p.noindex && sitemapSet.has(normKey(p.url)));
    if (smNoindex.length) add({
      id: "tech_sitemap_noindex", category: "Indexing", severity: "High",
      title: `${smNoindex.length} sitemap ${plural(smNoindex.length, "URL is", "URLs are")} set to noindex`,
      why: "The sitemap asks search engines to index these pages while the pages say not to — a direct contradiction.",
      fix: "Remove the noindex from pages that should rank, or take them out of the sitemap.",
      urls: smNoindex.map((p) => p.url), evidence: smNoindex.map((p) => ({ url: p.url, note: `noindex via ${p.noindexSource || "meta"}` })),
    });
    const smCanon = canon.filter((c) => sitemapSet.has(normKey(c.page.url)) && ["other_page", "cross_domain", "host_variant", "protocol_mismatch"].includes(c.state));
    if (smCanon.length) add({
      id: "tech_sitemap_noncanonical", category: "Indexing", severity: "Medium",
      title: `${smCanon.length} sitemap ${plural(smCanon.length, "URL is", "URLs are")} canonicalised to a different URL`,
      why: "Sitemaps should list only canonical URLs; listing duplicates sends mixed signals about which version to index.",
      fix: "List the canonical version in the sitemap instead.",
      urls: smCanon.map((c) => c.page.url), evidence: smCanon.map((c) => ({ url: c.page.url, canonical: c.target })),
    });
    if ((facts.sitemapBlockedByRobots || []).length) {
      const list = unique(facts.sitemapBlockedByRobots);
      add({
        id: "tech_sitemap_blocked", category: "Indexing", severity: "High",
        title: `${list.length} sitemap ${plural(list.length, "URL is", "URLs are")} blocked by robots.txt`,
        why: "The sitemap invites crawlers to URLs that robots.txt forbids them from fetching.",
        fix: "Remove the URLs from the sitemap or relax the robots.txt rule.",
        urls: list, evidence: list.map((u) => ({ url: u })),
      });
    }
    if (sm.complete) {
      const missing = [...statusByUrl.values()].filter((r) => {
        const k = normKey(r.url);
        if (r.kind !== "ok" || sitemapSet.has(k) || k.includes("?")) return false;
        if (!(inbound.get(k)?.size > 0)) return false;
        if (r.contentType && !/html/i.test(r.contentType)) return false;
        const pg = pageByUrl.get(k);
        if (pg?.noindex) return false;
        if (pg && !["self", "missing"].includes(classifyCanonical(pg.finalUrl || pg.url, pg.canonicalHrefs || []).state)) return false;
        return true;
      });
      if (missing.length) add({
        id: "tech_sitemap_missing_pages", category: "Indexing", severity: "Low",
        title: `${missing.length} ${plural(missing.length, "page linked from your site is", "pages linked from your site are")} not in the sitemap`,
        why: "Pages the site links to but the sitemap omits may be slower to be discovered and indexed.",
        fix: "Add any of these that should rank to the sitemap (or generate the sitemap automatically from your CMS).",
        urls: missing.map((r) => r.url), evidence: missing.map((r) => evidenceFor(r.url)),
      });
    }
  }

  /* ---------- totals ---------- */
  const penalty = Math.min(MAX_SITE_PENALTY, findings.reduce((s, f) => s + (SEVERITY_PENALTY[f.severity] || 0), 0));
  const summary = {
    pagesCrawled: pages.length,
    urlsStatusChecked: statusByUrl.size,
    noindexPages: pages.filter((p) => p.noindex).length,
    brokenLinks: broken.length,
    redirectingLinks: realRedirects.length,
    canonicalProblems: canon.filter((c) => ["multiple", "invalid", "protocol_mismatch", "host_variant", "cross_domain"].includes(c.state)).length + badTargets.length,
    sitemapUrls: sitemapSet.size,
    sitemapUrlsChecked: sitemapChecked,
  };
  return { findings, penalty, summary };
}
