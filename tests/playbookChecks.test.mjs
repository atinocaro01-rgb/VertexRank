import test from "node:test";
import assert from "node:assert/strict";
import { httpsFindings, keywordPlacementFindings, containsQuery, topQueryByPage, playbookFindings } from "../lib/playbookChecks.js";
import { computeAuditIssuesForMarket } from "../lib/auditIssues.js";

test("httpsFindings: a crawl that ended on http is critical; stray http pages are flagged; an all-https site is clean", () => {
  const a = httpsFindings({ startUrl: "http://s.com/", pages: [{ url: "http://s.com/" }] });
  assert.equal(a.length, 1); assert.equal(a[0].severity, "Critical"); assert.equal(a[0].id, "play_https_site");
  const b = httpsFindings({ startUrl: "https://s.com/", pages: [{ url: "https://s.com/" }, { url: "http://s.com/old" }] });
  assert.equal(b.length, 1); assert.equal(b[0].id, "play_https_pages"); assert.deepEqual(b[0].urls, ["http://s.com/old"]);
  assert.deepEqual(httpsFindings({ startUrl: "https://s.com/", pages: [{ url: "https://s.com/" }] }), []);
  assert.deepEqual(httpsFindings(null), []);
});

test("containsQuery: meaningful words, light stemming, ignores filler words", () => {
  assert.equal(containsQuery("Grade 9 Teacher Checklist | Darasa", "grade 9 teacher checklist"), true);
  assert.equal(containsQuery("Schemes of work for CBC", "how to write schemes of work"), false); // "write" missing
  assert.equal(containsQuery("Teachers checklists", "teacher checklist"), true); // plural forms
  assert.equal(containsQuery("anything", "the of and"), true); // nothing meaningful to test
});

const crawl = { domain: "darasa.site", startUrl: "https://darasa.site/", pages: [
  { url: "https://darasa.site/checklist", title: "Our resources", h1Text: "Welcome", fullText: "We make things for schools. ".repeat(10) },
  { url: "https://darasa.site/schemes", title: "How to write schemes of work in CBC", h1Text: "How to write schemes of work", fullText: "Learn how to write schemes of work step by step. " + "x ".repeat(120) },
] };
const report = { days: 28, queryPages: [
  { query: "grade 9 teacher checklist", page: "https://darasa.site/checklist", impressions: 300 },
  { query: "grade 9 checklist pdf", page: "https://darasa.site/checklist", impressions: 90 },
  { query: "how to write schemes of work", page: "https://darasa.site/schemes", impressions: 200 },
  { query: "darasa login", page: "https://darasa.site/schemes", impressions: 900 }, // brand query: ignored
  { query: "tiny", page: "https://darasa.site/schemes", impressions: 3 },
] };

test("keyword placement uses each page's top non-brand query and flags title, H1 and opening words", () => {
  assert.equal(topQueryByPage(report, crawl).size, 2);
  const f = keywordPlacementFindings(crawl, report);
  assert.deepEqual(f.map((x) => x.id), ["play_kw_title", "play_kw_h1", "play_kw_early"]);
  assert.deepEqual(f[0].urls, ["https://darasa.site/checklist"]); // the schemes page already uses its query everywhere
  assert.match(f[0].evidence[0].note, /grade 9 teacher checklist/);
  assert.deepEqual(keywordPlacementFindings(crawl, null), []);
  assert.deepEqual(keywordPlacementFindings(crawl, { queryPages: [] }), []);
});

test("the audit list includes playbook findings, and still works without Search Console", () => {
  const swCrawl = { ...crawl, siteWide: { orphanPages: [], weakLinkedPages: [], duplicateTitles: [], duplicateMetaDescriptions: [], nearDuplicateContentPairs: [], recurringIssues: [] } };
  assert.ok(computeAuditIssuesForMarket(swCrawl, "Worldwide", { gscReport: report }).some((i) => i.id === "play_kw_title"));
  assert.equal(computeAuditIssuesForMarket(swCrawl, "Worldwide").some((i) => i.id.startsWith("play_kw")), false);
  assert.ok(playbookFindings(swCrawl, report).length >= 3);
});
