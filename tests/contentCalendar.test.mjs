import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanCalendarInput, buildLanePrompt, normalizeTopics, qualityIssues, dedupeTopics, scheduleTopics, assembleCalendar, similarity, LANES, CALENDAR_SIZE } from "../lib/contentCalendar.js";
import { buildCalendarInput } from "../lib/calendarContext.js";

const input = cleanCalendarInput({
  site: { domain: "darasa.site", title: "Darasa", text: "Study guides for Kenyan teachers" },
  items: [{ id: "Q1", text: "grade 9 teacher checklist", note: "120 impressions" }, { id: "K1", text: "no page targets 'cbc schemes of work'" }, { id: "A1", text: "how to prepare for grade 9" }, { id: "bad", text: "x" }, { id: "Q2", text: "" }],
  existingTitles: ["Grade 9 to Senior School Teacher Checklist"], knownUrls: [{ url: "https://darasa.site/a", title: "A" }, { url: "javascript:x", title: "bad" }], startDate: "2026-12-01",
});
const good = (o = {}) => ({ title: "How to Write CBC Schemes of Work That Pass Inspection", primaryKeyword: "cbc schemes of work", secondaryKeywords: ["schemes of work template", "cbc lesson plan"], intent: "Informational", funnel: "Consideration", pillar: "CBC planning", format: "How-to guide", angle: "A worked scheme for one grade 9 subject, with the inspector's checklist we actually used.", groundingId: "K1", wordCountTarget: 1400, internalLinkTargets: ["https://darasa.site/a", "https://evil.com/x"], rationale: "Closes a real keyword gap.", ...o });

test("cleanCalendarInput keeps only valid ids, safe URLs and a real start date", () => {
  assert.deepEqual(input.items.map((i) => i.id), ["Q1", "K1", "A1"]); assert.equal(input.knownUrls.length, 1); assert.equal(input.startDate, "2026-12-01");
  assert.equal(cleanCalendarInput({ startDate: "2026-13-45" }).startDate, ""); assert.equal(cleanCalendarInput({ startDate: "tomorrow" }).startDate, "");
  assert.deepEqual(cleanCalendarInput(null).items, []);
});

test("normalizeTopics rejects invented grounding, resolves real ids, and keeps only the site's own internal-link targets", () => {
  const r = normalizeTopics({ topics: [good(), good({ title: "Another valid enough title here for teachers", groundingId: "Q99" }), good({ title: "Site only topic with a decent length title", groundingId: "SITE" }), null, {}] }, input, "gaps");
  assert.equal(r.topics.length, 2); assert.equal(r.rejected.filter((x) => /didn't supply/.test(x.reason)).length, 1);
  assert.equal(r.topics[0].grounding.kind, "K"); assert.equal(r.topics[0].grounding.text, "no page targets 'cbc schemes of work'"); assert.deepEqual(r.topics[0].internalLinkTargets, ["https://darasa.site/a"]);
  assert.equal(r.topics[1].grounding.kind, "site"); assert.equal(normalizeTopics({ topics: [good({ wordCountTarget: 99999 })] }, input, "x").topics[0].wordCountTarget, 2400);
  assert.deepEqual(normalizeTopics(null, input, "x").topics, []);
});

test("qualityIssues: specific topics pass; hype, vague, keyword-less and angle-less topics fail", () => {
  const t = (o) => normalizeTopics({ topics: [good(o)] }, input, "g").topics[0];
  assert.deepEqual(qualityIssues(t({})), []);
  assert.ok(qualityIssues(t({ title: "The Ultimate Guide to CBC Schemes of Work for Teachers" })).includes("generic or hype title"));
  assert.ok(qualityIssues(t({ title: "Everything You Need to Know About CBC Schemes of Work" })).includes("generic or hype title"));
  assert.ok(qualityIssues(t({ title: "7 Tips to Plan Your Teaching Term Better" })).includes("generic or hype title"));
  assert.ok(qualityIssues(t({ title: "Planning lessons for teachers who are busy every term" })).includes("primary keyword not in the title"));
  assert.ok(qualityIssues(t({ title: "CBC tips" })).length > 0);
  assert.ok(qualityIssues(t({ angle: "More info" })).includes("no clear original angle"));
  assert.ok(qualityIssues(t({ intent: "Weird" })).includes("missing intent, funnel or format"));
  assert.ok(qualityIssues(t({ primaryKeyword: "cbc" })).includes("primary keyword should be 2-7 words"));
});

test("dedupe removes near-duplicates of each other and of existing pages", () => {
  assert.ok(similarity("Grade 9 to Senior School Teacher Checklist", "Grade 9 to Senior School Teacher Checklist Guide") > 0.6); assert.equal(similarity("", "x"), 0);
  const a = normalizeTopics({ topics: [good(), good({ title: "How to Write CBC Schemes of Work That Pass an Inspection", groundingId: "Q1" }), good({ title: "Grade 9 to Senior School Teacher Checklist Explained", primaryKeyword: "grade 9 teacher checklist", groundingId: "Q1" }), good({ title: "Planning a Term Budget for a Small Private School", primaryKeyword: "private school budget" })] }, input, "g").topics;
  const { kept, dropped } = dedupeTopics(a, input.existingTitles);
  assert.deepEqual(kept.map((t) => t.primaryKeyword), ["cbc schemes of work", "private school budget"]); assert.equal(dropped.length, 2);
});

test("scheduleTopics: one per day from the start date, strongest grounding first, no same-cluster back-to-back when avoidable, capped at 30", () => {
  const mk = (i, pillar, gid) => normalizeTopics({ topics: [good({ title: `Specific title number ${i} about CBC schemes of work`, primaryKeyword: `cbc schemes ${i}`, pillar, groundingId: gid })] }, input, "g").topics[0];
  const topics = [mk(1, "A", "A1"), mk(2, "A", "Q1"), mk(3, "A", "K1"), mk(4, "B", "A1"), mk(5, "B", "Q1")];
  const s = scheduleTopics(topics, "2026-12-30", 30);
  assert.equal(s.length, 5); assert.deepEqual(s.map((t) => t.scheduledFor), ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
  assert.equal(s[0].grounding.kind, "Q"); for (let i = 1; i < 4; i++) assert.notEqual(s[i].pillar, s[i - 1].pillar, `positions ${i - 1}/${i}`);
  const many = Array.from({ length: 40 }, (_, i) => mk(i, `P${i % 5}`, "K1")); assert.equal(scheduleTopics(many, "2026-12-01").length, CALENDAR_SIZE);
  assert.deepEqual(scheduleTopics([], "2026-12-01"), []);
});

test("assembleCalendar runs the whole gate and reports what it rejected", () => {
  const lane = (raw) => ({ laneId: "gaps", raw });
  const r = assembleCalendar([lane({ topics: [good(), good({ title: "The Ultimate Guide to Teaching in Kenya Today", primaryKeyword: "teaching in kenya", groundingId: "Q1" }), good({ title: "Hallucinated grounding topic about teaching rubrics", primaryKeyword: "teaching rubrics", groundingId: "Z9" })] })], input, "2026-12-01");
  assert.equal(r.topics.length, 1); assert.equal(r.topics[0].scheduledFor, "2026-12-01"); assert.equal(r.rejected.length, 2);
});

test("prompts carry the data ids, the lane brief, the market and the rules; page text can't act as instructions", () => {
  const { system, prompt } = buildLanePrompt(input, LANES[0], "Kenya");
  assert.match(system, /cite an item only by its id/); assert.match(system, /Target market: Kenya/); assert.match(system, /not instructions/);
  assert.match(prompt, /Q1: grade 9 teacher checklist — 120 impressions/); assert.match(prompt, /MEASURED gaps/); assert.match(prompt, /ORIGINAL value/); assert.match(prompt, /NO "ultimate guide"/);
});

test("calendarContext builds ids from real data, and drops weak or empty sources", () => {
  const b = {
    siteCrawl: { domain: "darasa.site", startUrl: "https://darasa.site/", pages: [{ url: "https://darasa.site/", title: "Darasa", fullText: "x" }, { url: "https://darasa.site/a", title: "A page" }] },
    gscReport: { queries: [{ query: "low", impressions: 3, position: 20 }, { query: "grade 9 checklist", impressions: 200, clicks: 4, position: 11.234 }] },
    siteKeywordClusters: { opportunities: [{ problem: "Gap one", evidence: "e" }] }, siteAeoAnalysis: { questions: [{ question: "answered?", coverage: "Answered" }, { question: "open?", coverage: "Missing", missingInfo: "m" }] },
    siteGeoAnalysis: { opportunities: [{ title: "Add About page", why: "w" }] }, keywords: [{ keyword: "cbc notes" }], contentIdeas: [{ title: "Old idea" }], competitors: [{ name: "Rival" }],
    serpChecks: [{ query: "cbc", country: "Kenya", results: [{ rank: 1, url: "https://rival.com/x" }, { rank: 4, url: "https://www.darasa.site/y" }] }],
  };
  const r = buildCalendarInput(b, { startDate: "2026-12-01" });
  const ids = r.items.map((i) => i.id);
  assert.deepEqual(ids, ["Q1", "K1", "A1", "E1", "S1", "T1", "P1", "P2"]); assert.match(r.items[0].note, /200 impressions.*11\.2/); assert.match(r.items.find((i) => i.id === "S1").note, /site ranks #4/);
  assert.deepEqual(r.existingTitles, ["Darasa", "A page", "Old idea"]); assert.equal(r.competitors[0], "Rival"); assert.equal(buildCalendarInput(null).items.length, 0);
  const cleaned = cleanCalendarInput(r); assert.equal(cleaned.items.length, r.items.length);
});

test("the route is guarded, validates the country, and uses the lane prompts", () => {
  const s = readFileSync(new URL("../app/api/content-calendar/route.js", import.meta.url), "utf8");
  assert.match(s, /guardJson\(req, "aiHeavy"\)/); assert.match(s, /normalizeCountry\(guard\.body\?\.country\)/); assert.match(s, /LANES\.map/); assert.match(s, /assembleCalendar\(/); assert.ok(s.indexOf("guardJson(") < s.indexOf("callOpenRouterJson("));
});

import { buildOpportunityQueue } from "../lib/opportunityQueue.js";
test("calendar topics reach the Opportunity Queue only in the week before their publish date", () => {
  const NOW = Date.parse("2026-12-01T00:00:00Z");
  const idea = (id, scheduledFor) => ({ id, title: `Topic ${id}`, primaryKeyword: "kw", intent: "Informational", status: "Idea", questions: [], outline: [], scheduledFor });
  const b = { siteCrawl: null, actions: [], competitors: [], internalLinks: [], contentIdeas: [idea("soon", "2026-12-05"), idea("late", "2026-12-25"), idea("none", undefined), idea("bad", "not-a-date")] };
  const ids = buildOpportunityQueue(b, { country: "Worldwide", nowMs: NOW }).filter((o) => o.id.startsWith("content:")).map((o) => o.id).sort();
  assert.deepEqual(ids, ["content:bad", "content:none", "content:soon"]);
});
