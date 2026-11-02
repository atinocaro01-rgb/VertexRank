import test from "node:test";
import assert from "node:assert/strict";
import { extractFaqQuestions, isQuestionText } from "../lib/faqSchema.js";
import { slimCompetitorCrawl, questionBank, outlineGaps, outlineHintsFor, competitorCitations, citationsForTopic, usableQuestion, normalizeQuestion } from "../lib/competitorIntel.js";
import { buildCalendarInput } from "../lib/calendarContext.js";
import { cleanCalendarInput } from "../lib/contentCalendar.js";
import { cleanWriteInput, buildWritePrompt } from "../lib/articleWriter.js";

test("FAQ schema: questions come out of FAQPage, QAPage and nested @graph blocks, exactly as written", () => {
  const blocks = [
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "How much does a CBC scheme of work cost?", acceptedAnswer: { "@type": "Answer", text: "SECRET ANSWER" } }, { "@type": "Question", name: "Who approves it?" }] },
    [{ "@graph": [{ "@type": "WebPage" }, { "@type": ["QAPage"], mainEntity: { "@type": "Question", name: "Is it free?" } }] }],
    { "@type": "Question", name: "How much does a CBC scheme of work cost?" }, null, "junk",
  ];
  const q = extractFaqQuestions(blocks);
  assert.deepEqual(q, ["How much does a CBC scheme of work cost?", "Who approves it?", "Is it free?"]);
  assert.ok(!JSON.stringify(q).includes("SECRET")); assert.deepEqual(extractFaqQuestions(null), []);
});

test("isQuestionText: real questions yes; statements, tiny strings and non-questions no; strict mode needs a question word", () => {
  for (const ok of ["How do I write a scheme of work?", "What is the best age to start school", "Do schools in Kenya need a licence?"]) assert.equal(isQuestionText(ok), true, ok);
  for (const no of ["Contact us", "Pricing", "We help schools.", "Why choose us.", ""]) assert.equal(isQuestionText(no), false, no);
  assert.equal(isQuestionText("Ready to start today?", { strict: true }), false); assert.equal(isQuestionText("What does it cost?", { strict: true }), true);
  assert.equal(isQuestionText("What is it".padEnd(200, "x") + "?"), false);
});

test("usableQuestion drops site chrome, links and fragments; normalizeQuestion is stable", () => {
  assert.equal(usableQuestion("How long does a scheme of work take?"), true);
  for (const bad of ["Do you accept cookies?", "Subscribe to our newsletter?", "See https://x.com for more?", "Why?", "How do I log in to my account?"]) assert.equal(usableQuestion(bad), false, bad);
  assert.equal(normalizeQuestion("  How  MUCH does it cost?! "), "how much does it cost");
});

const page = (o) => ({ url: "https://rival.co.ke/blog/p", title: "CBC Schemes of Work Guide", h1Text: "CBC Schemes of Work", wordCount: 900, listItemCount: 12, tableCount: 1, schemaTypes: ["FAQPage"], h2Texts: [], h3Texts: [], fullText: "Intro text. What is a scheme of work? Short answer here. Buy now!", faqQuestions: ["How do I write a CBC scheme of work?"], questionHeadings: ["How do I write a CBC scheme of work?", "Why does Rival charge more?", "Do you accept cookies?"], outlineHeadings: [{ level: 2, text: "What a scheme contains" }, { level: 2, text: "Step by step" }, { level: 3, text: "Weekly layout" }, { level: 2, text: "Contact us" }, { level: 4, text: "Tiny" }],
  externalLinkUrls: [{ url: "https://education.go.ke/guidance/cbc", host: "education.go.ke", anchorText: "ministry guidance" }, { url: "https://facebook.com/rival", host: "facebook.com", anchorText: "fb" }, { url: "https://bit.ly/x", host: "bit.ly", anchorText: "" }, { url: "https://who.int/", host: "who.int", anchorText: "home" }], ...o });

test("slimCompetitorCrawl keeps questions exactly, the outline, schema and outside links, and drops page text", () => {
  const s = slimCompetitorCrawl({ domain: "rival.co.ke", pagesCrawled: 25, pages: [page({}), null, { title: "no url" }] });
  assert.equal(s.pages.length, 1); const p = s.pages[0];
  assert.deepEqual(p.questions.map((q) => [q.q, q.src]), [["How do I write a CBC scheme of work?", "faq"], ["Why does Rival charge more?", "heading"], ["What is a scheme of work?", "text"]]);
  assert.equal(p.headings.length, 5); assert.deepEqual(p.schemaTypes, ["FAQPage"]); assert.equal(p.cites.length, 4); assert.equal(p.cites[0].host, "education.go.ke");
  assert.ok(!JSON.stringify(s).includes("Short answer here"), "no page body text is stored"); assert.ok(!("fullText" in p));
  const old = slimCompetitorCrawl({ domain: "x.com", pages: [{ url: "https://x.com/a", title: "A", h2Texts: ["One", "Two"], h3Texts: ["Three"], fullText: "" }] });
  assert.deepEqual(old.pages[0].headings.map((h) => h.t), ["One", "Two", "Three"]); assert.deepEqual(slimCompetitorCrawl(null).pages, []);
});

const rival = { id: "c1", name: "Rival", url: "https://rival.co.ke", crawlSummary: slimCompetitorCrawl({ domain: "rival.co.ke", pages: [page({}), page({ url: "https://rival.co.ke/blog/q", title: "Lesson Plans for Grade 9", h1Text: "Grade 9 Lesson Plans", questionHeadings: ["How do I write a CBC scheme of work?", "What is a lesson plan?"], faqQuestions: [], fullText: "" })] }) };
const rival2 = { id: "c2", name: "Other Co", url: "https://other.com", crawlSummary: slimCompetitorCrawl({ domain: "other.com", pages: [page({ url: "https://other.com/guide", faqQuestions: ["How do I write a CBC scheme of work?", "What is a lesson plan?"], questionHeadings: [], fullText: "" })] }) };
const ours = { domain: "darasa.site", pages: [{ url: "https://darasa.site/lesson-plans", title: "What is a lesson plan? Explained", h1Text: "Lesson plans", h2Texts: ["What is a lesson plan?"], h3Texts: [], fullText: "" }] };

test("questionBank: exact questions, counted across competitors, marked answered or not, brand-specific ones skipped", () => {
  const bank = questionBank([rival, rival2], ours);
  const byQ = Object.fromEntries(bank.items.map((i) => [i.question, i]));
  const scheme = byQ["How do I write a CBC scheme of work?"];
  assert.equal(scheme.count, 2); assert.deepEqual(scheme.competitors.sort(), ["Other Co", "Rival"]); assert.equal(scheme.answered, "no"); assert.equal(scheme.sources[0], "faq");
  assert.equal(byQ["What is a lesson plan?"].answered, "yes"); assert.equal(byQ["What is a lesson plan?"].ourUrl, "https://darasa.site/lesson-plans");
  assert.ok(!byQ["Why does Rival charge more?"], "a question naming the competitor is skipped"); assert.ok(bank.skippedBrand >= 1);
  assert.equal(bank.items[0].count, 2); assert.equal(bank.unanswered, bank.items.filter((i) => i.answered === "no").length);
  const withAeo = questionBank([rival], ours, { answeredAeo: ["How do I write a CBC scheme of work?"] }); assert.equal(withAeo.items.find((i) => i.question.startsWith("How do I write")).answered, "yes");
  assert.deepEqual(questionBank(null, null).items, []);
  assert.equal(questionBank([{ id: "x", name: "NoCrawl" }], ours).total, 0);
});

test("outlineGaps: a matching page with missing sections, and topics several competitors cover that you have no page for", () => {
  const r1 = { id: "c1", name: "Rival", url: "https://rival.co.ke", crawlSummary: slimCompetitorCrawl({ domain: "rival.co.ke", pages: [
    { url: "https://rival.co.ke/lesson-plans", title: "What is a lesson plan? Complete explanation", h1Text: "Lesson plans", wordCount: 1200, outlineHeadings: [{ level: 2, text: "What is a lesson plan?" }, { level: 2, text: "Parts of a lesson plan" }, { level: 2, text: "Assessment ideas" }, { level: 2, text: "Common mistakes" }, { level: 2, text: "Contact us" }] },
    { url: "https://rival.co.ke/budgeting", title: "School budgeting for private schools", h1Text: "School budgeting", wordCount: 1500, outlineHeadings: [{ level: 2, text: "Setting a term budget" }, { level: 2, text: "Tracking fees" }, { level: 2, text: "Reducing costs" }] },
    { url: "https://rival.co.ke/privacy", title: "Privacy", wordCount: 900, outlineHeadings: [{ level: 2, text: "Data we collect" }, { level: 2, text: "Cookies" }, { level: 2, text: "Your rights" }] },
    { url: "https://rival.co.ke/thin", title: "Thin page", wordCount: 80, outlineHeadings: [{ level: 2, text: "One" }, { level: 2, text: "Two" }, { level: 2, text: "Three" }] },
  ] }) };
  const r2 = { id: "c2", name: "Other Co", url: "https://other.com", crawlSummary: slimCompetitorCrawl({ domain: "other.com", pages: [{ url: "https://other.com/budget", title: "Private school budgeting guide", h1Text: "School budgeting", wordCount: 1800, outlineHeadings: [{ level: 2, text: "Setting a term budget" }, { level: 2, text: "Fee tracking tools" }, { level: 2, text: "Cash flow" }] }] }) };
  const g = outlineGaps([r1, r2], ours);
  const sec = g.find((x) => x.kind === "missing_sections"); const page = g.find((x) => x.kind === "missing_page");
  assert.equal(sec.ourUrl, "https://darasa.site/lesson-plans"); assert.deepEqual(sec.sections, ["Parts of a lesson plan", "Assessment ideas", "Common mistakes"]);
  assert.equal(page.competitors, 2); assert.match(page.theirTitle, /budget/i);
  assert.ok(!g.some((x) => /privacy|thin/i.test(x.theirUrl)), "utility and thin pages are ignored"); assert.ok(g.every((x, i) => x.rank === i + 1 && x.id.startsWith("og_")));
  assert.deepEqual(outlineGaps(null, null), []);
  assert.deepEqual(outlineHintsFor([r1, r2], "private school budgeting").slice(0, 3), ["Setting a term budget", "Tracking fees", "Reducing costs"]); assert.deepEqual(outlineHintsFor([r1], "unrelated topic entirely"), []);
});

test("competitorCitations: deep links only, no social/ads/own/competitor hosts, authoritative first; citationsForTopic ranks by relevance", () => {
  const c = competitorCitations([rival, rival2], { ownHost: "darasa.site" });
  assert.deepEqual(c.map((x) => x.host), ["education.go.ke"]); assert.equal(c[0].count, 3); assert.deepEqual(c[0].anchors, ["ministry guidance"]); assert.equal(c[0].authority, "Government");
  const many = [{ url: "https://blog.example.com/cbc-schemes-guide", host: "blog.example.com", authority: "Other", count: 1, competitors: ["A"], anchors: ["cbc schemes"] }, { url: "https://who.int/health", host: "who.int", authority: "International body", count: 1, competitors: ["A"], anchors: [] }, { url: "https://x.org/unrelated", host: "x.org", authority: "Organisation", count: 1, competitors: ["A"], anchors: [] }];
  assert.deepEqual(citationsForTopic(many, "CBC schemes of work", { limit: 3 }).map((x) => x.host), ["blog.example.com", "who.int", "x.org"]);
  assert.deepEqual(citationsForTopic(null, "x"), []);
});

test("the calendar gets competitor items (ids C…), the cleaner accepts them, and nothing is added without competitor data", () => {
  const b = { siteCrawl: ours, competitors: [{ ...rival, siteAnalysis: { observed: { competitorOnlyTopics: ["school budgeting", "fee tracking"] } } }, rival2], keywords: [], contentIdeas: [] };
  const input = buildCalendarInput(b, { startDate: "2026-12-01" });
  const cs = input.items.filter((i) => i.id.startsWith("C"));
  assert.ok(cs.length >= 3); assert.match(cs[0].note, /competitor crawl/); assert.ok(cs.some((i) => /write a CBC scheme/.test(i.text)));
  assert.equal(cleanCalendarInput(input).items.filter((i) => i.id.startsWith("C")).length, cs.length);
  assert.equal(buildCalendarInput({ siteCrawl: ours, competitors: [{ name: "x" }] }).items.filter((i) => i.id.startsWith("C")).length, 0);
});

test("the article prompt carries competitor subtopics as research, with the don't-copy rule", () => {
  const i = cleanWriteInput({ idea: { title: "School budgeting for private schools" }, site: { domain: "darasa.site" }, outlineHints: ["Setting a term budget", "Reducing costs", ""] });
  assert.deepEqual(i.outlineHints, ["Setting a term budget", "Reducing costs"]);
  const { prompt } = buildWritePrompt(i, "Kenya"); assert.match(prompt, /SUBTOPICS COMPETITORS' PAGES ON THIS TOPIC COVER/); assert.match(prompt, /never copy their wording/); assert.match(prompt, /- Setting a term budget/);
  assert.match(buildWritePrompt(cleanWriteInput({ idea: { title: "T" } }), "Kenya").prompt, /\(none\)/);
});
