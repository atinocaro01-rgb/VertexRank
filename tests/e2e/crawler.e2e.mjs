// End-to-end run of the REAL lib/siteCrawler.js control flow over a fake website.
// Only two things are replaced (see hooks.mjs): cheerio -> a tiny stand-in, safeFetch -> an in-memory web.
// What this verifies: the glue — start-URL probe, robots/sitemap discovery, page records, redirect
// aliasing, header-only link checks, and hand-off to the technical analysis. It does NOT verify real
// cheerio behaviour or real network behaviour (safeFetch has its own tests).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);
const { crawlSite } = await import("../../lib/siteCrawler.js");

const page = ({ title = "A page", canonical, robots, links = [], body = "" } = {}) => ({
  type: "text/html; charset=utf-8",
  body: `<html><head><title>${title}</title><meta name="description" content="d ${title}">` +
    (canonical !== undefined ? `<link rel="canonical" href="${canonical}">` : "") +
    (robots ? `<meta name="robots" content="${robots}">` : "") +
    `</head><body><h1>${title}</h1><p>${body || ("words about " + title + " ").repeat(80)}</p>${links.map((l) => `<a href="${l}">link</a>`).join("")}</body></html>`,
});
const sitemap = (urls) => ({ type: "application/xml", body: `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>` });
const text = (body) => ({ type: "text/plain", body });
const ids = (r) => r.siteWide.technical.findings.map((f) => f.id);
const finding = (r, id) => r.siteWide.technical.findings.find((f) => f.id === id);

function setWeb(web) { globalThis.__web = web; globalThis.__requests = []; }

function messySite(A = "https://a.com") {
  return {
    [`${A}/`]: page({ title: "Home", canonical: `${A}/`, links: ["/about", "/old", "/gone", "/noindex-page", "/canon-bad", "/private/x", "/chain"] }),
    [`${A}/about`]: page({ title: "About", canonical: `${A}/about`, links: ["/"] }),
    [`${A}/noindex-page`]: page({ title: "Thanks", canonical: `${A}/noindex-page`, robots: "noindex, follow" }),
    [`${A}/canon-bad`]: page({ title: "Canon bad", canonical: `${A}/canon-target-404` }),
    [`${A}/new`]: page({ title: "New", canonical: `${A}/new` }),
    [`${A}/old`]: { status: 301, location: "/new" },
    [`${A}/chain`]: { status: 301, location: "/chain2" },
    [`${A}/chain2`]: { status: 301, location: "/chain3" },
    [`${A}/chain3`]: page({ title: "Chain end", canonical: `${A}/chain3` }),
    [`${A}/gone`]: { status: 404, body: "nope" },
    [`${A}/canon-target-404`]: { status: 404, body: "nope" },
    [`${A}/robots.txt`]: text(`User-agent: *\nDisallow: /private\nSitemap: ${A}/sitemap.xml\n`),
    [`${A}/sitemap.xml`]: sitemap([`${A}/`, `${A}/about`, `${A}/noindex-page`, `${A}/gone`, `${A}/new`, `${A}/canon-bad`, "https://www.a.com/x"]),
  };
}

test("messy site: every kind of technical problem is found, with the right evidence", async () => {
  setWeb(messySite());
  const r = await crawlSite("https://a.com");
  assert.ok(!r.error, r.error);
  assert.match(r.crawlId, /^[0-9a-f-]{36}$/);
  assert.equal(r.discoveryMethod, "sitemap");
  assert.deepEqual(r.pages.map((p) => p.url).sort(), ["https://a.com/", "https://a.com/about", "https://a.com/canon-bad", "https://a.com/new", "https://a.com/noindex-page"]);

  for (const id of [
    "tech_broken_links", "tech_sitemap_errors", "tech_redirecting_links", "tech_redirect_chains", "tech_sitemap_noindex", "tech_noindex_pages",
    "tech_canonical_bad_target", "tech_sitemap_noncanonical", "tech_links_blocked_by_robots", "tech_sitemap_host_mismatch",
  ]) assert.ok(ids(r).includes(id), `missing finding ${id}; got ${ids(r).join(", ")}`);

  assert.deepEqual(finding(r, "tech_broken_links").urls, ["https://a.com/gone"]);
  assert.equal(finding(r, "tech_broken_links").severity, "Critical"); // linked from the homepage
  assert.deepEqual(finding(r, "tech_broken_links").evidence[0].linkedFrom, ["https://a.com/"]);
  const red = finding(r, "tech_redirecting_links").evidence.find((e) => e.url === "https://a.com/old");
  assert.equal(red.finalUrl, "https://a.com/new"); assert.equal(red.redirectStatus, 301);
  assert.match(finding(r, "tech_redirect_chains").evidence[0].chain, /chain → .*chain2 → .*chain3/);
  assert.deepEqual(finding(r, "tech_links_blocked_by_robots").urls, ["https://a.com/private/x"]);
  assert.equal(finding(r, "tech_sitemap_host_mismatch").title.includes("www.a.com"), true);
  assert.equal(finding(r, "tech_canonical_bad_target").evidence[0].canonical, "https://a.com/canon-target-404");

  // /new is only linked via the redirecting /old — the redirect alias must keep it from looking like an orphan.
  assert.ok(!r.siteWide.orphanPages.includes("https://a.com/new"), "alias should count /old -> /new as an inbound link");

  // Link/canonical checks are header-only and never touch the robots-blocked URL.
  const log = globalThis.__requests;
  assert.ok(log.some((q) => q.url === "https://a.com/chain" && q.headersOnly));
  assert.ok(!log.some((q) => q.url.includes("/private/x")), "robots-blocked URL must not be requested");
  assert.ok(!log.some((q) => q.url === "https://a.com/chain" && !q.headersOnly));

  // Technical score = page average minus the capped site-level penalty (and says so).
  const d = r.siteScores.technicalDetail;
  assert.ok(d.siteLevelPenalty > 0 && d.siteLevelPenalty <= 35);
  assert.ok(r.siteScores.technical < d.pageAverage);
  const cov = r.siteWide.technical.coverage;
  assert.ok(cov.linkChecks.checked > 0 && cov.sitemap.found && cov.sitemap.listed === 6);
});

test("start URL redirect (apex -> www) is followed once and the site is judged on the www host", async () => {
  const W = "https://www.a.com";
  setWeb({
    "https://a.com/": { status: 301, location: `${W}/` },
    [`${W}/`]: page({ title: "Home", canonical: `${W}/`, links: ["/about"] }),
    [`${W}/about`]: page({ title: "About", canonical: `${W}/about`, links: ["/"] }),
    [`${W}/robots.txt`]: text(`User-agent: *\nDisallow:\n`),
    [`${W}/sitemap.xml`]: sitemap([`${W}/`, `${W}/about`]),
  });
  const r = await crawlSite("a.com");
  assert.equal(r.domain, "www.a.com");
  assert.equal(r.startRedirect.to, `${W}/`); assert.equal(r.startRedirect.hops, 1);
  assert.equal(r.inputUrl, "https://a.com/");
  assert.equal(r.pagesCrawled, 2);
  assert.ok(!ids(r).includes("tech_sitemap_host_mismatch"));
  assert.deepEqual(ids(r), []);
});

test("a robots.txt that blocks the start URL stops the crawl with an explanation", async () => {
  setWeb({ "https://a.com/": page({}), "https://a.com/robots.txt": text("User-agent: *\nDisallow: /\n"), "https://a.com/sitemap.xml": { status: 404 } });
  const r = await crawlSite("https://a.com");
  assert.match(r.error, /robots\.txt/); assert.match(r.error, /respects robots\.txt/);
  assert.ok(!globalThis.__requests.some((q) => q.url === "https://a.com/" && !q.headersOnly), "must not fetch the blocked page body");
});

test("robots.txt that blocks only Googlebot site-wide is a Critical finding (crawl still works)", async () => {
  setWeb({
    "https://a.com/": page({ canonical: "https://a.com/", links: ["/about"] }), "https://a.com/about": page({ canonical: "https://a.com/about", links: ["/"] }),
    "https://a.com/robots.txt": text("User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nDisallow:\n"), "https://a.com/sitemap.xml": { status: 404 },
  });
  const r = await crawlSite("https://a.com");
  assert.equal(finding(r, "tech_robots_blocks_search").severity, "Critical");
  assert.equal(r.pagesCrawled, 2);
});

test("no sitemap and no robots.txt: link discovery, and both gaps are reported", async () => {
  setWeb({
    "https://a.com/": page({ canonical: "https://a.com/", links: ["/about"] }), "https://a.com/about": page({ canonical: "https://a.com/about", links: ["/"] }),
    "https://a.com/robots.txt": { status: 404, body: "" }, "https://a.com/sitemap.xml": { status: 404, body: "" },
  });
  const r = await crawlSite("https://a.com");
  assert.equal(r.discoveryMethod, "links"); assert.equal(r.pagesCrawled, 2);
  assert.ok(ids(r).includes("tech_sitemap_missing")); assert.ok(ids(r).includes("tech_robots_missing"));
});

test("a clean site produces no technical findings and no penalty", async () => {
  setWeb({
    "https://a.com/": page({ canonical: "https://a.com/", links: ["/about", "/blog"] }),
    "https://a.com/about": page({ canonical: "https://a.com/about", links: ["/", "/blog"] }), "https://a.com/blog": page({ canonical: "https://a.com/blog", links: ["/", "/about"] }),
    "https://a.com/robots.txt": text("User-agent: *\nDisallow:\nSitemap: https://a.com/sitemap.xml"),
    "https://a.com/sitemap.xml": sitemap(["https://a.com/", "https://a.com/about", "https://a.com/blog"]),
  });
  const r = await crawlSite("https://a.com");
  assert.deepEqual(ids(r), []); assert.equal(r.siteWide.technical.penalty, 0);
  assert.equal(r.siteScores.technical, r.siteScores.technicalDetail.pageAverage);
});

test("private/invalid input is rejected before any request", async () => {
  setWeb({});
  assert.match((await crawlSite("not a url at all !!")).error ?? "", /valid URL|isn't/);
});
