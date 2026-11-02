// Getting more out of competitor crawls — what real competitors' pages show about what readers ask, what a page on a topic covers,
// and which outside sources the field relies on. Pure and client-safe (no I/O). Tests: tests/competitorIntel.test.mjs.
//
// Everything here is OBSERVED from crawled pages and labelled as such. What is reused and what is not:
//   - QUESTIONS are kept exactly as asked (short, generic labels of reader intent);
//   - HEADINGS are shown as research ("sections competitors cover"), never as text to publish;
//   - SOURCE LINKS are only pointers to pages the person can read and decide to cite;
//   - page BODY TEXT and ANSWERS are never extracted or reused. The tools that follow (Generate fix, the article writer) are told
//     to answer from YOUR facts in your own words: copying or lightly rewording a competitor's copy is a copyright problem and the
//     kind of scraped, stitched content Google's spam policies target.

import { similarity } from "./contentCalendar.js";
import { isQuestionText } from "./faqSchema.js";
import { isGenericHost } from "./serpInsights.js";
import { authorityOf } from "./sourceTools.js";
import { hostOf } from "./serpMatch.js";
import { extractExistingQuestions } from "./textIntelligence.js";

const clean = (s, n = 400) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return Math.abs(h).toString(36); };

/* ------------------------------------------------------------------ */
/* storing a compact competitor crawl                                 */
/* ------------------------------------------------------------------ */

export const normalizeQuestion = (q) => clean(q).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

const JUNK_Q = /cookie|newsletter|subscribe|log ?in\b|sign ?(up|in)\b|password|privacy policy|terms (of|and)|unsubscribe|captcha|click here|cart\b|checkout|my account/i;

/** A question worth keeping: sentence-sized, no links, not site-chrome. */
export function usableQuestion(q) {
  const t = clean(q, 200);
  const words = t.split(" ").length;
  return t.length >= 15 && t.length <= 140 && words >= 3 && words <= 26 && !/https?:|www\./i.test(t) && !JUNK_Q.test(t) && /\p{L}/u.test(t);
}

const UTILITY_URL = /\/(privacy|terms|cookie|login|log-in|signin|sign-in|register|cart|checkout|account|contact|about|careers?|jobs|search|tag|author|feed|wp-)\b|[?#]/i;
const SOURCE_HOST_SKIP = /(^|\.)(bit\.ly|t\.co|goo\.gl|ow\.ly|tinyurl\.com|apps\.apple\.com|play\.google\.com|doubleclick\.net|googleadservices\.com|googletagmanager\.com|wa\.me|api\.whatsapp\.com|paypal\.com|stripe\.com|shopify\.com|wordpress\.org|gravatar\.com|schema\.org|w3\.org)$/i;

/**
 * Shrinks a competitor crawl (≤25 pages, with 4,000 characters of text each) to what these tools need, so it can be stored with the
 * competitor: titles, outline, the questions each page asks (kept exactly), schema types, size, and the outside pages it links to.
 * No page text is kept.
 */
export function slimCompetitorCrawl(crawl, { maxPages = 25 } = {}) {
  const pages = [];
  for (const p of (Array.isArray(crawl?.pages) ? crawl.pages : []).slice(0, maxPages)) {
    if (!p?.url) continue;
    const seen = new Set();
    const questions = [];
    const add = (q, src) => { const t = clean(q, 200); const n = normalizeQuestion(t); if (n && !seen.has(n) && usableQuestion(t)) { seen.add(n); questions.push({ q: t, src }); } };
    (p.faqQuestions || []).forEach((q) => add(q, "faq"));
    (p.questionHeadings || []).forEach((q) => add(q, "heading"));
    for (const q of extractExistingQuestions(p)) if (isQuestionText(q, { strict: true })) add(q, "text");
    const headings = (p.outlineHeadings?.length ? p.outlineHeadings : [...(p.h2Texts || []).map((t) => ({ level: 2, text: t })), ...(p.h3Texts || []).map((t) => ({ level: 3, text: t }))])
      .map((h) => ({ l: h.level === 3 ? 3 : h.level === 4 ? 4 : 2, t: clean(h.text, 140) })).filter((h) => h.t).slice(0, 40);
    const cites = [];
    const seenCite = new Set();
    for (const l of Array.isArray(p.externalLinkUrls) ? p.externalLinkUrls : []) {
      const url = typeof l === "string" ? l : l?.url;
      if (!/^https?:\/\//i.test(url || "") || seenCite.has(url)) continue;
      seenCite.add(url);
      cites.push({ url: String(url).slice(0, 400), host: hostOf(url), anchor: clean(l?.anchorText, 100) });
      if (cites.length >= 15) break;
    }
    pages.push({ url: p.url, title: clean(p.title, 200), h1: clean(p.h1Text, 200), headings, questions: questions.slice(0, 25), schemaTypes: (p.schemaTypes || []).slice(0, 10).map(String), wordCount: Number(p.wordCount) || 0, lists: Number(p.listItemCount) || 0, tables: Number(p.tableCount) || 0, cites });
  }
  return { domain: String(crawl?.domain || "").slice(0, 200), pagesCrawled: Number(crawl?.pagesCrawled) || pages.length, crawledAt: new Date().toISOString(), pages };
}

/* ------------------------------------------------------------------ */
/* our own signals (works with older crawls that lack the new fields) */
/* ------------------------------------------------------------------ */

function ourSignals(ourCrawl, answeredAeo = []) {
  const questions = [];
  const headings = [];
  for (const p of Array.isArray(ourCrawl?.pages) ? ourCrawl.pages : []) {
    [...(p.faqQuestions || []), ...(p.questionHeadings || [])].forEach((q) => questions.push({ text: q, url: p.url }));
    for (const q of extractExistingQuestions(p)) questions.push({ text: q, url: p.url });
    const hs = p.outlineHeadings?.length ? p.outlineHeadings.map((h) => h.text) : [...(p.h2Texts || []), ...(p.h3Texts || [])];
    hs.forEach((t) => { questions.push({ text: t, url: p.url }); headings.push({ text: t, url: p.url }); }); // a heading can answer a question too
  }
  for (const q of answeredAeo) questions.push({ text: q, url: "" });
  return { questions, pages: Array.isArray(ourCrawl?.pages) ? ourCrawl.pages : [] };
}

/* ------------------------------------------------------------------ */
/* question bank                                                      */
/* ------------------------------------------------------------------ */

const SRC_WEIGHT = { faq: 3, heading: 2, text: 1 };
const brandTokens = (competitor) => [...new Set(`${competitor?.name || ""} ${String(competitor?.crawlSummary?.domain || competitor?.url || "").replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[./]/)[0]}`
  .toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4))];

/**
 * Every question the competitors' pages ask, exactly as written, with how many competitors ask it and whether YOUR site already
 * answers it. Questions that name the competitor's own brand are skipped (they can't be reused as written).
 * competitors: [{ id, name, url, crawlSummary }]; answeredAeo: questions your AEO analysis marks "Answered".
 */
export function questionBank(competitors, ourCrawl, { answeredAeo = [] } = {}) {
  const ours = ourSignals(ourCrawl, answeredAeo);
  const by = new Map();
  let skippedBrand = 0;
  for (const c of Array.isArray(competitors) ? competitors : []) {
    const brands = brandTokens(c);
    for (const p of c?.crawlSummary?.pages || []) {
      for (const { q, src } of p.questions || []) {
        const n = normalizeQuestion(q);
        if (!n) continue;
        if (brands.some((b) => n.includes(b))) { skippedBrand++; continue; }
        const e = by.get(n) || { id: `cq_${hash(n)}`, question: q, weight: 0, competitors: new Map(), sources: new Set(), pages: [] };
        if ((SRC_WEIGHT[src] || 0) > e.weight) { e.weight = SRC_WEIGHT[src]; e.question = q; }
        e.sources.add(src);
        e.competitors.set(c.id || c.name, c.name || hostOf(c.url));
        if (e.pages.length < 4 && !e.pages.some((x) => x.url === p.url)) e.pages.push({ competitor: c.name || hostOf(c.url), url: p.url });
        by.set(n, e);
      }
    }
  }
  const items = [...by.values()].map((e) => {
    let best = 0, bestUrl = "";
    for (const o of ours.questions) { const s = similarity(e.question, o.text); if (s > best) { best = s; bestUrl = o.url; } }
    return {
      id: e.id, question: e.question, count: e.competitors.size, competitors: [...e.competitors.values()], sources: [...e.sources].sort((a, b) => SRC_WEIGHT[b] - SRC_WEIGHT[a]),
      pages: e.pages, answered: best >= 0.6 ? "yes" : best >= 0.4 ? "partial" : "no", ourUrl: best >= 0.4 ? bestUrl : "", weight: e.weight,
    };
  });
  items.sort((a, b) => b.count - a.count || b.weight - a.weight || a.question.localeCompare(b.question));
  return { items: items.map(({ weight, ...i }) => i), skippedBrand, total: items.length, unanswered: items.filter((i) => i.answered === "no").length };
}

/* ------------------------------------------------------------------ */
/* outline gaps                                                       */
/* ------------------------------------------------------------------ */

const GENERIC_HEADING = /^(contact|contact us|about|about us|menu|navigation|related (posts|articles)|share|share this|comments?|leave a (reply|comment)|footer|newsletter|subscribe|table of contents|search|categories|tags|recent posts|follow us|quick links|resources|faq|faqs|frequently asked questions|conclusion|introduction|overview|summary|read more|you may also like|popular posts)$/i;

const goodHeading = (t) => { const s = clean(t, 140); return s.length >= 4 && s.length <= 100 && !GENERIC_HEADING.test(s); };
const topicText = (p) => `${p.title || ""} ${p.h1 || ""}`;

// Headings on one topic all share that topic's words ("What is a lesson plan?" / "Parts of a lesson plan"), so the page's own topic
// words are ignored when deciding whether two headings are the same section; a heading that is ONLY the topic (a definition) matches
// only a near-identical one.
const FILLER = new Set(["the", "and", "for", "with", "how", "what", "why", "when", "who", "your", "you", "are", "is", "to", "of", "a", "an", "in", "on", "do", "does", "can", "should"]);
const stripTopic = (text, topic) => String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !topic.has(w) && !FILLER.has(w)).join(" ");
function sameSection(a, b, topic) {
  const sa = stripTopic(a, topic), sb = stripTopic(b, topic);
  if (!sa.trim() || !sb.trim()) return similarity(a, b) >= 0.8;
  return similarity(sa, sb) >= 0.45;
}

function ourPageSignals(ourCrawl) {
  return (Array.isArray(ourCrawl?.pages) ? ourCrawl.pages : []).map((p) => ({
    url: p.url, title: p.title || "", h1: p.h1Text || "",
    headings: (p.outlineHeadings?.length ? p.outlineHeadings.map((h) => h.text) : [...(p.h2Texts || []), ...(p.h3Texts || [])]).filter(Boolean),
  }));
}

/**
 * Where competitors' pages cover MORE than yours:
 *   - missing_sections: a competitor page matches one of your pages (similar title/H1) but has sections yours doesn't;
 *   - missing_page: competitors have a page on a topic you have no matching page for (ranked by how many competitors have one).
 * Sections are heading TEXTS shown as research ("what they cover"), not wording to publish.
 */
export function outlineGaps(competitors, ourCrawl, { limit = 14 } = {}) {
  const mine = ourPageSignals(ourCrawl);
  const sections = [], unmatched = [];
  for (const c of Array.isArray(competitors) ? competitors : []) {
    for (const p of c?.crawlSummary?.pages || []) {
      if (UTILITY_URL.test(p.url) || p.wordCount < 300) continue;
      const theirs = p.headings.filter((h) => h.l <= 3).map((h) => h.t).filter(goodHeading);
      if (theirs.length < 3) continue;
      let pair = null, ps = 0;
      for (const o of mine) { const s = similarity(topicText(p), `${o.title} ${o.h1}`); if (s > ps) { ps = s; pair = o; } }
      const name = c.name || hostOf(c.url);
      if (pair && ps >= 0.34) {
        const topic = new Set(`${p.title} ${p.h1} ${pair.title} ${pair.h1}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
        const missing = theirs.filter((h) => !pair.headings.some((oh) => sameSection(h, oh, topic))).slice(0, 8);
        if (missing.length >= 2) sections.push({ kind: "missing_sections", competitor: name, theirUrl: p.url, theirTitle: p.title, ourUrl: pair.url, ourTitle: pair.title, sections: missing, theirSectionCount: theirs.length, words: p.wordCount });
      } else {
        unmatched.push({ competitor: name, theirUrl: p.url, theirTitle: p.title || p.h1, sections: theirs.slice(0, 10), words: p.wordCount });
      }
    }
  }
  // Group unmatched pages across competitors by topic; a topic several competitors cover matters more.
  const groups = [];
  for (const u of unmatched) {
    const g = groups.find((x) => similarity(x.theirTitle, u.theirTitle) >= 0.5);
    if (g) { g.members.push(u); if (u.words > g.words) { g.words = u.words; g.sections = u.sections; g.theirUrl = u.theirUrl; g.theirTitle = u.theirTitle; } } else groups.push({ ...u, members: [u] });
  }
  const pages = groups.map((g) => ({ kind: "missing_page", competitor: [...new Set(g.members.map((m) => m.competitor))].join(", "), competitors: new Set(g.members.map((m) => m.competitor)).size, theirUrl: g.theirUrl, theirTitle: g.theirTitle, sections: g.sections, words: g.words }))
    .sort((a, b) => b.competitors - a.competitors || b.words - a.words);
  sections.sort((a, b) => b.sections.length - a.sections.length || b.words - a.words);
  return [...sections.slice(0, Math.ceil(limit / 2)), ...pages].slice(0, limit).map((g, i) => ({ id: `og_${hash(`${g.kind}|${g.ourUrl || ""}|${g.theirUrl}`)}`, rank: i + 1, ...g }));
}

/** Section headings competitors' pages cover on the same topic as an idea (research hints for the article writer). */
export function outlineHintsFor(competitors, topic, { limit = 10 } = {}) {
  const out = [];
  for (const c of Array.isArray(competitors) ? competitors : []) {
    for (const p of c?.crawlSummary?.pages || []) {
      if (UTILITY_URL.test(p.url) || similarity(topicText(p), topic) < 0.3) continue;
      for (const h of p.headings) if (h.l <= 3 && goodHeading(h.t) && !out.some((x) => similarity(x, h.t) >= 0.6)) out.push(h.t);
    }
  }
  return out.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* sources the field cites                                            */
/* ------------------------------------------------------------------ */

const AUTH_RANK = { Government: 0, "International body": 1, "Education / research": 2, Organisation: 3, Other: 4 };

/** Outside pages that competitors link to, with how many of their pages cite each. Deep links only (not bare homepages), without
 *  social/Q&A/marketplace hosts, ad and tracking hosts, or your own site. Authoritative hosts first. */
export function competitorCitations(competitors, { ownHost = "" } = {}) {
  const own = hostOf(ownHost);
  const by = new Map();
  for (const c of Array.isArray(competitors) ? competitors : []) {
    const cHost = hostOf(c?.crawlSummary?.domain || c?.url);
    for (const p of c?.crawlSummary?.pages || []) {
      for (const l of p.cites || []) {
        const host = hostOf(l.url);
        let path = "";
        try { path = new URL(l.url).pathname; } catch { continue; }
        if (!host || path.length <= 1 || host === own || (own && host.endsWith(`.${own}`)) || host === cHost || (cHost && host.endsWith(`.${cHost}`)) || isGenericHost(host) || SOURCE_HOST_SKIP.test(host)) continue;
        const key = l.url.replace(/[#?].*$/, "").replace(/\/$/, "");
        const e = by.get(key) || { url: l.url, host, count: 0, competitors: new Set(), anchors: new Set(), authority: authorityOf(host) };
        e.count += 1; e.competitors.add(c.name || cHost); if (l.anchor && e.anchors.size < 3) e.anchors.add(l.anchor);
        by.set(key, e);
      }
    }
  }
  return [...by.values()].map((e) => ({ url: e.url, host: e.host, authority: e.authority, count: e.count, competitors: [...e.competitors], anchors: [...e.anchors] }))
    .sort((a, b) => AUTH_RANK[a.authority] - AUTH_RANK[b.authority] || b.count - a.count || a.host.localeCompare(b.host));
}

/** The citations most relevant to a topic: URL/anchor wording that overlaps it first, then authoritative, then most-cited. */
export function citationsForTopic(citations, topic, { limit = 6 } = {}) {
  const t = new Set(String(topic || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
  const scored = (Array.isArray(citations) ? citations : []).map((c) => {
    const words = `${c.url} ${(c.anchors || []).join(" ")}`.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    const overlap = words.filter((w) => t.has(w)).length;
    return { ...c, overlap, score: overlap * 3 + (4 - AUTH_RANK[c.authority]) + Math.min(c.count, 3) * 0.5 };
  });
  const relevant = scored.filter((c) => c.overlap > 0).sort((a, b) => b.score - a.score);
  const rest = scored.filter((c) => c.overlap === 0 && c.authority !== "Other").sort((a, b) => b.score - a.score);
  return [...relevant, ...rest].slice(0, limit).map(({ overlap, score, ...c }) => c);
}
