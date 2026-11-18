import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePlaybook, PLAYBOOK_GROUPS } from "../lib/playbook.js";

const page = (over = {}) => ({ url: "https://s.com/a", title: "A page about things", titleLength: 20, h1Text: "A page", h1Count: 1, canonical: "https://s.com/a", imagesTotal: 2, imagesMissingAlt: 0, wordCount: 800, schemaTypes: ["Article"], faqQuestions: [], viewport: "width=device-width", headingSkip: null, weakAnchors: [], issues: [], fullText: "x", ...over });
const sw = (over = {}) => ({ orphanPages: [], weakLinkedPages: [], duplicateTitles: [], duplicateMetaDescriptions: [], nearDuplicateContentPairs: [], recurringIssues: [], technical: { findings: [], coverage: { sitemap: { found: true, listed: 40 }, robots: { fetched: true } } }, ...over });
const crawl = (pages, siteWide = sw()) => ({ domain: "s.com", startUrl: "https://s.com/", pages, siteWide });
const item = (r, id) => r.groups.flatMap((g) => g.items).find((i) => i.id === id);

test("57 items in six groups; with no data every auto item is 'unknown' and manual items are 'to do'", () => {
  const r = evaluatePlaybook({});
  assert.deepEqual(r.groups.map((g) => g.id), PLAYBOOK_GROUPS.map((g) => g.id));
  assert.equal(r.overall.total, 57); assert.equal(r.hasCrawl, false);
  assert.equal(item(r, "t_https").status, "unknown"); assert.equal(item(r, "t_toxic").status, "todo");
  assert.equal(item(r, "c_related").status, "todo"); assert.equal(item(r, "a_competitors").status, "todo");
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
  assert.equal(evaluatePlaybook({ siteCrawl: crawl([]) }).groups[0].items[0].status, "unknown");
});
