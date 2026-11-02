// Pulling questions out of a page: FAQPage structured data (the most reliable source), question-style headings, and question
// sentences. Pure (no HTML library), so it is unit-testable; the crawler and the competitor tools both use it.
// Tests: tests/competitorIntel.test.mjs.
//
// Questions are short, generic and factual labels, so they are kept EXACTLY as the site wrote them (that is the point: they show what
// real readers ask). Answers are never extracted or reused anywhere in VertexRank.

const QUESTION_START = /^(who|what|when|where|why|how|can|could|do|does|did|is|are|was|were|should|will|would|which|may|am)\b/i;
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Does this text read as a question a person would ask? (ends with "?", or starts with a question word and is sentence-sized) */
export function isQuestionText(text, { strict = false } = {}) {
  const t = clean(text);
  if (t.length < 12 || t.length > 160) return false;
  if (t.endsWith("?")) return !strict || QUESTION_START.test(t);
  return !strict && QUESTION_START.test(t) && t.split(" ").length >= 4 && !/[.!]$/.test(t);
}

function walk(node, out, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) { for (const n of node) walk(n, out, depth + 1); return; }
  if (typeof node !== "object") return;
  const types = [].concat(node["@type"] || []).map(String);
  if (types.includes("Question") && typeof node.name === "string") out.push(clean(node.name));
  for (const k of ["@graph", "mainEntity", "hasPart", "itemListElement", "item"]) if (node[k]) walk(node[k], out, depth + 1);
}

/** The question text of every Question in the page's JSON-LD blocks (FAQPage, QAPage, nested @graph), in order, de-duplicated. */
export function extractFaqQuestions(jsonLdBlocks) {
  const out = [];
  walk(jsonLdBlocks, out);
  return [...new Set(out.filter((q) => q.length >= 8 && q.length <= 200))].slice(0, 40);
}
