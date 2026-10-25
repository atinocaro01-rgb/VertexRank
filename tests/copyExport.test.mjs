import test from "node:test";
import assert from "node:assert/strict";
import { computeSiteAuditIssues, formatSiteAuditIssue, describeEvidence } from "../lib/copyExport.js";

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
