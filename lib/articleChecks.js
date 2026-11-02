// A deterministic checklist for a drafted article, built from what Google publishes about on-page basics and helpful, people-first
// content. Pure; client-safe. Tests: tests/articleWriter.test.mjs.
//
// What this IS: checks a machine can actually verify (title/meta length, headings, keyword placement, stuffing, length, citations
// that point at provided sources, internal links that exist, unfilled placeholders, readability, filler). What it is NOT: a promise
// of indexing or rankings, and it cannot judge originality or accuracy — those need a person. The checklist says so.

const words = (s) => String(s || "").toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
const FILLER = [/in today'?s (fast[- ]paced|digital|modern) world/i, /\bdelve\b/i, /\bin the realm of\b/i, /\bit'?s (important|worth) to note that\b/i, /\bin conclusion\b/i, /\bunlock the (power|potential)\b/i, /\bgame[- ]chang/i, /\bnavigate the (complex|ever-changing)/i, /\bevolving landscape\b/i, /\bat the end of the day\b/i];

const strip = (md) => String(md || "").replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1").replace(/[#*_>`|-]/g, " ").replace(/\[\d+\]/g, " ");
export const countWords = (md) => words(strip(md)).length;

const item = (id, label, status, detail) => ({ id, label, status, detail });

export function checkArticle({ markdown, title, metaDescription, primaryKeyword, sources = [], internalUrls = [], wordTarget = 1200, intent = "Informational", hasFirstHand = false }) {
  const md = String(markdown || "");
  const items = [];
  const kwTokens = [...new Set(words(primaryKeyword).filter((w) => w.length > 2))];
  const hasKw = (text) => kwTokens.length === 0 || kwTokens.every((w) => words(text).includes(w));

  const tl = String(title || "").length;
  items.push(item("title", "Title length and keyword", tl >= 30 && tl <= 60 && hasKw(title) ? "pass" : tl >= 20 && tl <= 70 ? "warn" : "fail", `${tl} characters (aim for 30–60)${hasKw(title) ? "" : "; the primary keyword isn't fully in the title"}.`));
  const ml = String(metaDescription || "").length;
  items.push(item("meta", "Meta description", ml >= 120 && ml <= 160 && hasKw(metaDescription) ? "pass" : ml >= 90 && ml <= 175 ? "warn" : "fail", `${ml} characters (aim for 120–160)${hasKw(metaDescription) ? "" : "; the keyword isn't in it"}.`));

  const heads = [...md.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => ({ level: m[1].length, text: m[2] }));
  const h1 = heads.filter((h) => h.level === 1).length, h2 = heads.filter((h) => h.level === 2).length;
  const skipped = heads.some((h, i) => i > 0 && h.level > heads[i - 1].level + 1);
  items.push(item("headings", "Heading structure", h1 === 1 && h2 >= 3 && !skipped ? "pass" : h1 === 1 && h2 >= 2 ? "warn" : "fail", `${h1} H1, ${h2} H2${skipped ? ", and a heading level is skipped" : ""} (want one H1, at least three H2s, no skipped levels).`));

  const body = strip(md);
  const total = words(body).length;
  const first100 = words(body).slice(0, 100).join(" ");
  items.push(item("kw_early", "Topic stated early", hasKw(first100) ? "pass" : "warn", hasKw(first100) ? "The primary topic appears in the first 100 words." : "The primary keyword's words aren't all in the first 100 words."));

  const phrase = words(primaryKeyword).join(" ");
  const occ = phrase ? (words(body).join(" ").split(phrase).length - 1) : 0;
  const density = total ? (occ * Math.max(1, words(primaryKeyword).length) / total) * 100 : 0;
  items.push(item("stuffing", "No keyword stuffing", density <= 2.5 ? "pass" : density <= 3.5 ? "warn" : "fail", `The exact phrase makes up about ${density.toFixed(1)}% of the words (keep it natural, under about 2.5%).`));

  items.push(item("length", "Depth", total >= wordTarget * 0.85 ? "pass" : total >= wordTarget * 0.6 ? "warn" : "fail", `${total} words against a target of about ${wordTarget}. Length isn't a ranking goal; the piece should be as long as it takes to answer the need.`));

  const cited = [...new Set([...md.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])))];
  const have = new Set(sources.map((s) => s.n));
  const dangling = cited.filter((n) => !have.has(n));
  items.push(item("citations", "Claims point to real sources", dangling.length ? "fail" : cited.length >= 2 ? "pass" : cited.length === 1 ? "warn" : sources.length ? "fail" : "warn",
    dangling.length ? `Cites source ${dangling.join(", ")}, which wasn't provided.` : `${cited.length} of ${sources.length} provided source${sources.length === 1 ? "" : "s"} cited.${sources.length === 0 ? " No sources were provided, so factual claims are unsupported: add sources before publishing." : ""}`));

  const links = [...md.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
  const internal = links.filter((u) => internalUrls.includes(u));
  const invented = links.filter((u) => !internalUrls.includes(u) && !sources.some((s) => s.url === u));
  items.push(item("links", "Internal links", invented.length ? "fail" : internal.length >= 2 ? "pass" : internal.length === 1 ? "warn" : "warn", invented.length ? `Links to pages that aren't in your crawl or sources: ${invented.slice(0, 3).join(", ")}.` : `${internal.length} link${internal.length === 1 ? "" : "s"} to your own pages (aim for at least 2 relevant ones).`));

  const ph = (md.match(/\[ADD:[^\]]*\]/g) || []).length;
  items.push(item("placeholders", "Details only you can supply", ph === 0 ? "pass" : "warn", ph === 0 ? "No unfilled [ADD: …] spots." : `${ph} [ADD: …] spot${ph === 1 ? "" : "s"} to fill with real details (author, review date, first-hand examples, numbers) before publishing.`));
  items.push(item("experience", "First-hand experience and original value", hasFirstHand || ph > 0 ? (hasFirstHand ? "pass" : "warn") : "warn", hasFirstHand ? "Your first-hand input was used." : "Google's guidance rewards original information and first-hand experience. Add your own examples, data or photos; a draft built only from other pages isn't enough."));

  const sentences = body.split(/(?<=[.!?])\s+/).filter((s) => words(s).length > 2);
  const avg = sentences.length ? total / sentences.length : 0;
  items.push(item("readability", "Readable sentences", avg <= 24 ? "pass" : avg <= 30 ? "warn" : "fail", `Average sentence length is ${avg.toFixed(1)} words (aim for under about 24).`));

  const filler = FILLER.filter((re) => re.test(md)).length;
  items.push(item("filler", "No filler phrases", filler === 0 ? "pass" : "warn", filler === 0 ? "No stock filler phrases found." : `${filler} stock filler phrase${filler === 1 ? "" : "s"} found; cut them.`));

  const hasFaq = /^##\s+(frequently asked|faq)/im.test(md);
  items.push(item("faq", "Questions answered", /Informational|Commercial/.test(intent) ? (hasFaq ? "pass" : "warn") : "pass", hasFaq ? "Includes a FAQ section." : "No FAQ section (helpful for informational and commercial topics)."));

  const pass = items.filter((i) => i.status === "pass").length;
  return {
    items, pass, warn: items.filter((i) => i.status === "warn").length, fail: items.filter((i) => i.status === "fail").length, total: items.length, words: total,
    note: "These checks cover Google's published on-page basics and its helpful-content guidance. They can't judge accuracy or originality, and nothing can guarantee indexing or rankings. A person must review, fact-check and add real experience before publishing.",
  };
}

/** Article + FAQPage JSON-LD for the draft. Author and dates are placeholders on purpose: they must be real. */
export function buildArticleSchema({ title, metaDescription, siteName, url, faq = [] }) {
  const graph = [{
    "@type": "Article", headline: String(title || "").slice(0, 110), description: metaDescription || "",
    author: { "@type": "Person", name: "[ADD: author name]" }, datePublished: "[ADD: publish date, YYYY-MM-DD]", dateModified: "[ADD: last reviewed date, YYYY-MM-DD]",
    ...(siteName ? { publisher: { "@type": "Organization", name: siteName } } : {}), ...(url ? { mainEntityOfPage: url } : {}),
  }];
  const qa = faq.filter((f) => f.question && f.answer);
  if (qa.length) graph.push({ "@type": "FAQPage", mainEntity: qa.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })) });
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }, null, 2);
}
