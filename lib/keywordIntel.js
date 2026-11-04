// Keywords from competitors and from Google's own suggestions, and who ranks for the keywords you track. Pure and client-safe (no I/O).
// Tests: tests/keywordIntel.test.mjs.
//
// Be clear about what this is. VertexRank cannot see the full list of keywords a competitor ranks for (that needs a paid keyword
// index). What it CAN observe, and what is built here:
//   1. page phrases   — the 2-4 word phrases competitors put in their titles, H1s and headings (what their pages TARGET, not what they rank for);
//   2. Google's own   — "related searches" and "people also ask" questions returned with every live search (questions only, never answers);
//   3. who ranks      — the top results saved each time a tracked keyword is checked, and how they moved between checks;
// and they are merged into one list of ideas that can be tracked or sent to the content calendar. Everything is observed; there is no
// search volume or difficulty here, and nothing is guessed.

import { hostOf, sameSite } from "./serpMatch.js";
import { isGenericHost } from "./serpInsights.js";

const clean = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const words = (s) => clean(s, 300).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
export const normPhrase = (s) => words(s).join(" ");

/* ------------------------------------------------------------------ */
/* stored top results (a snapshot's top_results column)               */
/* ------------------------------------------------------------------ */

/** What a rank snapshot stores: the first page of results AND Google's related searches / questions for that query. */
export function topPayload(results, related) {
  return {
    results: (Array.isArray(results) ? results : []).slice(0, 10).map((r) => ({ rank: r.rank, title: clean(r.title, 200), url: clean(r.url, 500) })),
    related: { searches: cleanList(related?.searches, 12), questions: cleanList(related?.questions, 8) },
  };
}
const cleanList = (v, n) => [...new Set((Array.isArray(v) ? v : []).map((x) => clean(x, 160)).filter((x) => x.length >= 3))].slice(0, n);

/** Reads either storage shape: the original plain array of results, or { results, related }. Never throws. */
export function unpackTop(v) {
  if (Array.isArray(v)) return { results: v.filter((r) => r && r.url), related: { searches: [], questions: [] } };
  if (v && typeof v === "object") return { results: (Array.isArray(v.results) ? v.results : []).filter((r) => r && r.url), related: { searches: cleanList(v.related?.searches, 12), questions: cleanList(v.related?.questions, 8) } };
  return { results: [], related: { searches: [], questions: [] } };
}

/* ------------------------------------------------------------------ */
/* who ranks for a tracked keyword, and how that moved                */
/* ------------------------------------------------------------------ */

const bestByHost = (results) => {
  const by = new Map();
  for (const r of results) { const h = hostOf(r.url); if (h && (!by.has(h) || r.rank < by.get(h).rank)) by.set(h, r); }
  return by;
};

/**
 * Compares the newest and the previous result lists for one keyword. change > 0 means the host moved UP. Your own site is reported
 * separately (ownRank), not as a competitor.
 */
export function competitorMovement(latest, previous, siteHost) {
  const now = bestByHost(unpackTop(latest).results), before = bestByHost(unpackTop(previous).results);
  const rows = [], own = { rank: null, prevRank: null };
  for (const [host, r] of now) {
    const prev = before.get(host)?.rank ?? null;
    if (sameSite(host, siteHost)) { own.rank = r.rank; own.prevRank = prev; continue; }
    rows.push({ host, rank: r.rank, url: r.url, title: clean(r.title, 160), prevRank: prev, change: prev === null ? null : prev - r.rank, isNew: previous != null && prev === null });
  }
  const dropped = [];
  for (const [host, r] of before) if (!now.has(host) && !sameSite(host, siteHost)) dropped.push({ host, prevRank: r.rank });
  if (own.rank === null) { const p = [...before.keys()].find((h) => sameSite(h, siteHost)); own.prevRank = p ? before.get(p).rank : null; }
  rows.sort((a, b) => a.rank - b.rank);
  return { rows, dropped: dropped.sort((a, b) => a.prevRank - b.prevRank), ownRank: own.rank, ownPrevRank: own.prevRank };
}

/** Hosts that keep showing up in the results of the keywords you track, best first. Big general platforms are left out. */
export function ownersAcross(keywordResults, siteHost, { limit = 12 } = {}) {
  const by = new Map();
  for (const k of Array.isArray(keywordResults) ? keywordResults : []) {
    for (const [host, r] of bestByHost(unpackTop(k.results).results)) {
      if (sameSite(host, siteHost) || isGenericHost(host)) continue;
      const e = by.get(host) || { host, ranks: [], keywords: [] };
      e.ranks.push(r.rank); e.keywords.push(k.query);
      by.set(host, e);
    }
  }
  return [...by.values()].map((e) => ({ host: e.host, keywords: e.keywords.length, avgRank: Math.round((e.ranks.reduce((a, b) => a + b, 0) / e.ranks.length) * 10) / 10, bestRank: Math.min(...e.ranks), sample: e.keywords.slice(0, 4) }))
    .sort((a, b) => b.keywords - a.keywords || a.avgRank - b.avgRank || a.host.localeCompare(b.host)).slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* phrases competitors' pages target                                  */
/* ------------------------------------------------------------------ */

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "is", "are", "was", "were", "be", "by", "at", "from", "as", "it", "this", "that", "these", "those", "your", "you", "our", "we", "my", "i", "us", "how", "what", "why", "when", "where", "who", "which", "do", "does", "can", "will", "should", "vs", "not", "no", "yes", "all", "any", "more", "most", "best", "top", "new", "get", "has", "have", "about", "into", "than", "then", "so", "if", "its", "their", "them", "here", "there"]);
const GENERIC = /^(home|homepage|page|blog|news|contact|contact us|about|about us|read more|learn more|privacy policy|terms|faq|faqs|menu|login|sign in|sign up|cart|shop now|welcome|our team|our services|get started|click here|latest news|all rights reserved|view all|see more)$/i;
const UTILITY_URL = /\/(privacy|terms|cookie|login|log-in|signin|sign-in|register|cart|checkout|account|contact|about|careers?|jobs|search|tag|author|feed|wp-)\b|[?#]/i;
const SEPARATORS = /\s[|–—·»•]\s|\s-\s|:\s/;

const brandWords = (c) => [...new Set(`${c?.name || ""} ${String(c?.crawlSummary?.domain || c?.url || "").replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[./]/)[0]}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4))];

function* ngrams(text) {
  for (const seg of clean(text, 300).split(SEPARATORS)) {
    const w = words(seg);
    for (let n = 2; n <= 4; n++) for (let i = 0; i + n <= w.length; i++) {
      const g = w.slice(i, i + n);
      if (STOP.has(g[0]) || STOP.has(g[n - 1]) || g.some((t) => t.length < 2 || /^\d+$/.test(t))) continue;
      if (g.filter((t) => STOP.has(t)).length > 1) continue;
      const phrase = g.join(" ");
      if (!GENERIC.test(phrase)) yield phrase;
    }
  }
}

const targets = (ourCrawl, tokens) => {
  let level = "no";
  for (const p of Array.isArray(ourCrawl?.pages) ? ourCrawl.pages : []) {
    const head = words(`${p.title || ""} ${p.h1Text || ""}`);
    if (tokens.every((t) => head.includes(t))) return "yes";
    const body = ` ${[...(p.h2Texts || []), ...(p.h3Texts || []), p.fullText || ""].join(" ").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
    if (body.includes(` ${tokens.join(" ")} `)) level = "partial";
  }
  return level;
};

/**
 * The phrases competitors' pages are built around: counted per page (a phrase counts once per page, at its strongest position:
 * title/H1 over H2 over H3), kept when it is in a title or H1 or on 2+ pages, minus brand names, generic words, and shorter phrases
 * that only repeat a longer one. Each is marked "you target this" against your own crawl. `tracked` and `gscQueries` mark ones you
 * already track or already get impressions for.
 */
export function extractPagePhrases(competitors, ourCrawl, { tracked = [], gscQueries = [], limit = 40 } = {}) {
  const by = new Map();
  for (const c of Array.isArray(competitors) ? competitors : []) {
    const brands = brandWords(c);
    for (const p of c?.crawlSummary?.pages || []) {
      if (UTILITY_URL.test(p.url) || (p.wordCount && p.wordCount < 150)) continue;
      const seen = new Map(); // phrase -> best weight on this page
      const take = (text, w, where) => { for (const g of ngrams(text)) { if (brands.some((b) => g.includes(b))) continue; const cur = seen.get(g); if (!cur || w > cur.w) seen.set(g, { w, where }); } };
      take(p.title, 3, "title"); take(p.h1, 3, "h1");
      for (const h of p.headings || []) take(h.t, h.l === 2 ? 2 : 1, "heading");
      for (const [g, { w, where }] of seen) {
        const e = by.get(g) || { phrase: g, pages: 0, competitors: new Set(), where: new Set(), score: 0, example: p.url };
        e.pages += 1; e.competitors.add(c.name || hostOf(c.url)); e.where.add(where); e.score += w;
        by.set(g, e);
      }
    }
  }
  let list = [...by.values()].filter((e) => e.pages >= 2 || e.where.has("title") || e.where.has("h1"));
  list.sort((a, b) => b.competitors.size - a.competitors.size || b.score - a.score || b.phrase.split(" ").length - a.phrase.split(" ").length);
  const kept = [];
  for (const e of list) {
    if (kept.some((k) => k.phrase.length > e.phrase.length && ` ${k.phrase} `.includes(` ${e.phrase} `) && k.pages >= e.pages * 0.7)) continue;
    kept.push(e);
  }
  const trackedSet = new Set((tracked || []).map(normPhrase));
  const gsc = (gscQueries || []).map(normPhrase);
  return kept.slice(0, limit).map((e) => {
    const t = e.phrase.split(" ");
    return { phrase: e.phrase, pages: e.pages, competitors: [...e.competitors], where: [...e.where], score: e.score, example: e.example, youTarget: targets(ourCrawl, t), tracked: trackedSet.has(e.phrase), inGsc: gsc.some((q) => q.includes(e.phrase)) };
  });
}

/* ------------------------------------------------------------------ */
/* one list of keyword ideas                                          */
/* ------------------------------------------------------------------ */

/**
 * Merges the three sources into one deduplicated list. Each idea records every source that produced it, so an idea seen in several
 * places ranks higher. Kinds: "keyword" or "question" (people-also-ask). Seeds (the queries the suggestions came from) are not ideas.
 * input: { phrases, checks: [{ query, related }], trackedRelated: [{ query, related }], tracked, gscQueries, ourCrawl }
 */
export function mergeKeywordIdeas({ phrases = [], checks = [], trackedRelated = [], tracked = [], gscQueries = [], ourCrawl = null } = {}) {
  const trackedSet = new Set(tracked.map(normPhrase));
  const gsc = gscQueries.map(normPhrase);
  const seeds = new Set([...checks.map((c) => normPhrase(c.query)), ...trackedRelated.map((c) => normPhrase(c.query))]);
  const by = new Map();
  const add = (text, kind, source) => {
    const key = normPhrase(text);
    if (!key || key.length < 4 || (seeds.has(key) && source.type !== "competitor_pages")) return;
    const e = by.get(key) || { query: clean(text, 160), kind, sources: [], competitors: 0 };
    if (kind === "question") e.kind = "question";
    if (!e.sources.some((s) => s.type === source.type && s.detail === source.detail)) e.sources.push(source);
    if (source.competitors) e.competitors = Math.max(e.competitors, source.competitors);
    by.set(key, e);
  };
  for (const p of phrases) add(p.phrase, "keyword", { type: "competitor_pages", detail: `${p.competitors.join(", ")} (${p.pages} page${p.pages === 1 ? "" : "s"})`, competitors: p.competitors.length });
  for (const c of [...checks, ...trackedRelated]) {
    for (const s of c.related?.searches || []) add(s, "keyword", { type: "related_search", detail: c.query });
    for (const q of c.related?.questions || []) add(q, "question", { type: "people_also_ask", detail: c.query });
  }
  const out = [...by.entries()].map(([key, e]) => {
    const toks = key.split(" ");
    return { id: `ki_${key.replace(/ /g, "_").slice(0, 60)}`, ...e, tracked: trackedSet.has(key), inGsc: gsc.some((q) => q.includes(key)), youTarget: e.kind === "keyword" && toks.length >= 2 ? targets(ourCrawl, toks.filter((t) => !STOP.has(t)).length ? toks.filter((t) => !STOP.has(t)) : toks) : "n/a" };
  });
  out.sort((a, b) => b.sources.length - a.sources.length || b.competitors - a.competitors || a.query.localeCompare(b.query));
  return out;
}
