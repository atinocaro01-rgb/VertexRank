// What structured data a page actually has. Pure (no HTML library), so it is unit-tested against real-world markup.
// Tests: tests/structuredData.test.mjs.
//
// This replaced a check that only read the top-level "@type" of each JSON-LD block. Most real sites (Yoast, Rank Math, Next.js,
// Shopify themes, hand-built sites) wrap their entities in {"@context": ..., "@graph": [ ... ]}, where the wrapper has no "@type" of
// its own, so every such page was reported as having NO structured data. It also missed: "@type" given as an array, full-URL types
// ("https://schema.org/Product"), Microdata (itemscope/itemtype) and RDFa (typeof), JSON-LD wrapped in comments/CDATA, and it could
// not tell "no markup" from "markup with broken JSON".
//
// What it still cannot see: structured data that is added only by JavaScript after the page loads (the crawler reads the HTML the
// server sends, as most search crawlers' first pass does).

const MAX_TYPES = 30;
const SCHEMA_PREFIX = /^(?:https?:\/\/(?:www\.)?schema\.org\/|schema:)/i;

/** "https://schema.org/FAQPage" / "schema:FAQPage" / "FAQPage" -> "FAQPage". Non-strings give "". */
export function normalizeSchemaType(t) {
  return typeof t === "string" ? t.trim().replace(SCHEMA_PREFIX, "").trim() : "";
}

/** Parses the text of one <script type="application/ld+json">, tolerating a BOM, HTML comment wrappers and CDATA wrappers. */
export function parseJsonLd(text) {
  let t = String(text ?? "").replace(/^\uFEFF/, "").trim();
  t = t.replace(/^<!--/, "").replace(/-->$/, "").trim().replace(/^\/\*\s*<!\[CDATA\[\s*\*\//, "").replace(/\/\*\s*\]\]>\s*\*\/$/, "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
  if (!t) return { ok: false, value: null };
  try { return { ok: true, value: JSON.parse(t) }; } catch { return { ok: false, value: null }; }
}

/**
 * The entity types a JSON-LD value declares: its top-level nodes and the members of any "@graph" (at any depth of wrapping), with
 * "@type" arrays flattened and schema.org prefixes removed. Types of nested sub-objects (a publisher, an address, a Question inside
 * a FAQPage) are deliberately not listed: they are details of an entity, not what the page is.
 */
export function entityTypes(value) {
  const out = [];
  const seen = new WeakSet();
  (function walk(node, depth) {
    if (!node || typeof node !== "object" || depth > 6 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    for (const t of [].concat(node["@type"] ?? [])) { const n = normalizeSchemaType(t); if (n) out.push(n); }
    if (node["@graph"]) walk(node["@graph"], depth + 1);
  })(value, 0);
  return out;
}

/** Types from Microdata `itemtype` attribute values (one or several space-separated URLs each). */
export function typesFromItemtypes(values) {
  return (Array.isArray(values) ? values : []).flatMap((v) => String(v ?? "").split(/\s+/)).filter((u) => /schema\.org\//i.test(u)).map(normalizeSchemaType).filter(Boolean);
}

/** Types from RDFa: `typeof` values, counted when prefixed "schema:" or when the element (or an ancestor) declares a schema.org vocab. */
export function typesFromRdfa(items) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const inSchemaVocab = /schema\.org/i.test(String(it?.vocab ?? ""));
    for (const tok of String(it?.typeof ?? "").split(/\s+/).filter(Boolean)) {
      if (/^schema:/i.test(tok)) out.push(normalizeSchemaType(tok));
      else if (inSchemaVocab && !tok.includes(":")) out.push(tok);
    }
  }
  return out.filter(Boolean);
}

/**
 * Everything the crawler needs from a page's structured data.
 *   jsonLdTexts: the text of each ld+json script;  itemtypes: Microdata itemtype values;  rdfa: [{ typeof, vocab }].
 * Returns { blocks, types, formats: { jsonld, jsonldInvalid, microdata, rdfa } }, where `blocks` are the parsed JSON-LD values (for
 * the market checks and FAQ extraction) and `types` the de-duplicated entity types across all three formats.
 */
export function analyzeStructuredData({ jsonLdTexts = [], itemtypes = [], rdfa = [] } = {}) {
  const blocks = [];
  let invalid = 0;
  const types = [];
  for (const text of jsonLdTexts) {
    if (!String(text ?? "").trim()) continue;
    const r = parseJsonLd(text);
    if (r.ok) { blocks.push(r.value); types.push(...entityTypes(r.value)); } else invalid++;
  }
  const micro = typesFromItemtypes(itemtypes);
  const rd = typesFromRdfa(rdfa);
  return {
    blocks,
    types: [...new Set([...types, ...micro, ...rd])].slice(0, MAX_TYPES),
    formats: { jsonld: blocks.length, jsonldInvalid: invalid, microdata: micro.length > 0, rdfa: rd.length > 0 },
  };
}
