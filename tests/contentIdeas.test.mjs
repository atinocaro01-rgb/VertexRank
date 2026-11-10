import test from "node:test";
import assert from "node:assert/strict";
import { ideaStage, isMarked, splitForRegenerate, rememberRejected, regenerateSize, occupiedDays, STAGES } from "../lib/contentIdeas.js";
import { cleanCalendarInput, buildLanePrompt, scheduleTopics, assembleCalendar, LANES } from "../lib/contentCalendar.js";
import { buildCalendarInput } from "../lib/calendarContext.js";

test("ideaStage: the colour comes from the status you set, whether or not the tool wrote the content", () => {
  assert.equal(ideaStage({ status: "Idea" }), "idea");
  assert.equal(ideaStage({}), "idea");
  assert.equal(ideaStage({ status: "Drafting" }), "draft");
  assert.equal(ideaStage({ status: "Ready" }), "draft");
  assert.equal(ideaStage({ status: "Published" }), "published");
  assert.equal(ideaStage({ status: "Published", draft: null }), "published"); // marked green by hand, no draft in the tool
  assert.deepEqual(STAGES.map((s) => s.status), ["Idea", "Drafting", "Published"]);
});

test("splitForRegenerate keeps everything marked, drafted or added by you, and replaces only plain ideas", () => {
  const ideas = [
    { id: 1, status: "Idea" }, { id: 2, status: "Drafting" }, { id: 3, status: "Published" }, { id: 4, status: "Idea", draft: { text: "x" } },
    { id: 5, status: "Idea", source: "Added by you" }, { id: 6, status: "Ready" }, { id: 7 },
  ];
  const { kept, replace } = splitForRegenerate(ideas);
  assert.deepEqual(kept.map((c) => c.id), [2, 3, 4, 5, 6]);
  assert.deepEqual(replace.map((c) => c.id), [1, 7]);
  assert.equal(isMarked({ status: "Idea" }), false);
  assert.deepEqual(splitForRegenerate(null), { kept: [], replace: [] });
});

test("rememberRejected: newest first, no repeats (any case), capped", () => {
  assert.deepEqual(rememberRejected(["B", "a"], "A"), ["A", "B"]);
  assert.deepEqual(rememberRejected([], ["  x  y ", "X Y", ""]), ["x y"]);
  assert.equal(rememberRejected(Array.from({ length: 100 }, (_, i) => `t${i}`), "new").length, 80);
  assert.equal(rememberRejected(undefined, undefined).length, 0);
});

test("regenerateSize asks for a month minus what is kept, never fewer than 6", () => {
  assert.equal(regenerateSize(0), 30); assert.equal(regenerateSize(10), 20); assert.equal(regenerateSize(29), 6); assert.equal(regenerateSize(50), 6);
});

test("occupiedDays lists only real dates once", () => {
  assert.deepEqual(occupiedDays([{ scheduledFor: "2026-12-02" }, { scheduledFor: "2026-12-02" }, { scheduledFor: "" }, {}, { scheduledFor: "tomorrow" }]), ["2026-12-02"]);
});

test("the calendar input carries avoid-titles, occupied days and size; the prompt tells the model what was rejected", () => {
  const input = cleanCalendarInput({ site: { domain: "a.com" }, avoidTitles: ["Bad idea one", "", "Bad idea two"], occupiedDays: ["2026-12-02", "nope"], size: 99, startDate: "2026-12-01" });
  assert.deepEqual(input.avoidTitles, ["Bad idea one", "Bad idea two"]);
  assert.deepEqual(input.occupiedDays, ["2026-12-02"]);
  assert.equal(input.size, 30);
  assert.equal(cleanCalendarInput({ size: 8 }).size, 8);
  assert.equal(cleanCalendarInput({}).size, 30);
  const { prompt } = buildLanePrompt(input, LANES[0], "Worldwide");
  assert.match(prompt, /REJECTED OR WANTS REPLACED/); assert.match(prompt, /- Bad idea one/);
});

test("scheduleTopics skips days the kept topics already use, and respects the size", () => {
  const t = (title, pillar) => ({ title, pillar, grounding: { kind: "Q" }, internalLinkTargets: [], format: "How-to guide" });
  const out = scheduleTopics([t("a", "x"), t("b", "y"), t("c", "z")], "2026-12-01", 2, ["2026-12-01", "2026-12-03"]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((x) => x.scheduledFor), ["2026-12-02", "2026-12-04"]);
});

test("assembleCalendar never returns a topic you deleted (or a close variant)", () => {
  const input = cleanCalendarInput({ site: { domain: "a.com" }, items: [{ id: "Q1", text: "cbc schemes of work" }], avoidTitles: ["How to Write CBC Schemes of Work That Pass Inspection"], size: 5 });
  const topic = (title, kw) => ({ title, primaryKeyword: kw, secondaryKeywords: [], intent: "Informational", funnel: "Consideration", pillar: kw, format: "How-to guide", angle: "A worked example with the inspector's checklist we actually used in class.", groundingId: "Q1", wordCountTarget: 1200, internalLinkTargets: [], rationale: "r" });
  const r = assembleCalendar([{ laneId: "gaps", raw: { topics: [topic("How to Write CBC Schemes of Work That Pass Inspection Easily", "cbc schemes of work"), topic("Planning a Term of CBC Lessons From Scratch Without Stress", "cbc lesson planning")] } }], input, "2026-12-01");
  assert.deepEqual(r.topics.map((x) => x.primaryKeyword), ["cbc lesson planning"]);
});

test("buildCalendarInput for a regenerate: only kept ideas count as existing, replaced ones are listed to move away from, kept days are occupied", () => {
  const b = { siteCrawl: { domain: "a.com", startUrl: "https://a.com/", pages: [{ url: "https://a.com/", title: "Home" }] }, contentIdeas: [{ title: "Keep me", scheduledFor: "2026-12-03" }, { title: "Replace me" }] };
  const keep = [b.contentIdeas[0]];
  const input = buildCalendarInput(b, { startDate: "2026-12-01", keep, avoidTitles: ["Deleted one"], replaceTitles: ["Replace me"], size: 29 });
  assert.ok(input.existingTitles.includes("Keep me")); assert.ok(!input.existingTitles.includes("Replace me"));
  assert.deepEqual(input.avoidTitles, ["Deleted one", "Replace me"]);
  assert.deepEqual(input.occupiedDays, ["2026-12-03"]); assert.equal(input.size, 29);
  // default (no keep): every idea counts as existing, nothing occupied/avoided
  const d = buildCalendarInput(b, { startDate: "2026-12-01" });
  assert.ok(d.existingTitles.includes("Replace me")); assert.deepEqual(d.avoidTitles, []);
});
