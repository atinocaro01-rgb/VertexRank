// "Is this topic already covered?" (pure, client-safe). Tests: tests/contentCoverage.test.mjs.
//
// Builds one index of everything the site has published or planned: crawled pages, posts read from the feed/sitemap
// (lib/contentIndex.js), titles you pasted, and topics already in the planner. A new topic counts as already covered when
//   A. every meaningful word of its keyword appears in an existing page's title, H1 or URL (and the page isn't a more specific
//      variant, e.g. a different grade or year), or
//   B. the page already ranks in Search Console for almost exactly that query.
// This only compares words. It cannot tell if two differently-worded pages say the same thing, so covered topics are shown to you
// (with "Add anyway") rather than silently thrown away.

import { pageKey } from "./gscAnalysis.js";
import { topQueryByPage } from "./playbookChecks.js";

const STOP = new Set(["the", "and", "for", "with", "your", "you", "our", "how", "what", "why", "when", "who", "which", "does", "this", "that", "from", "are", "can", "best", "guide", "guides", "tips", "tip", "complete", "ultimate", "easy", "simple", "free", "new", "step", "steps", "ways", "way", "top", "need", "know", "about", "vs", "using", "use", "into", "make"]);
// Light plural handling: schemes->scheme, notes->note, classes->class, categories->category. Not a full stemmer.
const stem = (w) => (/(sses|xes|ches|shes)$/.test(w) ? w.slice(0, -2) : w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
const isYear = (w) => /^(19|20)\d{2}$/.test(w);
export const tokensOf = (s) => [...new Set(String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && (w.length > 2 || /^\d+$/.test(w)) && !STOP.has(w) && !isYear(w)).map(stem))];
const slugOf = (u) => { try { return decodeURIComponent(new URL(u).pathname).replace(/[-_/]+/g, " "); } catch { return ""; } };
const pathOf = (u) => { try { const x = new URL(u); return (x.pathname + x.search) || "/"; } catch { return String(u || ""); } };
const isHome = (u) => { try { return new URL(u).pathname.replace(/\/+$/, "") === ""; } catch { return false; } };

const BLOGGY = /\/(blog|blogs|post|posts|news|article|articles|insights?|guides?|resources?|learn|stories|journal|tips)\//i;

/** Everything known about what the site has (or plans to have). Each entry: { title, url, source, tokens, numbers, topQuery, queryTokens }. */
export function buildCoverageIndex({ crawl, report, posts = [], pasted = [], planned = [] } = {}) {
  const top = topQueryByPage(report, crawl);
  const entries = [], seen = new Set();
  const add = (e) => {
    const key = e.url ? pageKey(e.url) : `t:${e.title.toLowerCase()}`;
    if (seen.has(key) || (e.url && isHome(e.url))) return;
    seen.add(key);
    const toks = tokensOf(`${e.title} ${e.h1 || ""} ${e.url ? slugOf(e.url) : ""} ${e.keyword || ""}`);
    const q = e.url ? top.get(pageKey(e.url)) : null;
    entries.push({ title: e.title, url: e.url || "", source: e.source, tokens: toks, numbers: toks.filter((t) => /^\d+$/.test(t)), topQuery: q?.query || "", queryTokens: q ? tokensOf(q.query) : [], blog: !!e.blog, titleFromSlug: !!e.titleFromSlug });
  };
  for (const t of pasted) if (String(t).trim()) add({ title: String(t).trim().slice(0, 200), url: "", source: "pasted", blog: true });
  for (const p of posts) add({ title: p.title, url: p.url, source: "feed", blog: true, titleFromSlug: p.titleFromSlug });
  for (const p of crawl?.pages || []) if (p.title) add({ title: p.title, h1: p.h1Text, url: p.url, source: "crawl", blog: BLOGGY.test(pathOf(p.url)) || (p.schemaTypes || []).some((t) => /Article|BlogPosting|NewsArticle/i.test(t)) });
  for (const c of planned) if (c?.title) add({ title: c.title, keyword: c.primaryKeyword, url: "", source: "planner" });
  return entries;
}

/** Titles to give the AI as "already exists", most useful first (pasted, blog posts with real titles, blog-like crawled pages, the rest). */
export function existingTitlesFor(index, cap = 300) {
  const rank = (e) => (e.source === "pasted" ? 0 : e.source === "planner" ? 1 : e.blog && !e.titleFromSlug ? 2 : e.blog ? 3 : 4);
  const out = [], seen = new Set();
  for (const e of [...index].sort((a, b) => rank(a) - rank(b))) { const k = e.title.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(e.title); } if (out.length >= cap) break; }
  return out;
}

/** The existing entry that already covers this topic, or null. */
export function findCovering(topic, index) {
  const kw = tokensOf(topic.primaryKeyword || topic.title);
  if (kw.length < 2) return null;
  const kwNums = kw.filter((t) => /^\d+$/.test(t));
  for (const e of index) {
    if (e.source === "planner" && e.title === topic.title) continue;
    // A: every keyword word is in the page's title / H1 / URL, and the page isn't a more specific variant (extra numbers like a grade).
    if (kw.every((t) => e.tokens.includes(t)) && e.numbers.every((n) => kwNums.includes(n))) return { entry: e, reason: `its title or URL already covers "${topic.primaryKeyword || topic.title}"` };
    // B: the page already ranks in Search Console for (almost exactly) this query.
    if (e.queryTokens.length >= 2) {
      const inter = kw.filter((t) => e.queryTokens.includes(t)).length;
      const jac = inter / (new Set([...kw, ...e.queryTokens]).size || 1);
      if (jac >= 0.75) return { entry: e, reason: `it already ranks in Google for "${e.topQuery}"` };
    }
  }
  return null;
}

/** Splits generated topics into fresh ones and ones that repeat something that exists. */
export function splitCovered(topics, index) {
  const fresh = [], covered = [];
  for (const t of topics) { const hit = findCovering(t, index); if (hit) covered.push({ topic: t, by: { title: hit.entry.title, url: hit.entry.url, path: hit.entry.url ? pathOf(hit.entry.url) : "", source: hit.entry.source, topQuery: hit.entry.topQuery }, reason: hit.reason }); else fresh.push(t); }
  return { fresh, covered };
}

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** After covered topics are removed, lays the remaining ones out on consecutive free days again (keeping their order). */
export function relayDays(topics, startDate, taken = []) {
  const busy = new Set(taken); let day = 0;
  return [...topics].sort((a, b) => String(a.scheduledFor).localeCompare(String(b.scheduledFor))).map((t) => {
    while (busy.has(addDays(startDate, day))) day++;
    return { ...t, scheduledFor: addDays(startDate, day++) };
  });
}

/** A candidate shaped for contentIdeaFromRefresh: "update that page instead of writing a new one". */
export function refreshCandidateFor(covered) {
  const { by, topic } = covered;
  const q = by.topQuery || topic.primaryKeyword || "";
  return { page: by.url, path: by.path || pathOf(by.url), title: by.title, wordCount: 0, reasons: [{ kind: "covered", text: `Already covers "${topic.primaryKeyword || topic.title}"` }], topQueries: q ? [{ query: q, impressions: 0, position: 0 }] : [], primaryQuery: q, weight: 0 };
}
