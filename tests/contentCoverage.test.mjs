import test from "node:test";
import assert from "node:assert/strict";
import { tokensOf, buildCoverageIndex, existingTitlesFor, findCovering, splitCovered, relayDays, refreshCandidateFor } from "../lib/contentCoverage.js";
import { contentIdeaFromRefresh } from "../lib/contentRefresh.js";
import { buildCalendarInput } from "../lib/calendarContext.js";

const crawl = { domain: "s.com", startUrl: "https://s.com/", pages: [
  { url: "https://s.com/", title: "Darasa: CBC tools for teachers", h1Text: "Welcome" },
  { url: "https://s.com/blog/schemes-of-work", title: "How to write schemes of work in CBC", h1Text: "Schemes of work" },
  { url: "https://s.com/blog/grade-4-notes", title: "Grade 4 CBC notes", h1Text: "Grade 4 notes" },
  { url: "https://s.com/blog/lesson-planning", title: "A teacher's calm approach", h1Text: "Planning" },
] };
const report = { days: 28, queryPages: [{ query: "cbc lesson plan template", page: "https://s.com/blog/lesson-planning", impressions: 400 }] };
const posts = [{ title: "Assessment rubrics explained", url: "https://s.com/blog/assessment-rubrics", titleFromSlug: false }, { title: "Parent meeting agenda", url: "https://s.com/blog/parent-meeting-agenda", titleFromSlug: true }];
const index = buildCoverageIndex({ crawl, report, posts, pasted: ["Teacher burnout and how to prevent it"], planned: [{ title: "Term planner for teachers", primaryKeyword: "term planner" }] });
const t = (title, primaryKeyword) => ({ title, primaryKeyword });

test("tokensOf drops filler words and years, and normalises plurals", () => {
  assert.deepEqual(tokensOf("The Ultimate Guide to Schemes of Work 2026"), ["scheme", "work"]);
  assert.deepEqual(tokensOf("Grade 9 notes"), ["grade", "9", "note"]);
});

test("the index covers crawled pages (not the homepage), posts, pasted titles and planned topics", () => {
  assert.deepEqual([...new Set(index.map((e) => e.source))].sort(), ["crawl", "feed", "pasted", "planner"]);
  assert.ok(!index.some((e) => e.url === "https://s.com/"));
  assert.equal(index.find((e) => e.url.endsWith("lesson-planning")).topQuery, "cbc lesson plan template");
});

test("findCovering: keyword words inside an existing title/URL, ranking for the same query, pasted titles and planned topics all count", () => {
  assert.match(findCovering(t("Schemes of work: a beginner's walkthrough", "schemes of work"), index).reason, /already covers/);
  assert.match(findCovering(t("A CBC lesson plan template you can copy", "cbc lesson plan template"), index).reason, /ranks in Google for "cbc lesson plan template"/);
  assert.equal(findCovering(t("Rubrics for assessment", "assessment rubrics"), index).entry.source, "feed");
  assert.equal(findCovering(t("Preventing teacher burnout", "teacher burnout"), index).entry.source, "pasted");
  assert.equal(findCovering(t("Planning your term", "term planner"), index).entry.source, "planner");
  assert.equal(findCovering(t("Agenda for parent meetings", "parent meeting agenda"), index).entry.titleFromSlug, true);
});

test("findCovering does not treat a different grade/number or an unrelated topic as covered, and ignores single-word keywords", () => {
  assert.equal(findCovering(t("Grade 9 CBC notes", "grade 9 cbc notes"), index), null); // page covers grade 4, not 9
  assert.equal(findCovering(t("CBC notes", "cbc notes"), index), null); // a generic topic is not covered by a grade-4 page (more specific variant)
  assert.equal(findCovering(t("Classroom management ideas", "classroom management"), index), null);
  assert.equal(findCovering(t("Schemes", "schemes"), index), null);
});

test("splitCovered separates repeats with the page that covers them; relayDays closes gaps and skips kept days", () => {
  const topics = [{ ...t("Schemes of work walkthrough", "schemes of work"), scheduledFor: "2026-12-01" }, { ...t("Classroom management ideas", "classroom management"), scheduledFor: "2026-12-02" }, { ...t("Peer observation", "peer observation"), scheduledFor: "2026-12-03" }];
  const { fresh, covered } = splitCovered(topics, index);
  assert.equal(fresh.length, 2); assert.equal(covered.length, 1);
  assert.equal(covered[0].by.path, "/blog/schemes-of-work"); assert.match(covered[0].reason, /already covers/);
  assert.deepEqual(relayDays(fresh, "2026-12-01", ["2026-12-02"]).map((x) => x.scheduledFor), ["2026-12-01", "2026-12-03"]);
});

test("existingTitlesFor puts pasted, planned and blog posts with real titles ahead of other pages, without repeats", () => {
  const titles = existingTitlesFor(index);
  assert.equal(titles[0], "Teacher burnout and how to prevent it"); assert.equal(titles[1], "Term planner for teachers");
  assert.ok(titles.indexOf("Assessment rubrics explained") < titles.indexOf("Parent meeting agenda")); // real title before slug guess
  assert.equal(new Set(titles).size, titles.length); assert.equal(existingTitlesFor(index, 3).length, 3);
});

test("the AI is told about up to 300 existing titles, and 'refresh that page instead' makes a normal refresh topic", () => {
  const many = Array.from({ length: 350 }, (_, i) => `Existing post ${i}`);
  assert.equal(buildCalendarInput({ siteCrawl: crawl, contentIdeas: [] }, { startDate: "2026-12-01", extraTitles: many }).existingTitles.length, 300);
  const { covered } = splitCovered([t("Schemes of work walkthrough", "schemes of work")], index);
  const idea = contentIdeaFromRefresh(refreshCandidateFor(covered[0]), "ci_1", "w1");
  assert.equal(idea.title, "Refresh: How to write schemes of work in CBC"); assert.deepEqual(idea.internalLinkTargets, ["https://s.com/blog/schemes-of-work"]); assert.equal(idea.source, "Content refresh");
  assert.match(idea.rationale, /Already covers "schemes of work"/);
});
