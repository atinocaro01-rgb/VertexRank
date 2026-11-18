import test from "node:test";
import assert from "node:assert/strict";
import { buildReportData, cleanReportSettings, REPORT_SECTIONS, DEFAULT_REPORT_SETTINGS } from "../lib/clientReport.js";
import { renderReportHtml, esc } from "../lib/reportHtml.js";

const pg = (page, clicks, impressions, position) => ({ page, clicks, impressions, position, ctr: impressions ? clicks / impressions : 0 });
const b = {
  siteCrawl: { domain: "s.com", startUrl: "https://s.com/", crawledAt: "2026-11-10T08:00:00Z", siteScores: { technical: 71, content: 64 }, siteWide: { orphanPages: [], weakLinkedPages: [], duplicateTitles: [], duplicateMetaDescriptions: [], nearDuplicateContentPairs: [], recurringIssues: [{ id: "x1", category: "Technical", severity: "High", title: "Missing mobile viewport tag", why: "Phones show a tiny page.", fix: "Add the viewport tag.", count: 3, urls: ["https://s.com/a", "https://s.com/b", "https://s.com/c"] }, { id: "x2", category: "On-Page", severity: "Low", title: "Heading levels are skipped", why: "", fix: "", count: 2, urls: ["https://s.com/a", "https://s.com/b"] }], technical: { findings: [], coverage: { sitemap: { found: true, listed: 5 }, robots: { fetched: true } } } },
    pages: [{ url: "https://s.com/", title: "Home", h1Text: "Home", fullText: "x", issues: [], schemaTypes: ["Organization"] }, { url: "https://s.com/a", title: "Alpha <script>alert(1)</script>", h1Text: "Alpha", fullText: "x", issues: [], wordCount: 200 }] },
  gscReport: { days: 28, property: "sc-domain:s.com", fetchedAt: "2026-11-17T00:00:00Z", range: { startDate: "2026-10-18", endDate: "2026-11-14" }, previousRange: { startDate: "2026-09-20", endDate: "2026-10-17" }, totals: { clicks: 240, impressions: 9000, ctr: 0.0267, position: 14.2 }, previousTotals: { clicks: 200, impressions: 10000, ctr: 0.02, position: 15 },
    queries: [{ query: "alpha topic", clicks: 20, impressions: 600, ctr: 0.03, position: 6.1 }], pages: [pg("https://s.com/a", 20, 900, 9)], previousPages: [pg("https://s.com/a", 60, 1500, 6)], queryPages: [{ query: "alpha topic", page: "https://s.com/a", impressions: 600, clicks: 20, position: 6.1 }] },
  pageSpeed: [{ url: "https://s.com/", strategy: "mobile", score: 62, fetchedAt: "2026-11-12T00:00:00Z", field: null, lab: { lcp: 5200, lcpRating: "poor", cls: 0.02, clsRating: "good", tbt: 100, tbtRating: "good" }, opportunities: [] }],
  contentIdeas: [{ title: "Done post", status: "Published" }, { title: "Draft post", status: "Drafting", scheduledFor: "2026-12-02" }, { title: "Idea post", status: "Idea", scheduledFor: "2026-12-01" }],
  actions: [{ status: "Applied" }, { status: "New" }], competitors: [{ name: "Rival" }], keywords: [], backlinks: [], localChecklist: { gbp_claim: { done: true } },
};
const site = { url: "https://s.com/", name: "S dot com" };
const NOW = new Date("2026-11-18T10:00:00Z");

test("buildReportData gathers each section from saved data only", () => {
  const d = buildReportData(b, site, { now: NOW, settings: { preparedBy: "Acme", clientName: "S Co", notes: "Hello" } });
  assert.equal(d.meta.siteName, "S dot com"); assert.equal(d.meta.preparedBy, "Acme");
  assert.equal(d.summary.pagesCrawled, 2); assert.equal(d.summary.severity.High >= 1, true);
  assert.deepEqual(d.search.change, { clicks: 20, impressions: -10 }); assert.equal(d.search.topQueries[0].query, "alpha topic");
  assert.equal(d.search.refresh[0].path, "/a");
  assert.equal(d.vitals[0].basis, "lab test"); assert.match(d.vitals[0].weak[0], /Largest Contentful Paint 5\.2 s \(poor\)/);
  assert.deepEqual(d.content.counts, { idea: 1, draft: 1, published: 1 }); assert.deepEqual(d.content.upcoming.map((u) => u.title), ["Idea post", "Draft post"]);
  assert.equal(d.playbook.groups.length, 8);
  assert.ok(d.highlights.some((h) => h.kind === "win" && /Clicks from Google up 20%/.test(h.text)));
  assert.ok(d.highlights.some((h) => h.kind === "watch" && /Impressions down 10%/.test(h.text)));
  assert.ok(d.highlights.some((h) => /1 recommended fix has been marked done/.test(h.text)));
  assert.ok(d.sources.some((s) => /Search Console/.test(s)) && d.sources.some((s) => /crawl of 2 pages on 2026-11-10/.test(s)));
});

test("an empty website produces an honest, valid report with no invented numbers", () => {
  const d = buildReportData({}, { url: "https://new.com" }, { now: NOW });
  assert.equal(d.search.has, false); assert.equal(d.summary.pagesCrawled, 0); assert.deepEqual(d.highlights, []); assert.deepEqual(d.vitals, []);
  const html = renderReportHtml(d);
  assert.match(html, /isn't connected for this website yet/); assert.match(html, /No site crawl has been run yet/); assert.match(html, /Page speed hasn't been tested yet/); assert.match(html, /No content plan yet/);
});

test("the HTML report escapes everything, respects section toggles and states its sources", () => {
  const d = buildReportData(b, site, { now: NOW, settings: { preparedBy: "<b>Acme</b>", notes: "Note & <i>more</i>", sections: { playbook: false, local: false } } });
  const html = renderReportHtml(d);
  assert.ok(!html.includes("<script>alert(1)</script>")); assert.ok(!html.includes("<b>Acme</b>")); assert.match(html, /&lt;b&gt;Acme&lt;\/b&gt;/); assert.match(html, /Note &amp; &lt;i&gt;more&lt;\/i&gt;/);
  assert.ok(!html.includes("Playbook scorecard")); assert.ok(!html.includes("<h2>Local SEO</h2>"));
  for (const h of ["Summary", "Search performance", "Issues found", "Page speed (Core Web Vitals)", "Content", "Recommended next steps"]) assert.ok(html.includes(`<h2>${h.replace(/&/g, "&amp;")}</h2>`), h);
  assert.match(html, /Missing mobile viewport tag/); assert.match(html, /Where this comes from/); assert.match(html, /don't predict rankings/);
  assert.match(html, /^<!doctype html>/); assert.match(html, /@page\{size:A4/);
});

test("settings are cleaned and default to every section on", () => {
  assert.deepEqual(cleanReportSettings(null), { preparedBy: "", clientName: "", notes: "", sections: Object.fromEntries(REPORT_SECTIONS.map((s) => [s.id, true])) });
  const s = cleanReportSettings({ preparedBy: "  A   B ", notes: "x".repeat(3000), sections: { issues: false, bogus: false } });
  assert.equal(s.preparedBy, "A B"); assert.equal(s.notes.length, 1500); assert.equal(s.sections.issues, false); assert.equal(s.sections.search, true); assert.equal("bogus" in s.sections, false);
  assert.deepEqual(DEFAULT_REPORT_SETTINGS.sections, cleanReportSettings({}).sections);
  assert.equal(esc(`<a href="x">'&</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;");
});
