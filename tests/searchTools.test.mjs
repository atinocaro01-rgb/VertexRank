import test from "node:test";
import assert from "node:assert/strict";
import { enrichQueries, filterQueries, queriesToCsv, queriesForPage, contentIdeaFromQuery, fixRecForQuery, QUERY_FILTERS } from "../lib/searchTools.js";

const q = (query, clicks, impressions, position) => ({ query, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
const report = {
  days: 28,
  queries: [q("grade 9 teacher checklist", 2, 400, 6.2), q("how to write schemes of work", 30, 900, 3.1), q("cbc notes", 1, 40, 18), q("brand name", 90, 200, 1.1), q("rare thing", 0, 5, 40), q("what is cbc", 4, 300, 8)],
  queryPages: [
    { query: "grade 9 teacher checklist", page: "https://s.com/checklist", impressions: 300, clicks: 2, position: 6 },
    { query: "grade 9 teacher checklist", page: "https://s.com/blog/checklist", impressions: 100, clicks: 0, position: 7 },
    { query: "cbc notes", page: "https://s.com/notes", impressions: 40, clicks: 1, position: 18 },
    { query: "what is cbc", page: "https://s.com/cbc", impressions: 300, clicks: 4, position: 8 },
  ],
};

test("enrichQueries labels quick wins, questions and competing pages from the reported numbers", () => {
  const rows = enrichQueries(report, { tracked: ["Brand Name"] });
  const by = Object.fromEntries(rows.map((r) => [r.query, r]));
  assert.equal(rows[0].query, "how to write schemes of work"); // sorted by impressions
  assert.equal(by["grade 9 teacher checklist"].quickWin, true);
  assert.equal(by["grade 9 teacher checklist"].compete, true);
  assert.equal(by["grade 9 teacher checklist"].topPage, "https://s.com/checklist");
  assert.equal(by["how to write schemes of work"].quickWin, false); // already position 3
  assert.equal(by["how to write schemes of work"].isQuestion, true);
  assert.equal(by["what is cbc"].isQuestion, true);
  assert.equal(by["cbc notes"].quickWin, true);
  assert.equal(by["rare thing"].quickWin, false); // too far down
  assert.equal(by["brand name"].tracked, true);
  assert.equal(by["cbc notes"].compete, false);
});

test("filterQueries filters by label and by text", () => {
  const rows = enrichQueries(report, { tracked: [] });
  assert.deepEqual(filterQueries(rows, "question").map((r) => r.query).sort(), ["how to write schemes of work", "what is cbc"]);
  assert.ok(filterQueries(rows, "quickWin").every((r) => r.quickWin));
  assert.equal(filterQueries(rows, "all", "CBC").length, 2);
  assert.equal(filterQueries(rows, "notTracked").length, rows.length);
  assert.ok(QUERY_FILTERS.every((f) => f.hint));
  assert.deepEqual(filterQueries([], "all"), []);
});

test("a page-one query clicked far less than your own typical rate at that position is flagged low CTR", () => {
  const many = Array.from({ length: 8 }, (_, i) => q(`normal ${i}`, 20, 200, 5)); // 10% CTR at position 5, enough to form the site's own benchmark
  const rows = enrichQueries({ days: 28, queries: [...many, q("underperformer", 1, 400, 5)], queryPages: [] });
  assert.equal(rows.find((r) => r.query === "underperformer").lowCtr, true);
  assert.equal(rows.find((r) => r.query === "normal 0").lowCtr, false);
});

test("queriesToCsv quotes commas and quotes, and formats CTR and position", () => {
  const csv = queriesToCsv([{ query: 'a, "b"', clicks: 3, impressions: 100, ctr: 0.03, position: 4.25, topPage: "https://s.com/x" }]);
  assert.equal(csv.split("\n")[0], "query,clicks,impressions,ctr,position,top_page");
  assert.equal(csv.split("\n")[1], '"a, ""b""",3,100,3.00%,4.3,https://s.com/x');
  assert.equal(queriesToCsv([]), "query,clicks,impressions,ctr,position,top_page");
});

test("queriesForPage lists the queries a page shows for, best first, matching URLs loosely", () => {
  assert.deepEqual(queriesForPage(report, "http://www.s.com/checklist/").map((r) => r.query), ["grade 9 teacher checklist"]);
  assert.deepEqual(queriesForPage(report, "https://s.com/nope"), []);
});

test("contentIdeaFromQuery makes an unscheduled blue idea grounded in the query's real numbers; fixRecForQuery targets the ranking page", () => {
  const row = enrichQueries(report).find((r) => r.query === "what is cbc");
  const idea = contentIdeaFromQuery(row, "ci_1", "w1");
  assert.equal(idea.status, "Idea"); assert.equal(idea.scheduledFor, ""); assert.equal(idea.source, "Search Console query");
  assert.equal(idea.title, "What is cbc"); assert.equal(idea.primaryKeyword, "what is cbc"); assert.deepEqual(idea.questions, ["What is cbc?"]);
  assert.match(idea.grounding.note, /300 impressions/);
  const rows = enrichQueries(report);
  const lowCtr = fixRecForQuery(rows.find((r) => r.query === "grade 9 teacher checklist")); // 0.5% CTR at position 6: a title/meta problem
  assert.match(lowCtr.title, /Raise the click-through rate for "grade 9 teacher checklist" on \/checklist/);
  assert.deepEqual(lowCtr.urls, ["https://s.com/checklist"]);
  const win = fixRecForQuery(rows.find((r) => r.query === "cbc notes")); // position 18: improve the page itself
  assert.match(win.title, /Improve the page for "cbc notes" on \/notes/);
});
