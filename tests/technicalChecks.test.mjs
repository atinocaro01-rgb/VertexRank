import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRobotsDirectives, classifyCanonical, redirectKind, classifyFetch,
  selectLinkCheckCandidates, runLinkChecks, analyzeTechnical, normKey,
} from "../lib/technicalChecks.js";

const H = "https://a.com/";
const page = (url, o = {}) => ({ url, canonicalHrefs: [url], noindex: false, internalLinkUrls: [], ...o });
const ok = (url, o = {}) => ({ url, status: 200, redirects: [], ...o });
const redir = (from, to, status = 301) => ({ url: from, status: 200, redirects: [{ status, from, to }], finalUrl: to });
const facts = (o = {}) => ({ startUrl: H, pages: [page(H)], statuses: [ok(H)], sitemap: null, robots: null, blockedByRobots: [], sitemapBlockedByRobots: [], ...o });
const byId = (r, id) => r.findings.find((f) => f.id === id);

test("parseRobotsDirectives: meta, header, none, agent scoping, value directives", () => {
  assert.deepEqual(parseRobotsDirectives(["noindex, follow"], ""), { noindex: true, nofollow: false, noindexSource: "meta" });
  assert.equal(parseRobotsDirectives(["none"]).nofollow, true);
  assert.equal(parseRobotsDirectives([], "noindex").noindexSource, "header");
  assert.equal(parseRobotsDirectives([], "googlebot: noindex, nofollow").noindex, true);
  assert.equal(parseRobotsDirectives([], "bingbot: noindex").noindex, false);
  assert.equal(parseRobotsDirectives([], "unavailable_after: 25 Jun 2030 15:00:00 PST").noindex, false);
  assert.equal(parseRobotsDirectives(["index, follow"], "").noindex, false);
  assert.equal(parseRobotsDirectives(undefined, undefined).noindex, false);
});

test("classifyCanonical covers every state", () => {
  const p = "https://a.com/blog/post";
  assert.equal(classifyCanonical(p, []).state, "missing");
  assert.equal(classifyCanonical(p, [""]).state, "invalid");
  assert.equal(classifyCanonical(p, ["javascript:void(0)"]).state, "invalid");
  assert.equal(classifyCanonical(p, ["https://a.com/blog/post", "https://a.com/other"]).state, "multiple");
  assert.equal(classifyCanonical(p, ["https://a.com/blog/post/", "https://a.com/blog/post"]).state, "self"); // same URL twice = one
  assert.equal(classifyCanonical(p, ["/blog/post/"]).state, "self"); // relative + trailing slash
  assert.equal(classifyCanonical(p, ["http://a.com/blog/post"]).state, "protocol_mismatch");
  assert.equal(classifyCanonical(p, ["https://www.a.com/blog/post"]).state, "host_variant");
  assert.equal(classifyCanonical(p, ["https://a.com/blog"]).state, "other_page");
  assert.equal(classifyCanonical(p, ["https://other.com/blog/post"]).state, "cross_domain");
});

test("redirectKind and classifyFetch", () => {
  assert.equal(redirectKind("https://a.com/x", "https://a.com/x/"), "slash");
  assert.equal(redirectKind("http://a.com/x", "https://a.com/x"), "protocol");
  assert.equal(redirectKind("https://a.com/x", "https://www.a.com/x"), "www");
  assert.equal(redirectKind("https://a.com/x", "https://a.com/y"), "other");
  assert.equal(classifyFetch({ status: 200, redirects: [] }), "ok");
  assert.equal(classifyFetch({ status: 200, redirects: [{}] }), "redirect");
  assert.equal(classifyFetch({ status: 404 }), "broken");
  assert.equal(classifyFetch({ status: 410 }), "broken");
  assert.equal(classifyFetch({ status: 503 }), "server_error");
  for (const s of [401, 403, 999]) assert.equal(classifyFetch({ status: s }), "restricted");
  assert.equal(classifyFetch({ status: 429 }), "rate_limited");
  assert.equal(classifyFetch({ status: 0, errorCode: "TIMEOUT" }), "timeout");
  assert.equal(classifyFetch({ status: 0, errorCode: "CONNECTION" }), "unreachable");
  assert.equal(classifyFetch({ status: 301, errorCode: "TOO_MANY_REDIRECTS" }), "redirect_loop");
  assert.equal(classifyFetch({ status: 302, errorCode: "REDIRECT_BLOCKED" }), "redirect_offsite");
  assert.equal(classifyFetch({ status: 200, errorCode: "BAD_CONTENT_TYPE" }), "non_html");
});

test("timeouts, rate limits and bot-blocks are NOT reported as broken links", () => {
  const home = page(H, { internalLinkUrls: ["https://a.com/t", "https://a.com/r", "https://a.com/f"] });
  const r = analyzeTechnical(facts({ pages: [home], statuses: [ok(H),
    { url: "https://a.com/t", status: 0, errorCode: "TIMEOUT", redirects: [] },
    { url: "https://a.com/r", status: 429, redirects: [] },
    { url: "https://a.com/f", status: 403, redirects: [] }] }));
  assert.equal(byId(r, "tech_broken_links"), undefined);
  assert.equal(byId(r, "tech_restricted_links").severity, "Low"); // 403 gets a soft, caveated finding
  assert.equal(r.findings.length, 1);
});

test("selectLinkCheckCandidates: priority, dedupe, robots, cap", () => {
  const pages = [
    page(H, { internalLinkUrls: ["https://a.com/a", "https://a.com/b", "https://a.com/c", "https://a.com/private/x"] }),
    page("https://a.com/a", { internalLinkUrls: ["https://a.com/b", "https://a.com/c"] }),
  ];
  const { candidates, totalUnknown } = selectLinkCheckCandidates({
    pages, knownKeys: new Set([normKey(H), normKey("https://a.com/a")]),
    canonicalTargets: ["https://a.com/canon-target", "https://a.com/b"],
    sitemapUrls: ["https://a.com/from-sitemap", "https://a.com/c"],
    isAllowed: (u) => !u.includes("/private/"), cap: 4,
  });
  assert.deepEqual(candidates, ["https://a.com/canon-target", "https://a.com/b", "https://a.com/c", "https://a.com/from-sitemap"]);
  assert.equal(totalUnknown, 4);
});

test("runLinkChecks respects the time budget and survives failing probes", async () => {
  let left = 5; // "ms" budget in call units
  const seen = [];
  const out = await runLinkChecks({
    candidates: ["u1", "u2", "u3", "u4", "u5", "u6"], concurrency: 1, stopWhenLeftMs: 0,
    timeLeft: () => left--, fetchStatus: async (u) => { seen.push(u); if (u === "u2") throw new Error("boom"); return { url: u, status: 200 }; },
  });
  assert.ok(out.checked < 6 && out.skipped > 0);
  assert.equal(out.checked + out.skipped + (seen.includes("u2") ? 1 : 0), 6);
});

test("clean site: no findings, no penalty", () => {
  const r = analyzeTechnical(facts());
  assert.deepEqual(r.findings, []); assert.equal(r.penalty, 0);
});

test("broken internal links: evidence names the linking pages; Critical when linked from the homepage", () => {
  const deep = page("https://a.com/deep", { internalLinkUrls: ["https://a.com/gone"] });
  const r1 = analyzeTechnical(facts({ pages: [page(H, { internalLinkUrls: ["https://a.com/deep"] }), deep], statuses: [ok(H), ok(deep.url), ok("https://a.com/gone", { status: 404 })] }));
  const f = byId(r1, "tech_broken_links");
  assert.equal(f.severity, "High"); assert.deepEqual(f.urls, ["https://a.com/gone"]);
  assert.deepEqual(f.evidence[0].linkedFrom, ["https://a.com/deep"]); assert.equal(f.evidence[0].status, 404);
  assert.match(f.title, /1 broken internal link \(404\)/);
  const r2 = analyzeTechnical(facts({ pages: [page(H, { internalLinkUrls: ["https://a.com/gone"] })], statuses: [ok(H), ok("https://a.com/gone", { status: 410 })] }));
  assert.equal(byId(r2, "tech_broken_links").severity, "Critical");
});

test("a broken URL nobody links to is not a 'broken link' (it can still show up via the sitemap)", () => {
  const r = analyzeTechnical(facts({ statuses: [ok(H), ok("https://a.com/orphan", { status: 404 })] }));
  assert.equal(byId(r, "tech_broken_links"), undefined);
});

test("server errors, unreachable URLs", () => {
  const home = page(H, { internalLinkUrls: ["https://a.com/e", "https://a.com/d"] });
  const r = analyzeTechnical(facts({ pages: [home], statuses: [ok(H), ok("https://a.com/e", { status: 502 }), { url: "https://a.com/d", status: 0, errorCode: "DNS_FAILED", redirects: [] }] }));
  assert.equal(byId(r, "tech_server_errors").severity, "High");
  assert.equal(byId(r, "tech_unreachable_links").severity, "Medium");
});

test("redirects: real redirects vs slash-only vs chains vs loops vs https downgrade vs off-site", () => {
  const home = page(H, { internalLinkUrls: ["https://a.com/old", "https://a.com/slash", "https://a.com/chain", "https://a.com/loop", "https://a.com/down", "https://a.com/away"] });
  const r = analyzeTechnical(facts({ pages: [home], statuses: [ok(H),
    redir("https://a.com/old", "https://a.com/new", 302),
    redir("https://a.com/slash", "https://a.com/slash/"),
    { url: "https://a.com/chain", status: 200, finalUrl: "https://a.com/c3", redirects: [{ status: 301, from: "https://a.com/chain", to: "https://a.com/c2" }, { status: 301, from: "https://a.com/c2", to: "https://a.com/c3" }, { status: 301, from: "https://a.com/c3", to: "https://a.com/c4" }] },
    { url: "https://a.com/loop", status: 301, errorCode: "TOO_MANY_REDIRECTS", redirects: [] },
    redir("https://a.com/down", "http://a.com/down"),
    { url: "https://a.com/away", status: 302, errorCode: "REDIRECT_BLOCKED", redirects: [] }] }));
  const rl = byId(r, "tech_redirecting_links");
  assert.equal(rl.severity, "Medium");
  assert.ok(rl.urls.includes("https://a.com/old") && !rl.urls.includes("https://a.com/slash"));
  const old = rl.evidence.find((e) => e.url === "https://a.com/old");
  assert.equal(old.finalUrl, "https://a.com/new"); assert.equal(old.redirectStatus, 302);
  assert.equal(byId(r, "tech_slash_redirects").severity, "Low");
  assert.equal(byId(r, "tech_redirect_chains").severity, "High"); // 3 hops
  assert.match(byId(r, "tech_redirect_chains").evidence[0].chain, /chain → .*c2 → .*c3 → .*c4/);
  assert.ok(byId(r, "tech_redirect_loops")); assert.ok(byId(r, "tech_https_downgrade")); assert.ok(byId(r, "tech_offsite_redirects"));
});

test("canonical findings", () => {
  const A = (u, o = {}) => page(u, o);
  const pages = [
    A(H),
    A("https://a.com/multi", { canonicalHrefs: ["https://a.com/x", "https://a.com/y"] }),
    A("https://a.com/bad", { canonicalHrefs: [""] }),
    A("https://a.com/proto", { canonicalHrefs: ["http://a.com/proto"] }),
    A("https://a.com/www", { canonicalHrefs: ["https://www.a.com/www"] }),
    A("https://a.com/cross", { canonicalHrefs: ["https://other.com/cross"] }),
    A("https://a.com/to-404", { canonicalHrefs: ["https://a.com/missing"] }),
    A("https://a.com/to-redirect", { canonicalHrefs: ["https://a.com/moved"] }),
    A("https://a.com/to-noindex", { canonicalHrefs: ["https://a.com/hidden"] }),
    A("https://a.com/hidden", { noindex: true, noindexSource: "meta" }),
    A("https://a.com/chain-a", { canonicalHrefs: ["https://a.com/chain-b"] }),
    A("https://a.com/chain-b", { canonicalHrefs: ["https://a.com/chain-c"] }),
    A("https://a.com/both", { noindex: true, canonicalHrefs: ["https://a.com/chain-c"] }),
    A("https://a.com/no-canonical", { canonicalHrefs: [] }), // missing is a page-level issue, not reported here
  ];
  const statuses = [...pages.map((p) => ok(p.url)), ok("https://a.com/missing", { status: 404 }), redir("https://a.com/moved", "https://a.com/final")];
  const r = analyzeTechnical(facts({ pages, statuses }));
  const ids = r.findings.map((f) => f.id);
  for (const id of ["tech_canonical_multiple", "tech_canonical_invalid", "tech_canonical_protocol", "tech_canonical_host", "tech_canonical_cross_domain", "tech_canonical_bad_target", "tech_canonical_noindex_target", "tech_canonical_chain", "tech_canonical_noindex_conflict"]) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  assert.equal(byId(r, "tech_canonical_bad_target").severity, "High"); // one target is a 404
  assert.equal(byId(r, "tech_canonical_bad_target").urls.length, 2);
  assert.ok(!r.findings.some((f) => f.urls.includes("https://a.com/no-canonical")));
});

test("homepage noindex is Critical; other noindex pages are Low (Medium when >=25% of the crawl)", () => {
  const r = analyzeTechnical(facts({ pages: [page(H, { noindex: true, noindexSource: "header" })] }));
  const f = byId(r, "tech_home_noindex");
  assert.equal(f.severity, "Critical"); assert.match(f.fix, /X-Robots-Tag/);
  const few = analyzeTechnical(facts({ pages: [page(H), page("https://a.com/1"), page("https://a.com/2"), page("https://a.com/3"), page("https://a.com/thanks", { noindex: true })] }));
  assert.equal(byId(few, "tech_noindex_pages").severity, "Low");
  const many = analyzeTechnical(facts({ pages: [page(H), page("https://a.com/t1", { noindex: true }), page("https://a.com/t2", { noindex: true })] }));
  assert.equal(byId(many, "tech_noindex_pages").severity, "Medium");
});

test("robots findings", () => {
  const r = analyzeTechnical(facts({ robots: { url: "https://a.com/robots.txt", fetched: true, status: 200, blocksGooglebot: true }, blockedByRobots: ["https://a.com/wp-admin/x"] }));
  assert.equal(byId(r, "tech_robots_blocks_search").severity, "Critical");
  assert.equal(byId(r, "tech_links_blocked_by_robots").severity, "Low");
  const missing = analyzeTechnical(facts({ robots: { url: "https://a.com/robots.txt", fetched: true, status: 404 } }));
  assert.ok(byId(missing, "tech_robots_missing"));
  const timeout = analyzeTechnical(facts({ robots: { url: "https://a.com/robots.txt", fetched: false, status: 0 } }));
  assert.equal(byId(timeout, "tech_robots_missing"), undefined);
});

test("sitemap consistency", () => {
  const urls = ["https://a.com/", "https://a.com/ok", "https://a.com/gone", "https://a.com/moved", "https://a.com/hidden", "https://a.com/dupe", "https://a.com/blocked"];
  const pages = [page(H), page("https://a.com/ok"), page("https://a.com/hidden", { noindex: true }), page("https://a.com/dupe", { canonicalHrefs: ["https://a.com/ok"] })];
  const statuses = [...pages.map((p) => ok(p.url)), ok("https://a.com/gone", { status: 404 }), redir("https://a.com/moved", "https://a.com/elsewhere")];
  const r = analyzeTechnical(facts({ pages, statuses, sitemapBlockedByRobots: ["https://a.com/blocked"], sitemap: { urls, complete: true, sourceUrl: "https://a.com/sitemap.xml" } }));
  const errs = byId(r, "tech_sitemap_errors");
  assert.equal(errs.severity, "High"); assert.match(errs.title, /1 sitemap URL returns an error \(6 of 7 sitemap URLs checked\)/);
  assert.ok(byId(r, "tech_sitemap_redirects")); assert.ok(byId(r, "tech_sitemap_noindex")); assert.ok(byId(r, "tech_sitemap_noncanonical")); assert.ok(byId(r, "tech_sitemap_blocked"));
});

test("sitemap: linked pages missing from it are reported only when the sitemap is complete", () => {
  const home = page(H, { internalLinkUrls: ["https://a.com/in-map", "https://a.com/not-in-map", "https://a.com/search?q=x"] });
  const base = { pages: [home], statuses: [ok(H), ok("https://a.com/in-map", { contentType: "text/html" }), ok("https://a.com/not-in-map", { contentType: "text/html" }), ok("https://a.com/search?q=x", { contentType: "text/html" })] };
  const sm = (complete) => ({ urls: [H, "https://a.com/in-map"], complete });
  const full = analyzeTechnical(facts({ ...base, sitemap: sm(true) }));
  assert.deepEqual(byId(full, "tech_sitemap_missing_pages").urls, ["https://a.com/not-in-map"]); // query URLs ignored
  assert.equal(byId(analyzeTechnical(facts({ ...base, sitemap: sm(false) })), "tech_sitemap_missing_pages"), undefined);
});

test("sitemap host mismatch, missing and unparsable", () => {
  const mm = analyzeTechnical(facts({ sitemap: { urls: [], complete: false, sourceUrl: "https://a.com/sitemap.xml", hostMismatch: { count: 40, host: "www.a.com" } } }));
  assert.equal(byId(mm, "tech_sitemap_host_mismatch").severity, "High");
  assert.ok(byId(analyzeTechnical(facts({ sitemap: { urls: [], missingConfirmed: true } })), "tech_sitemap_missing"));
  assert.ok(byId(analyzeTechnical(facts({ sitemap: { urls: [], parseError: true, sourceUrl: "https://a.com/s.xml" } })), "tech_sitemap_invalid"));
});

test("penalty is explainable and capped; every finding has urls, evidence is capped", () => {
  const targets = Array.from({ length: 60 }, (_, i) => `https://a.com/b${i}`);
  const home = page(H, { noindex: true, internalLinkUrls: targets, canonicalHrefs: ["https://other.com/"] });
  const statuses = [ok(H), ...targets.map((u) => ok(u, { status: 404 }))];
  const r = analyzeTechnical(facts({ pages: [home], statuses, robots: { url: "https://a.com/robots.txt", fetched: true, status: 200, blocksGooglebot: true } }));
  assert.equal(r.penalty, 35);
  for (const f of r.findings) { assert.ok(f.urls.length > 0); assert.ok(f.evidence.length <= 25); }
  assert.equal(byId(r, "tech_broken_links").urls.length, 60); // all URLs kept, evidence trimmed
});

test("a link to a redirecting URL is reported against the URL as linked, even if its target is a crawled page", () => {
  const target = page("https://a.com/new");
  const home = page(H, { internalLinkUrls: ["https://a.com/old-name"] });
  const r = analyzeTechnical(facts({ pages: [home, target], statuses: [ok(H), ok(target.url), redir("https://a.com/old-name", "https://a.com/new")] }));
  const f = byId(r, "tech_redirecting_links");
  assert.deepEqual(f.urls, ["https://a.com/old-name"]); assert.equal(f.evidence[0].finalUrl, "https://a.com/new");
  assert.deepEqual(f.evidence[0].linkedFrom, [H]);
});
