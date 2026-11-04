import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { topPayload, unpackTop, competitorMovement, ownersAcross, extractPagePhrases, mergeKeywordIdeas, normPhrase } from "../lib/keywordIntel.js";
import { normalizeRelated } from "../lib/serpProvider.js";
import { slimCheck } from "../lib/serpInsights.js";
import { slimCompetitorCrawl } from "../lib/competitorIntel.js";
import { buildCalendarInput } from "../lib/calendarContext.js";
import { cleanCalendarInput } from "../lib/contentCalendar.js";
import { createStore } from "../lib/serpStore.js";

test("normalizeRelated keeps related searches and people-also-ask QUESTIONS only, never the answer snippets", () => {
  const r = normalizeRelated({ related_searches: [{ query: "cbc schemes of work pdf", link: "x" }, { query: "cbc schemes of work pdf" }, { query: "" }, null], related_questions: [{ question: "How do I write a scheme of work?", snippet: "ANSWER TEXT FROM ANOTHER SITE", link: "https://x.com" }, { question: "ab" }] });
  assert.deepEqual(r, { searches: ["cbc schemes of work pdf"], questions: ["How do I write a scheme of work?"] });
  assert.ok(!JSON.stringify(r).includes("ANSWER TEXT")); assert.deepEqual(normalizeRelated(null), { searches: [], questions: [] });
  assert.equal(normalizeRelated({ related_searches: Array.from({ length: 30 }, (_, i) => ({ query: `query number ${i}` })) }).searches.length, 12);
});

test("slimCheck carries the related suggestions; stored payloads read in both the old and the new shape", () => {
  const c = slimCheck({ query: "kenya safari", country: "Kenya", device: "desktop", observedAt: "2026-11-01T00:00:00Z", source: "SerpApi (Google)", results: [{ rank: 1, title: "A", url: "https://a.com/" }], related: { searches: ["safari prices", "ab"], questions: ["Is it safe?"] } });
  assert.deepEqual(c.related, { searches: ["safari prices"], questions: ["Is it safe?"] }); assert.deepEqual(slimCheck({ query: "x y", country: "Kenya", observedAt: "2026-11-01T00:00:00Z", results: [] }).related, { searches: [], questions: [] });
  const p = topPayload([{ rank: 1, title: "t", url: "https://a.com", snippet: "dropped" }], { searches: ["one search"], questions: [] });
  assert.deepEqual(unpackTop(p), p); assert.ok(!("snippet" in p.results[0]));
  assert.deepEqual(unpackTop([{ rank: 1, url: "https://a.com" }, null]).results.length, 1); assert.deepEqual(unpackTop(null), { results: [], related: { searches: [], questions: [] } }); assert.deepEqual(unpackTop("junk").results, []);
});

const R = (arr) => arr.map(([rank, url]) => ({ rank, title: `T${rank}`, url }));
test("competitorMovement: who moved up or down, new entrants, who dropped out, and your own rank kept separate", () => {
  const prev = R([[1, "https://a.com/x"], [2, "https://b.com/"], [3, "https://mysite.com/p"], [4, "https://gone.com/"]]);
  const now = R([[1, "https://b.com/"], [2, "https://a.com/x"], [3, "https://new.com/"], [5, "https://www.mysite.com/q"]]);
  const m = competitorMovement(now, prev, "mysite.com");
  assert.deepEqual(m.rows.map((r) => [r.host, r.rank, r.change, r.isNew]), [["b.com", 1, 1, false], ["a.com", 2, -1, false], ["new.com", 3, null, true]]);
  assert.deepEqual(m.dropped, [{ host: "gone.com", prevRank: 4 }]); assert.equal(m.ownRank, 5); assert.equal(m.ownPrevRank, 3);
  const first = competitorMovement(now, null, "mysite.com"); assert.equal(first.rows.every((r) => r.change === null && r.isNew === false), true); assert.deepEqual(first.dropped, []);
  const out = competitorMovement(R([[1, "https://a.com/"]]), prev, "mysite.com"); assert.equal(out.ownRank, null); assert.equal(out.ownPrevRank, 3);
  assert.deepEqual(competitorMovement(null, null, "x.com").rows, []);
});

test("ownersAcross: hosts that keep appearing across your tracked keywords, without your site or big platforms", () => {
  const o = ownersAcross([
    { query: "k1", results: R([[1, "https://a.com/"], [2, "https://en.wikipedia.org/wiki/X"], [3, "https://mysite.com/"]]) },
    { query: "k2", results: R([[2, "https://a.com/y"], [1, "https://b.com/"]]) },
    { query: "k3", results: { results: R([[4, "https://a.com/z"]]), related: {} } },
  ], "mysite.com");
  assert.deepEqual(o.map((x) => [x.host, x.keywords, x.avgRank, x.bestRank]), [["a.com", 3, 2.3, 1], ["b.com", 1, 1, 1]]); assert.deepEqual(o[0].sample, ["k1", "k2", "k3"]); assert.deepEqual(ownersAcross(null, "x.com"), []);
});

const pg = (url, title, h1, headings = [], wordCount = 800) => ({ url, title, h1Text: h1, wordCount, outlineHeadings: headings.map(([level, text]) => ({ level, text })) });
const rival = (id, name, domain, pages) => ({ id, name, url: `https://${domain}`, crawlSummary: slimCompetitorCrawl({ domain, pages }) });
const A = rival("c1", "Rival", "rival.co.ke", [
  pg("https://rival.co.ke/a", "CBC Schemes of Work | Rival", "CBC Schemes of Work", [[2, "Lesson plan template"], [2, "Contact us"]]),
  pg("https://rival.co.ke/b", "Free Lesson Plan Template for Teachers - Rival", "Lesson plan template", [[3, "Weekly lesson plan template"]]),
  pg("https://rival.co.ke/privacy", "Privacy Policy", "Privacy policy", []), pg("https://rival.co.ke/thin", "Thin Page Here", "Thin page", [], 50),
]);
const B = rival("c2", "Other Co", "other.com", [pg("https://other.com/x", "Lesson Plan Template Download", "Lesson plan template", [[2, "Schemes of work"]])]);
const ours = { domain: "darasa.site", pages: [{ url: "https://darasa.site/schemes", title: "CBC Schemes of Work", h1Text: "Schemes of work", h2Texts: [], h3Texts: [], fullText: "" }, { url: "https://darasa.site/p", title: "Planning", h1Text: "Planning", h2Texts: [], h3Texts: [], fullText: "We also share a free lesson plan template for every grade." }] };

test("extractPagePhrases: phrases competitors target, counted across pages and competitors, with brand names, generic words and utility pages removed", () => {
  const p = extractPagePhrases([A, B], ours, { tracked: ["Schemes of work"], gscQueries: ["free lesson plan template kenya"] });
  const by = Object.fromEntries(p.map((x) => [x.phrase, x]));
  assert.ok(by["lesson plan template"], JSON.stringify(p.map((x) => x.phrase)));
  assert.equal(by["lesson plan template"].competitors.length, 2); assert.ok(by["lesson plan template"].pages >= 3); assert.equal(by["lesson plan template"].youTarget, "partial"); assert.equal(by["lesson plan template"].inGsc, true);
  assert.equal(by["schemes of work"].youTarget, "yes"); assert.equal(by["schemes of work"].tracked, true);
  for (const bad of ["rival", "contact us", "privacy policy", "thin page"]) assert.ok(!p.some((x) => x.phrase.includes(bad)), bad);
  assert.ok(!p.some((x) => x.phrase === "plan template"), "a shorter phrase that only repeats a longer one is dropped");
  assert.equal(p[0].phrase, "lesson plan template", "most widely targeted first"); assert.deepEqual(extractPagePhrases(null, null), []);
  assert.equal(extractPagePhrases([A, B], null).every((x) => x.youTarget === "no"), true);
});

test("mergeKeywordIdeas: one list from page phrases, related searches and people-also-ask; seeds excluded; more sources rank higher; flags set", () => {
  const phrases = extractPagePhrases([A, B], ours);
  const ideas = mergeKeywordIdeas({
    phrases, tracked: ["schemes of work"], gscQueries: ["lesson plan template for grade 9"], ourCrawl: ours,
    checks: [{ query: "teacher resources kenya", related: { searches: ["lesson plan template", "cbc notes grade 9", "teacher resources kenya"], questions: ["How do I write a lesson plan?"] } }],
    trackedRelated: [{ query: "cbc schemes", related: { searches: ["cbc notes grade 9"], questions: [] } }],
  });
  const by = Object.fromEntries(ideas.map((i) => [normPhrase(i.query), i]));
  const lp = by["lesson plan template"]; assert.deepEqual(lp.sources.map((s) => s.type).sort(), ["competitor_pages", "related_search"]); assert.equal(lp.inGsc, true); assert.equal(ideas[0].query, "lesson plan template");
  assert.equal(by["cbc notes grade 9"].sources.length, 2, "seen from two different seed searches");
  assert.ok(!by["teacher resources kenya"], "a seed query is not an idea"); assert.equal(by["how do i write a lesson plan"].kind, "question"); assert.equal(by["how do i write a lesson plan"].youTarget, "n/a");
  assert.equal(by["schemes of work"].tracked, true); assert.deepEqual(mergeKeywordIdeas({}), []);
});

test("the calendar gets Google's related suggestions (ids R…) and competitor phrases you don't target; the cleaner accepts R", () => {
  const b = { siteCrawl: ours, competitors: [A, B], keywords: [], contentIdeas: [], serpChecks: [{ query: "teacher resources", country: "Kenya", results: [], related: { searches: ["cbc notes grade 9"], questions: ["How do I plan a term?"] } }] };
  const input = buildCalendarInput(b, { startDate: "2026-12-01" });
  const rs = input.items.filter((i) => i.id.startsWith("R")); assert.deepEqual(rs.map((i) => i.text), ["How do I plan a term?", "cbc notes grade 9"]); assert.match(rs[0].note, /people also ask/);
  assert.equal(cleanCalendarInput(input).items.filter((i) => i.id.startsWith("R")).length, 2);
  assert.equal(buildCalendarInput({ siteCrawl: ours, competitors: [], serpChecks: [{ query: "x y", results: [] }] }).items.filter((i) => i.id.startsWith("R")).length, 0);
});

test("store.recentTopResults reads the stored results, and the history route builds movement, owners and suggestions from them", async () => {
  const calls = [];
  const store = createStore({ env: { SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ keyword_id: "0b9f1c2e-1111-4222-8333-444455556666", checked_at: "2026-11-02T00:00:00Z", top_results: { results: [], related: {} } }] }; } });
  const r = await store.recentTopResults(["0b9f1c2e-1111-4222-8333-444455556666", "bad id"], "2026-01-01T00:00:00Z");
  assert.equal(r[0].topResults.results.length, 0); assert.match(calls[0], /select=keyword_id,checked_at,top_results/); assert.ok(!calls[0].includes("bad"));
  assert.deepEqual(await store.recentTopResults([], "x"), []);
  const src = readFileSync(new URL("../app/api/serp/history/route.js", import.meta.url), "utf8");
  assert.match(src, /recentTopResults\(/); assert.match(src, /competitorMovement\(/); assert.match(src, /ownersAcross\(/); assert.ok(!/process\.env/.test(src));
});
