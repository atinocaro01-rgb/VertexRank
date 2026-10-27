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
const { analyzeMarket } = await import("../../lib/marketChecks.js");

const page = ({ title = "A page", canonical, robots, links = [], body = "", lang, hreflangs = [], tel, jsonld, generator, scripts = [], styles = [], root = false, headers } = {}) => ({
  headers,
  type: "text/html; charset=utf-8",
  body: `<html${lang ? ` lang="${lang}"` : ""}><head><title>${title}</title><meta name="description" content="d ${title}">` +
    (canonical !== undefined ? `<link rel="canonical" href="${canonical}">` : "") +
    (robots ? `<meta name="robots" content="${robots}">` : "") +
    (generator ? `<meta name="generator" content="${generator}">` : "") +
    styles.map((h) => `<link rel="stylesheet" href="${h}">`).join("") +
    hreflangs.map(([l, h]) => `<link rel="alternate" hreflang="${l}" href="${h}">`).join("") +
    (jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : "") +
    `</head><body><h1>${title}</h1><p>${body || ("words about " + title + " ").repeat(80)}</p>${links.map((l) => `<a href="${l}">link</a>`).join("")}${tel ? `<a href="tel:${tel}">call</a>` : ""}${root ? '<div id="root"></div>' : ""}${scripts.map((src) => `<script src="${src}"></script>`).join("")}</body></html>`,
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

test("market signals are extracted from real crawl output and judged against the selected country", async () => {
  const A = "https://a.com";
  const ld = { "@context": "https://schema.org", "@type": "LocalBusiness", name: "Shop", telephone: "+1 555 0100", address: { "@type": "PostalAddress", addressCountry: "US" }, makesOffer: { "@type": "Offer", priceCurrency: "USD" } };
  setWeb({
    [`${A}/`]: page({ title: "Home", canonical: `${A}/`, lang: "de", links: ["/about"], tel: "+1%20555%200100", jsonld: ld,
      hreflangs: [["en_US", `${A}/us`], ["de-DE", `${A}/`]] }),
    [`${A}/about`]: page({ title: "About", canonical: `${A}/about`, links: ["/"] }),
    [`${A}/robots.txt`]: text("User-agent: *\nDisallow:\n"), [`${A}/sitemap.xml`]: { status: 404, body: "" },
  });
  const r = await crawlSite("https://a.com");
  const home = r.pages.find((p) => p.url === `${A}/`);
  assert.equal(home.htmlLang, "de");
  assert.deepEqual(home.hreflangs, [{ lang: "en_US", href: `${A}/us` }, { lang: "de-DE", href: `${A}/` }]);
  assert.deepEqual(home.telLinks, ["+1 555 0100"]);
  assert.deepEqual(home.schemaSignals.addressCountries, ["US"]); assert.deepEqual(home.schemaSignals.currencies, ["USD"]);
  assert.equal(home.schemaSignals.hasLocalBusiness, true);
  assert.equal(r.pages.find((p) => p.url === `${A}/about`).htmlLang, ""); // no lang attribute

  // The same crawl, judged for two different markets: the country selection alone changes the findings.
  const ids = (country) => analyzeMarket(r, country).map((f) => f.id);
  assert.deepEqual(analyzeMarket(r, "Worldwide"), []);
  const ke = ids("Kenya");
  for (const id of ["mkt_lang_mismatch", "mkt_lang_missing", "mkt_hreflang_invalid", "mkt_hreflang_no_default", "mkt_schema_country", "mkt_schema_currency", "mkt_phone_country"]) assert.ok(ke.includes(id), `Kenya: missing ${id} in ${ke}`);
  assert.ok(!ke.includes("mkt_no_local_signals"));
  const de = ids("Germany");
  assert.ok(!de.includes("mkt_lang_mismatch")); assert.ok(de.includes("mkt_schema_country")); // German page is fine for Germany; a US address still isn't
  const us = ids("United States");
  assert.ok(!us.includes("mkt_schema_country") && !us.includes("mkt_schema_currency") && !us.includes("mkt_phone_country"));
});

test("stack: a client-rendered app is flagged (with the empty pages listed) and plain HTML on GitHub Pages is recognised", async () => {
  const A = "https://spa.example";
  const shell = (path) => page({ title: "App", canonical: `${A}${path}`, body: "x", root: true, scripts: ["/static/js/main.4f3a.js"], links: ["/", "/about"] });
  setWeb({
    [`${A}/`]: shell("/"), [`${A}/about`]: shell("/about"),
    [`${A}/robots.txt`]: text("User-agent: *\nDisallow:\n"), [`${A}/sitemap.xml`]: { status: 404, body: "" },
  });
  const spa = await crawlSite(A);
  assert.equal(spa.stack.rendering.type, "client-rendered"); assert.equal(spa.stack.jsRendering.needed, true);
  assert.deepEqual(spa.stack.jsRendering.pages.sort(), [`${A}/`, `${A}/about`]);
  assert.ok(spa.stack.technologies.some((t) => t.name === "React"));
  assert.match(spa.stack.summary, /renders in the browser/);
  // the saved crawl must not carry the bulky per-page asset lists (browser storage is limited)
  for (const p of spa.pages) { assert.equal(p.scriptSrcs, undefined); assert.equal(p.stylesheetHrefs, undefined); assert.ok(Array.isArray(p.mounts)); }

  const B = "https://static.example";
  const gh = { server: "GitHub.com", "x-github-request-id": "ABCD" };
  setWeb({
    [`${B}/`]: page({ title: "Home", canonical: `${B}/`, links: ["/about"], scripts: ["/js/site.js"], styles: ["/css/bootstrap.min.css"], headers: gh }),
    [`${B}/about`]: page({ title: "About", canonical: `${B}/about`, links: ["/"], headers: gh }),
    [`${B}/robots.txt`]: text("User-agent: *\nDisallow:\n"), [`${B}/sitemap.xml`]: { status: 404, body: "" },
  });
  const html = await crawlSite(B);
  assert.equal(html.stack.rendering.type, "static-html"); assert.equal(html.stack.github.suitability, "high");
  assert.equal(html.stack.hosting[0].name, "GitHub Pages"); assert.equal(html.stack.jsRendering.needed, false);
  assert.match(html.stack.summary, /Plain HTML · on GitHub Pages/);
});

test("images with no alt attribute are recorded by src (alt=\"\" is decorative and is not a fix target)", async () => {
  const A = "https://img.example";
  setWeb({
    [`${A}/`]: page({ title: "Home", canonical: `${A}/`, links: ["/b"], body: '<img src="/cat.png"><img src="/cat.png"><img src="/dog.png" alt=""><img src="/ok.png" alt="fine"><img alt="x">' }),
    [`${A}/b`]: page({ title: "B", canonical: `${A}/b`, links: ["/"] }),
    [`${A}/robots.txt`]: text("User-agent: *\nDisallow:\n"), [`${A}/sitemap.xml`]: { status: 404, body: "" },
  });
  const r = await crawlSite(A);
  const home = r.pages.find((p) => p.url === `${A}/`);
  assert.deepEqual(home.missingAltSrcs, ["/cat.png"]); // de-duplicated; alt="" and alt="fine" excluded; no-src image ignored
  assert.equal(home.imagesMissingAlt, 3); // the audit still counts empty alt as "missing" — different question
});
