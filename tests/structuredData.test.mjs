import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeSchemaType, parseJsonLd, entityTypes, typesFromItemtypes, typesFromRdfa, analyzeStructuredData } from "../lib/structuredData.js";
import { computeAeoSignals, computeGeoSignals } from "../lib/textIntelligence.js";
import { collectSchemaSignals } from "../lib/marketChecks.js";
import { extractFaqQuestions } from "../lib/faqSchema.js";
import { buildFixInput } from "../lib/fixContext.js";

// Real JSON-LD copied from the Subora pages that VertexRank reported as having "No structured data found".
const fx = (n) => readFileSync(new URL(`./fixtures/subora/${n}.jsonld`, import.meta.url), "utf8");

// The logic that used to be in lib/siteCrawler.js, kept here to prove the regression the fix addresses.
const oldTypes = (blocks) => [...new Set(blocks.flatMap((b) => (Array.isArray(b) ? b : [b])).map((x) => x?.["@type"]).filter(Boolean))];

test("REGRESSION: the old top-level-@type check found nothing in Subora's @graph markup; the new analysis finds every entity", () => {
  const cases = [["index", ["Organization", "WebSite"]], ["faq", ["Organization", "WebSite", "FAQPage", "BreadcrumbList"]], ["blog-post", ["Organization", "WebSite", "BlogPosting", "BreadcrumbList"]]];
  for (const [name, expected] of cases) {
    const parsed = JSON.parse(fx(name));
    assert.deepEqual(oldTypes([parsed]), [], `${name}: the old logic reported no structured data`);
    const r = analyzeStructuredData({ jsonLdTexts: [fx(name)] });
    assert.deepEqual([...r.types].sort(), [...expected].sort(), name);
    assert.deepEqual(r.formats, { jsonld: 1, jsonldInvalid: 0, microdata: false, rdfa: false });
  }
});

test("with the corrected types, the AEO and GEO signals see the FAQ and Organization schema Subora really has", () => {
  const faq = analyzeStructuredData({ jsonLdTexts: [fx("faq")] });
  assert.equal(computeAeoSignals({ schemaTypes: faq.types, fullText: "x" }).hasFaqSchema, true);
  assert.equal(computeAeoSignals({ schemaTypes: faq.types, fullText: "x" }).hasAnySchema, true);
  assert.equal(computeAeoSignals({ schemaTypes: oldTypes(faq.blocks), fullText: "x" }).hasFaqSchema, false, "what the old types produced");
  assert.equal(computeGeoSignals({ schemaTypes: faq.types, fullText: "x" }).hasOrganizationSchema, true);
  assert.equal(computeGeoSignals({ schemaTypes: [] , fullText: "x" }).hasOrganizationSchema, false);
});

test("the parsed blocks still feed the market checks and FAQ extraction (a FAQPage's questions are read from the @graph)", () => {
  const r = analyzeStructuredData({ jsonLdTexts: [fx("index"), fx("faq")] });
  assert.equal(r.blocks.length, 2);
  const sig = collectSchemaSignals(r.blocks);
  assert.equal(sig.hasLocalBusiness, false, "Subora declares an Organization, not a LocalBusiness"); assert.deepEqual(sig.addressCountries, [], "it uses areaServed, not addressCountry");
  assert.ok(extractFaqQuestions(r.blocks).length >= 3, "FAQ questions found inside the @graph");
});

test("types: arrays, full schema.org URLs and prefixes are normalized; sub-objects are not listed as page types", () => {
  assert.equal(normalizeSchemaType("https://schema.org/FAQPage"), "FAQPage"); assert.equal(normalizeSchemaType("http://www.schema.org/Product"), "Product"); assert.equal(normalizeSchemaType("schema:Article"), "Article"); assert.equal(normalizeSchemaType(" Person "), "Person"); assert.equal(normalizeSchemaType(5), "");
  assert.deepEqual(entityTypes({ "@type": ["LocalBusiness", "https://schema.org/Store"], address: { "@type": "PostalAddress" } }), ["LocalBusiness", "Store"]);
  assert.deepEqual(entityTypes([{ "@type": "Product" }, { "@graph": [{ "@type": "Organization" }, { "@type": ["WebPage", "FAQPage"], mainEntity: [{ "@type": "Question" }] }] }]), ["Product", "Organization", "WebPage", "FAQPage"]);
  assert.deepEqual(entityTypes({ "@context": "https://schema.org", "@graph": { "@type": "Organization" } }), ["Organization"]);
  assert.deepEqual(entityTypes(null), []); assert.deepEqual(entityTypes("junk"), []); assert.deepEqual(entityTypes({ "@type": null }), []);
  const cyclic = { "@type": "Thing" }; cyclic["@graph"] = [cyclic]; assert.doesNotThrow(() => entityTypes(cyclic));
});

test("parseJsonLd tolerates BOM, comment and CDATA wrappers, and reports broken JSON instead of hiding it", () => {
  const body = '{"@type":"Organization","name":"A"}';
  for (const wrapped of [body, `\uFEFF${body}`, `<!-- ${body} -->`, `/*<![CDATA[*/${body}/*]]>*/`, `<![CDATA[${body}]]>`, `\n  ${body}\n`]) assert.equal(parseJsonLd(wrapped).ok, true, wrapped.slice(0, 20));
  for (const bad of ['{"@type":"Organization",}', "{not json}", "", "   ", null]) assert.equal(parseJsonLd(bad).ok, false);
});

test("analyzeStructuredData: invalid JSON is counted (so it isn't reported as 'no markup'), valid blocks still count, empty scripts are ignored", () => {
  const r = analyzeStructuredData({ jsonLdTexts: ['{"@type":"Organization"}', '{"@type":"Product",}', "   "] });
  assert.deepEqual(r.types, ["Organization"]); assert.deepEqual(r.formats, { jsonld: 1, jsonldInvalid: 1, microdata: false, rdfa: false });
  const onlyBad = analyzeStructuredData({ jsonLdTexts: ["{oops"] }); assert.deepEqual(onlyBad.types, []); assert.equal(onlyBad.formats.jsonldInvalid, 1);
  const none = analyzeStructuredData({}); assert.deepEqual(none, { blocks: [], types: [], formats: { jsonld: 0, jsonldInvalid: 0, microdata: false, rdfa: false } });
});

test("Microdata and RDFa count as structured data too, and are merged with JSON-LD without duplicates", () => {
  assert.deepEqual(typesFromItemtypes(["https://schema.org/Product", "http://schema.org/Offer https://schema.org/AggregateOffer", "https://example.com/Other", null]), ["Product", "Offer", "AggregateOffer"]);
  assert.deepEqual(typesFromRdfa([{ typeof: "schema:Article", vocab: "" }, { typeof: "Recipe", vocab: "https://schema.org/" }, { typeof: "Recipe", vocab: "http://example.org/v#" }, { typeof: "foaf:Person", vocab: "https://schema.org/" }]), ["Article", "Recipe"]);
  const r = analyzeStructuredData({ jsonLdTexts: ['{"@type":"Product"}'], itemtypes: ["https://schema.org/Product", "https://schema.org/Review"], rdfa: [{ typeof: "schema:Organization" }] });
  assert.deepEqual([...r.types].sort(), ["Organization", "Product", "Review"]); assert.equal(r.formats.microdata, true); assert.equal(r.formats.rdfa, true);
  const microOnly = analyzeStructuredData({ itemtypes: ["https://schema.org/LocalBusiness"] }); assert.deepEqual(microOnly.types, ["LocalBusiness"]); assert.equal(microOnly.formats.jsonld, 0);
});

test("the type list is bounded", () => {
  const many = JSON.stringify({ "@graph": Array.from({ length: 80 }, (_, i) => ({ "@type": `Type${i}` })) });
  assert.equal(analyzeStructuredData({ jsonLdTexts: [many] }).types.length, 30);
});

test("generate-fix context passes the page's real schema types (it used to read a field that never existed)", () => {
  const crawl = { domain: "subora.com.ng", startUrl: "https://www.subora.com.ng/", pages: [{ url: "https://www.subora.com.ng/", title: "Subora", fullText: "x", schemaTypes: ["Organization", "WebSite"] }] };
  assert.deepEqual(buildFixInput({ title: "T" }, crawl).pages[0].schemaTypes, ["Organization", "WebSite"]);
});

test("the crawler uses the structured-data module, flags invalid JSON separately, and keeps the issue title the fix planner expects", () => {
  const src = readFileSync(new URL("../lib/siteCrawler.js", import.meta.url), "utf8");
  assert.match(src, /analyzeStructuredData\(/); assert.match(src, /itemscope\]\[itemtype\]/); assert.match(src, /\[typeof\]/); assert.match(src, /schemaFormats: sd\.formats/);
  assert.match(src, /"No structured data \(schema\.org\) found"/); assert.match(src, /"Structured data has invalid JSON"/);
  assert.ok(!/\.map\(\(x\) => x\?\.\["@type"\]\)/.test(src), "the top-level-@type-only logic is gone");
  const planner = readFileSync(new URL("../lib/fixPlanner.js", import.meta.url), "utf8");
  assert.match(planner, /No structured data\|Structured data has invalid JSON/);
});
