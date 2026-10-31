import test from "node:test";
import assert from "node:assert/strict";
import { computeSiteAuditIssues, formatSiteAuditIssue, describeEvidence, sectionSearchReport, PAGE_EXPORTERS } from "../lib/copyExport.js";

const baseSiteWide = { orphanPages: [], weakLinkedPages: [], duplicateTitles: [], duplicateMetaDescriptions: [], nearDuplicateContentPairs: [], recurringIssues: [] };
const finding = {
  id: "tech_broken_links", category: "Technical", severity: "High", title: "2 broken internal links (404)",
  why: "w", fix: "f", urls: ["https://a.com/x", "https://a.com/y"],
  evidence: [{ url: "https://a.com/x", status: 404, linkedFrom: ["https://a.com/"], linkedFromCount: 3 }, { url: "https://a.com/y", status: 404 }],
};

test("technical findings join the audit issue list, sorted by severity", () => {
  const crawl = { siteWide: { ...baseSiteWide, orphanPages: ["https://a.com/o"], technical: { findings: [finding] } } };
  const issues = computeSiteAuditIssues(crawl);
  assert.deepEqual(issues.map((i) => i.id), ["tech_broken_links", "site_orphan"]); // High before Medium
});

test("crawls saved before the technical checks existed still work", () => {
  const legacy = { siteWide: { ...baseSiteWide, orphanPages: ["https://a.com/o"] } };
  assert.deepEqual(computeSiteAuditIssues(legacy).map((i) => i.id), ["site_orphan"]);
  assert.deepEqual(computeSiteAuditIssues(null), []);
});

test("export includes per-URL evidence, with linking pages", () => {
  const md = formatSiteAuditIssue(finding, "###", 1);
  assert.match(md, /Evidence/);
  assert.match(md, /https:\/\/a\.com\/x — HTTP 404 · linked from https:\/\/a\.com\/ \(\+2 more\)/);
});

test("describeEvidence formats redirects, chains and canonicals", () => {
  assert.equal(describeEvidence({ url: "u", redirectStatus: 302, finalUrl: "https://a.com/n" }), "302 → https://a.com/n");
  assert.equal(describeEvidence({ url: "u", canonical: "https://b.com/", note: "page → canonical" }), "canonical: https://b.com/ · page → canonical");
  assert.equal(describeEvidence({ url: "u" }), "");
});

test("the Search data export states its provenance, shows changes, escapes table cells and lists limitations", () => {
  const report = { property: "sc-domain:a.com", range: { startDate: "2026-09-28", endDate: "2026-10-25" }, days: 28, fetchedAt: "2026-10-28T10:00:00.000Z",
    totals: { clicks: 120, impressions: 4000, ctr: 0.03, position: 9.4 }, previousTotals: { clicks: 100, impressions: 5000, ctr: 0.02, position: 10.1 },
    queries: [{ query: "red | shoes", clicks: 10, impressions: 200, ctr: 0.05, position: 4.44 }], pages: [{ page: "https://a.com/x", clicks: 5, impressions: 90, ctr: 0.0556, position: 7 }], limitations: ["Position is an average."] };
  const md = sectionSearchReport(report);
  assert.match(md, /Observed data · property sc-domain:a\.com · 2026-09-28 to 2026-10-25 \(28 days\)/);
  assert.match(md, /\| Clicks \| 120 \| 100 \| \+20% \|/); assert.match(md, /\| Impressions \| 4000 \| 5000 \| -20% \|/);
  assert.match(md, /red \\\| shoes/); assert.match(md, /\| https:\/\/a\.com\/x \| 5 \| 90 \| 5\.6% \| 7\.0 \|/); assert.match(md, /### Limitations\n- Position is an average\./);
  assert.match(sectionSearchReport(null), /No Search Console data yet/);
  assert.equal(typeof PAGE_EXPORTERS.search, "function");
  assert.match(PAGE_EXPORTERS.search({ url: "a.com", name: "A" }, { gscReport: report }), /Search data \(Google Search Console\)/);
});
