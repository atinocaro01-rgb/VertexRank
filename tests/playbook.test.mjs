import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePlaybook, PLAYBOOK_GROUPS } from "../lib/playbook.js";

const page = (over = {}) => ({ url: "https://s.com/a", title: "A page about things", titleLength: 20, h1Text: "A page", h1Count: 1, canonical: "https://s.com/a", imagesTotal: 2, imagesMissingAlt: 0, wordCount: 800, schemaTypes: ["Article"], faqQuestions: [], viewport: "width=device-width", headingSkip: null, weakAnchors: [], issues: [], fullText: "x", ...over });
const sw = (over = {}) => ({ orphanPages: [], weakLinkedPages: [], duplicateTitles: [], duplicateMetaDescriptions: [], nearDuplicateContentPairs: [], recurringIssues: [], technical: { findings: [], coverage: { sitemap: { found: true, listed: 40 }, robots: { fetched: true } } }, ...over });
const crawl = (pages, siteWide = sw()) => ({ domain: "s.com", startUrl: "https://s.com/", pages, siteWide });
const item = (r, id) => r.groups.flatMap((g) => g.items).find((i) => i.id === id);

test("82 items in eight groups; with no data crawl-based items are 'unknown' and anything not done is 'to do'", () => {
  const r = evaluatePlaybook({});
  assert.deepEqual(r.groups.map((g) => g.id), PLAYBOOK_GROUPS.map((g) => g.id));
  assert.equal(r.overall.total, 82); assert.equal(r.hasCrawl, false); assert.equal(r.groups.length, 8);
  assert.equal(item(r, "t_https").status, "unknown"); assert.equal(item(r, "t_toxic").status, "todo");
  assert.equal(item(r, "c_related").status, "todo"); assert.equal(item(r, "a_competitors").status, "todo"); assert.equal(item(r, "s_gsc").status, "todo");
});

test("a clean crawl passes the technical and on-page checks", () => {
  const r = evaluatePlaybook({ siteCrawl: crawl([page({ url: "https://s.com/" }), page({ url: "https://s.com/b" })]) });
  for (const id of ["t_https", "t_links", "t_mobile", "t_sitemap", "t_robots", "t_canonical", "t_schema", "t_crawl", "o_title", "o_meta", "o_h1", "o_headings", "o_url", "o_links", "o_alt", "o_anchors", "c_depth", "c_visuals"]) assert.equal(item(r, id).status, "pass", id);
  assert.equal(r.groups.find((g) => g.id === "technical").items.find((i) => i.id === "t_cwv").status, "unknown");
});

test("problems are scored by how many pages they touch: a few = partly, most = fix", () => {
  const issue = (title) => ({ category: "On-Page", severity: "Medium", title, why: "", fix: "" });
  const pages = Array.from({ length: 10 }, (_, i) => page({ url: `https://s.com/p${i}`, issues: i < 1 ? [issue("Missing H1 heading")] : [], imagesMissingAlt: i < 6 ? 2 : 0 }));
  const bad = pages.map((p, i) => (i < 6 ? { ...p, issues: [...p.issues, issue("2 images missing alt text")] } : p));
  const r = evaluatePlaybook({ siteCrawl: crawl(bad) });
  assert.equal(item(r, "o_h1").status, "warn"); assert.match(item(r, "o_h1").detail, /1 of 10/);
  assert.equal(item(r, "o_alt").status, "fail");
});

test("http site, missing viewport and old crawls are handled honestly", () => {
  const http = evaluatePlaybook({ siteCrawl: { ...crawl([page({ url: "http://s.com/" })]), startUrl: "http://s.com/" } });
  assert.equal(item(http, "t_https").status, "fail");
  const old = evaluatePlaybook({ siteCrawl: crawl([{ url: "https://s.com/", title: "Old", issues: [], schemaTypes: [] }]) });
  assert.equal(item(old, "t_mobile").status, "unknown"); assert.match(item(old, "t_mobile").detail, /Re-crawl/);
  assert.equal(item(old, "o_headings").status, "unknown"); assert.equal(item(old, "o_anchors").status, "unknown");
});

test("page speed, sitemap and robots results feed their items", () => {
  const good = { url: "https://s.com/", strategy: "mobile", score: 95, field: { lcp: { value: 2000, rating: "good" }, inp: { value: 100, rating: "good" }, cls: { value: 0.05, rating: "good" } }, lab: {} };
  const poor = { ...good, field: { ...good.field, lcp: { value: 5000, rating: "poor" } } };
  assert.equal(item(evaluatePlaybook({ pageSpeed: [good] }), "t_cwv").status, "pass");
  assert.equal(item(evaluatePlaybook({ pageSpeed: [good, poor] }), "t_cwv").status, "fail");
  const noSitemap = evaluatePlaybook({ siteCrawl: crawl([page()], sw({ technical: { findings: [], coverage: { sitemap: { found: false }, robots: { fetched: true } } } })) });
  assert.equal(item(noSitemap, "t_sitemap").status, "fail");
});

test("local items follow the Local SEO tab: ticks, area pages, details", () => {
  const ticks = Object.fromEntries(["gbp_claim", "gbp_categories", "gbp_nap", "gbp_hours", "gbp_services", "gbp_photos", "gbp_website", "gbp_posts", "gbp_qa"].map((k) => [k, { done: true }]));
  const r = evaluatePlaybook({ localChecklist: { ...ticks, cit_major: { done: true } } });
  assert.equal(item(r, "l_gbp").status, "pass"); assert.equal(item(r, "l_citations").status, "warn"); assert.equal(item(r, "l_reviews").status, "todo");
  const crawlWith = crawl([page({ url: "https://s.com/", title: "Nairobi plumbers", h1Text: "Nairobi plumbers", contactText: "Mwangi Plumbing 0700 123 456", phones: ["0700 123 456"], telLinks: ["+254700123456"] })]);
  const withProfile = evaluatePlaybook({ siteCrawl: crawlWith, localProfile: { name: "Mwangi Plumbing", phone: "0700123456", address: "", areas: "Nairobi, Thika" } });
  assert.equal(item(withProfile, "l_pages").status, "warn"); assert.match(item(withProfile, "l_pages").detail, /1 of 2/);
  assert.equal(item(evaluatePlaybook({ siteCrawl: crawlWith }), "l_nap").status, "unknown");
});

test("marks: done ticks a manual item, N/A removes any item from the score", () => {
  const base = evaluatePlaybook({});
  const marked = evaluatePlaybook({ playbookMarks: { t_toxic: "done", c_intent: "na", t_https: "na" } });
  assert.equal(item(marked, "t_toxic").status, "pass"); assert.equal(item(marked, "c_intent").status, "na"); assert.equal(item(marked, "t_https").status, "na");
  assert.ok(marked.overall.score > base.overall.score); assert.equal(marked.overall.measured, base.overall.measured - 1 + 0); // c_intent left the score; t_https was unknown already
});

test("scores: pass 1, partly 0.5, fix 0; unknown and N/A are left out", () => {
  const r = evaluatePlaybook({ competitors: [{ name: "a" }, { name: "b" }, { name: "c" }], gscReport: { queries: [{ query: "q" }], pages: [], queryPages: [] } });
  const adv = r.groups.find((g) => g.id === "advanced");
  assert.equal(item(r, "a_competitors").status, "pass"); assert.equal(item(r, "a_shifts").status, "pass");
  assert.equal(adv.measured, 9 - 0); // all advanced items are either manual (to do) or auto with data
  assert.equal(adv.score, Math.round(((2) / 9) * 100));
  assert.equal(evaluatePlaybook({ siteCrawl: crawl([]) }).groups.find((g) => g.id === "technical").items[0].status, "unknown");
});

const pgs = (urls, over = {}) => urls.map((u, i) => page({ url: u, ...(over[u] || {}) }));

test("new technical items: clean URLs, click depth, redirects (permanent vs temporary) and http links", () => {
  const urls = ["https://s.com/", "https://s.com/a", "https://s.com/b", "https://s.com/c", "https://s.com/d"];
  const link = (from, to) => ({ [from]: { internalLinkUrls: [to] } });
  const over = { ...link("https://s.com/", "https://s.com/a"), ...link("https://s.com/a", "https://s.com/b"), ...link("https://s.com/b", "https://s.com/c"), ...link("https://s.com/c", "https://s.com/d") };
  const r = evaluatePlaybook({ siteCrawl: crawl(pgs(urls, over)) });
  assert.equal(item(r, "t_depth").status, "warn"); assert.match(item(r, "t_depth").detail, /1 of 5 .*more than 3 clicks/); assert.deepEqual(item(r, "t_depth").urls, ["https://s.com/d"]);
  assert.equal(item(r, "t_clean_urls").status, "pass");
  const messy = evaluatePlaybook({ siteCrawl: crawl(pgs(["https://s.com/", "https://s.com/Blog_Post?id=3", "https://s.com/ok", "https://s.com/ok2", "https://s.com/ok3", "https://s.com/ok4"])) });
  assert.equal(item(messy, "t_clean_urls").status, "warn"); assert.deepEqual(item(messy, "t_clean_urls").urls, ["https://s.com/Blog_Post?id=3"]);
  const temp = evaluatePlaybook({ siteCrawl: crawl(pgs(["https://s.com/", "https://s.com/a"], { "https://s.com/a": { redirectChain: [{ status: 302, from: "https://s.com/old", to: "https://s.com/a" }] }, "https://s.com/": { redirectChain: [] } })) });
  assert.equal(item(temp, "t_302").status, "fail"); // 1 of 2 pages
  const perm = evaluatePlaybook({ siteCrawl: crawl(pgs(["https://s.com/", "https://s.com/a"], { "https://s.com/a": { redirectChain: [{ status: 301, from: "https://s.com/old", to: "https://s.com/a" }] }, "https://s.com/": { redirectChain: [] } })) });
  assert.equal(item(perm, "t_302").status, "pass");
  assert.equal(item(evaluatePlaybook({ siteCrawl: crawl([page({ redirectChain: undefined })]) }), "t_302").status, "unknown");
  const http = evaluatePlaybook({ siteCrawl: crawl(pgs(["https://s.com/", "https://s.com/a"], { "https://s.com/a": { internalLinkUrls: ["http://s.com/x"] } })) });
  assert.equal(item(http, "t_http_links").status, "fail"); assert.deepEqual(item(http, "t_http_links").urls, ["https://s.com/a"]);
});

test("setup, content and AI items follow the data they depend on", () => {
  const empty = evaluatePlaybook({});
  assert.equal(item(empty, "ai_visibility").status, "todo");
  const have = evaluatePlaybook({ gscReport: { totals: { clicks: 1 }, property: "sc-domain:s.com", queries: [] }, aeoQuestions: Array.from({ length: 6 }, (_, i) => ({ q: i })), competitors: [{ name: "a", crawlSummary: {} }], siteGeoAnalysis: { ok: true }, siteKeywordClusters: { clusters: [{}, {}, {}], keywords: new Array(12).fill({}), cannibalization: [] } });
  for (const id of ["s_gsc", "c_paa", "c_comp_kw", "ai_visibility", "c_clusters", "c_cannibal", "c_related"]) assert.equal(item(have, id).status, "pass", id);
  const clash = evaluatePlaybook({ siteKeywordClusters: { clusters: [{}], keywords: [], cannibalization: [{ pages: [{ url: "https://s.com/a" }, { url: "https://s.com/b" }] }] } });
  assert.equal(item(clash, "c_cannibal").status, "warn"); assert.deepEqual(item(clash, "c_cannibal").urls, ["https://s.com/a", "https://s.com/b"]);
  const noindex = evaluatePlaybook({ siteCrawl: crawl([page()], sw({ technical: { findings: [{ id: "tech_home_noindex", category: "Technical", severity: "Critical", title: "The homepage is set to noindex", urls: ["https://s.com/"] }], coverage: { sitemap: { found: true, listed: 1 }, robots: { fetched: true } } } })) });
  assert.equal(item(noindex, "s_index").status, "fail");
});

test("every item that needs work carries steps, a fix input and a valid action type; passing and N/A items carry none", () => {
  const TYPES = ["Meta Fix", "Content Update", "Schema Markup", "Internal Link", "Technical Fix", "FAQ Addition"];
  const r = evaluatePlaybook({ playbookMarks: { c_intent: "na" } });
  const all = r.groups.flatMap((g) => g.items);
  assert.ok(all.every((i) => i.how && i.how.length > 20 && i.view), "every item has how-to steps and a screen to open");
  for (const i of all) {
    if (i.status === "pass" || i.status === "na") { assert.equal(i.rec, null, i.id); continue; }
    assert.ok(i.rec.title && i.rec.evidence && i.rec.recommendedAction === i.how, i.id);
    assert.ok(TYPES.includes(i.rec.actionType), `${i.id}: ${i.rec.actionType}`);
    assert.ok(["High", "Medium", "Low"].includes(i.rec.priority) && /^Playbook: /.test(i.rec.module), i.id);
  }
  assert.equal(item(r, "c_intent").rec, null);
  // a failing crawl item hands its affected pages to the fix
  const bad = evaluatePlaybook({ siteCrawl: crawl(Array.from({ length: 4 }, (_, i) => page({ url: `https://s.com/p${i}`, schemaTypes: [], issues: [{ category: "On-Page", severity: "Medium", title: "Missing H1 heading" }] }))) });
  assert.equal(item(bad, "o_h1").rec.priority, "High"); assert.equal(item(bad, "o_h1").rec.urls.length, 4); assert.equal(item(bad, "o_h1").rec.actionType, "Meta Fix");
  assert.equal(item(bad, "t_schema").rec.actionType, "Schema Markup");
  const manual = item(r, "t_toxic");
  assert.equal(manual.status, "todo"); assert.match(manual.rec.evidence, /Not yet done/); assert.equal(manual.rec.priority, "Low");
});

test("ticking a manual item removes its fix; unique ids across the whole scorecard", () => {
  assert.equal(item(evaluatePlaybook({ playbookMarks: { s_ga4: "done" } }), "s_ga4").rec, null);
  const ids = evaluatePlaybook({}).groups.flatMap((g) => g.items.map((i) => i.id));
  assert.equal(new Set(ids).size, ids.length);
});
