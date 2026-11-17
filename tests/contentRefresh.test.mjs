import test from "node:test";
import assert from "node:assert/strict";
import { refreshCandidates, thinPages, contentIdeaFromRefresh, fixRecForRefresh } from "../lib/contentRefresh.js";
import { isMarked, splitForRegenerate } from "../lib/contentIdeas.js";

const pg = (page, clicks, impressions, position) => ({ page, clicks, impressions, position, ctr: impressions ? clicks / impressions : 0 });
const report = {
  days: 28,
  pages: [pg("https://s.com/a", 20, 900, 9), pg("https://s.com/b", 50, 1000, 4), pg("https://s.com/c", 2, 80, 12), pg("https://s.com/d", 40, 1500, 11), pg("https://s.com/e", 1, 30, 20)],
  previousPages: [pg("https://s.com/a", 60, 1500, 6), pg("https://s.com/b", 52, 1050, 4), pg("https://s.com/c", 2, 90, 12), pg("https://s.com/d", 44, 1400, 6.5), pg("https://s.com/e", 3, 40, 18)],
  queryPages: [{ query: "alpha topic", page: "https://s.com/a", impressions: 500, clicks: 10, position: 9 }, { query: "alpha how to", page: "https://s.com/a", impressions: 200, clicks: 5, position: 10 }],
};
const crawl = { pages: [
  { url: "https://s.com/a", title: "Alpha guide", wordCount: 900 }, { url: "https://s.com/b", title: "Beta", wordCount: 800 },
  { url: "https://s.com/c", title: "Gamma notes", wordCount: 220 }, { url: "https://s.com/d", title: "Delta", wordCount: 1200 }, { url: "https://s.com/f", title: "Short and unseen", wordCount: 100 },
] };

test("refreshCandidates finds declining and thin-but-visible pages, ignores healthy and tiny ones, and ranks by loss", () => {
  const rows = refreshCandidates(report, crawl);
  assert.deepEqual(rows.map((r) => r.path), ["/a", "/d", "/c"]);
  const a = rows[0];
  assert.deepEqual(a.reasons.map((r) => r.kind), ["clicks", "impressions", "position"]);
  assert.match(a.reasons[0].text, /Clicks fell 67% \(60 to 20\)/);
  assert.equal(a.primaryQuery, "alpha topic"); assert.equal(a.topQueries.length, 2); assert.equal(a.title, "Alpha guide");
  assert.deepEqual(rows[1].reasons.map((r) => r.kind), ["position"]); // d: only the ranking slipped
  assert.deepEqual(rows[2].reasons.map((r) => r.kind), ["thin"]); // c: 220 words but 80 impressions
  assert.ok(!rows.some((r) => r.path === "/b" || r.path === "/e")); // stable, and too small to matter
});

test("thresholds scale with the report length", () => {
  const long = { ...report, days: 84 }; // 3x: the same 20->60 click drop is no longer enough "before" volume to count? (needs 30 before)
  assert.ok(refreshCandidates(long, crawl).some((r) => r.path === "/a"));
  const small = { days: 28, pages: [pg("https://s.com/x", 4, 100, 5)], previousPages: [pg("https://s.com/x", 8, 200, 5)], queryPages: [] };
  assert.deepEqual(refreshCandidates(small, { pages: [] }).filter((r) => r.reasons.some((x) => x.kind === "clicks")), []); // 8 clicks before: too few to call it a decline
});

test("thinPages works from the crawl alone, thinnest first", () => {
  assert.deepEqual(thinPages(crawl).map((r) => r.path), ["/f", "/c"]);
  assert.deepEqual(thinPages(null), []);
});

test("a refresh topic is an unscheduled blue idea that regenerate never replaces; the fix rec targets the page", () => {
  const c = refreshCandidates(report, crawl)[0];
  const idea = contentIdeaFromRefresh(c, "ci_9", "w1");
  assert.equal(idea.status, "Idea"); assert.equal(idea.scheduledFor, ""); assert.equal(idea.title, "Refresh: Alpha guide"); assert.equal(idea.source, "Content refresh");
  assert.deepEqual(idea.internalLinkTargets, ["https://s.com/a"]); assert.equal(idea.grounding.text, "/a"); assert.match(idea.grounding.note, /Clicks fell 67%/);
  assert.equal(isMarked(idea), true);
  assert.deepEqual(splitForRegenerate([idea, { status: "Idea", source: "VertexRank AI Calendar" }, { status: "Idea", source: "Search Console query" }]).replace.length, 1);
  const rec = fixRecForRefresh(c);
  assert.equal(rec.priority, "High"); assert.deepEqual(rec.urls, ["https://s.com/a"]); assert.match(rec.recommendedAction, /"alpha topic"/);
});
