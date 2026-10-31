import test from "node:test";
import assert from "node:assert/strict";
import { proposeFixes, fixTypeOf, rowReady, rowToFix, MAX_ROWS, suggestionItem, avoidList, pagePlainText } from "../lib/fixPlanner.js";
import { validateFix } from "../lib/htmlFixes.js";

const A = "https://a.com";
const crawl = {
  startUrl: `${A}/`, truncated: false,
  pages: [
    { url: `${A}/`, title: "Acme | Home", h1Text: "Welcome to Acme", canonical: "", canonicalHrefs: [], schemaTypes: [], missingAltSrcs: ["/hero.png", "/logo.png"], noindex: false },
    { url: `${A}/about`, title: "", h1Text: "About", canonical: `${A}/about`, canonicalHrefs: [`${A}/about`], schemaTypes: [], missingAltSrcs: [], noindex: false },
    { url: `${A}/dupe`, canonicalHrefs: [`${A}/about`], noindex: false },
    { url: `${A}/hidden`, canonicalHrefs: [], noindex: true },
  ],
  siteWide: { technical: { coverage: { sitemap: { found: true, source: `${A}/sitemap.xml` } } } },
};
const issue = (o) => ({ id: "x", title: "", urls: [], evidence: [], ...o });
const site = { siteUrl: "a.com" };

test("fixTypeOf recognises supported findings and nothing else", () => {
  const t = (o) => fixTypeOf(issue(o));
  assert.equal(t({ title: "Missing page title" }), "title"); assert.equal(t({ title: "Missing meta description" }), "description"); assert.equal(t({ title: "Missing canonical tag" }), "canonical");
  assert.equal(t({ title: "3 images missing ALT text" }), "alt"); assert.equal(t({ title: "1 image missing ALT text" }), "alt"); assert.equal(t({ title: "No structured data (schema.org) found" }), "jsonld");
  assert.equal(t({ title: "Page is set to noindex" }), "noindex"); assert.equal(t({ id: "tech_home_noindex" }), "noindex"); assert.equal(t({ id: "tech_redirecting_links" }), "redirecting_links");
  assert.equal(t({ id: "tech_broken_links" }), "broken_links"); assert.equal(t({ id: "mkt_lang_missing" }), "lang"); assert.equal(t({ id: "tech_robots_missing" }), "robots"); assert.equal(t({ id: "tech_sitemap_missing" }), "sitemap");
  assert.equal(t({ title: "Duplicate page titles" }), null); assert.equal(t({ id: "tech_server_errors" }), null);
  assert.deepEqual(proposeFixes(issue({ title: "Orphan pages" }), crawl), { supported: false, rows: [], note: "This type of finding can't be fixed automatically yet." });
});

test("missing title: rows need input, prefilled from the H1 as a suggestion, expected is empty", () => {
  const p = proposeFixes(issue({ title: "Missing page title", urls: [`${A}/about`, `${A}/new`] }), crawl);
  assert.equal(p.supported, true); assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].kind, "set_title"); assert.equal(p.rows[0].value, "About"); assert.equal(p.rows[0].input.key, "value"); assert.deepEqual(p.rows[0].params, { expected: "" });
  assert.equal(p.rows[1].value, ""); assert.match(p.note, /prefilled from each page's main heading/);
  assert.equal(rowReady(p.rows[0], p.rows[0].value), true); assert.equal(rowReady(p.rows[1], ""), false); assert.equal(rowReady(p.rows[1], "   "), false);
  const fix = rowToFix(p.rows[0], "A Better Title");
  assert.deepEqual(fix, { id: p.rows[0].id, kind: "set_title", pageUrl: `${A}/about`, expected: "", value: "A Better Title" });
  assert.equal(validateFix(fix, site).ok, true); // what the planner produces passes the server's validation
});

test("canonical: self-canonical needs no input; description needs input", () => {
  const c = proposeFixes(issue({ title: "Missing canonical tag", urls: [`${A}/`] }), crawl);
  assert.equal(c.rows[0].input, null); assert.equal(rowReady(c.rows[0], undefined), true);
  assert.deepEqual(rowToFix(c.rows[0]), { id: c.rows[0].id, kind: "set_canonical", pageUrl: `${A}/`, href: `${A}/`, expected: "" });
  assert.equal(proposeFixes(issue({ title: "Missing meta description", urls: [`${A}/`] }), crawl).rows[0].input.multiline, true);
});

test("alt text: one row per image without an alt attribute; pages with none are explained", () => {
  const p = proposeFixes(issue({ title: "2 images missing ALT text", urls: [`${A}/`, `${A}/about`] }), crawl);
  assert.deepEqual(p.rows.map((r) => r.params.src), ["/hero.png", "/logo.png"]); assert.match(p.note, /\/about: no image without an alt attribute/);
  assert.equal(new Set(p.rows.map((r) => r.id)).size, 2, "row ids are unique");
  assert.equal(proposeFixes(issue({ title: "1 image missing ALT text", urls: [`${A}/about`] }), crawl).supported, false);
});

test("structured data: a valid, editable JSON-LD template (Organization on the homepage, WebPage elsewhere)", () => {
  const p = proposeFixes(issue({ title: "No structured data (schema.org) found", urls: [`${A}/`, `${A}/about`] }), crawl);
  assert.equal(JSON.parse(p.rows[0].value)["@type"], "Organization"); assert.equal(JSON.parse(p.rows[0].value).name, "Acme"); assert.equal(JSON.parse(p.rows[1].value)["@type"], "WebPage");
  assert.equal(validateFix(rowToFix(p.rows[0], p.rows[0].value), site).ok, true);
});

test("language prefill follows the market; noindex rows need no input", () => {
  assert.equal(proposeFixes(issue({ id: "mkt_lang_missing", urls: [`${A}/`] }), crawl, { country: "Germany" }).rows[0].value, "de");
  assert.equal(proposeFixes(issue({ id: "mkt_lang_missing", urls: [`${A}/`] }), crawl, { country: "Worldwide" }).rows[0].value, "en");
  const n = proposeFixes(issue({ id: "tech_noindex_pages", urls: [`${A}/hidden`] }), crawl);
  assert.equal(n.rows[0].kind, "remove_noindex"); assert.equal(rowReady(n.rows[0]), true);
});

test("redirecting links become one replace_href per (linking page, link); broken links ask for the new URL", () => {
  const evidence = [{ url: `${A}/old`, finalUrl: `${A}/new`, linkedFrom: [`${A}/`, `${A}/about`], linkedFromCount: 5 }, { url: `${A}/old2`, finalUrl: `${A}/new2`, linkedFrom: [`${A}/`], linkedFromCount: 1 }];
  const p = proposeFixes(issue({ id: "tech_redirecting_links", evidence }), crawl);
  assert.equal(p.rows.length, 3); assert.deepEqual(p.rows[0].params, { from: `${A}/old`, to: `${A}/new` }); assert.equal(p.rows[0].pageUrl, `${A}/`);
  assert.match(p.note, /linked from 5 pages; only the 2 pages recorded/);
  const b = proposeFixes(issue({ id: "tech_broken_links", evidence: [{ url: `${A}/gone`, status: 404, linkedFrom: [`${A}/`], linkedFromCount: 1 }] }), crawl);
  assert.equal(b.rows[0].input.key, "to"); assert.equal(rowReady(b.rows[0], ""), false);
  assert.equal(validateFix(rowToFix(b.rows[0], `${A}/found`), site).ok, true);
});

test("robots.txt and sitemap.xml: sitemap lists only indexable, self-canonical crawled pages", () => {
  const r = proposeFixes(issue({ id: "tech_robots_missing" }), crawl);
  assert.deepEqual(r.rows[0].params, { sitemapUrl: `${A}/sitemap.xml` }); assert.equal(r.rows[0].pageUrl, undefined);
  const s = proposeFixes(issue({ id: "tech_sitemap_missing" }), crawl);
  assert.deepEqual(s.rows[0].params.urls, [`${A}/`, `${A}/about`]); // /dupe canonicalises elsewhere, /hidden is noindex
  assert.equal(validateFix(rowToFix(s.rows[0]), site).ok, true);
  assert.equal(proposeFixes(issue({ id: "tech_sitemap_missing" }), { pages: [] }).supported, false);
});

test("rows are capped and row ids stay unique", () => {
  const urls = Array.from({ length: 55 }, (_, i) => `${A}/p${i}`);
  const p = proposeFixes(issue({ title: "Missing meta description", urls }), { pages: [] });
  assert.equal(p.rows.length, MAX_ROWS); assert.equal(p.truncated, true); assert.equal(new Set(p.rows.map((r) => r.id)).size, MAX_ROWS); assert.match(p.note, /first 40 of 55/);
});

test("too-long and duplicate titles/descriptions are fixable; expected is the current value so the file is verified against the live page", () => {
  const c = { pages: [
    { url: `${A}/a`, title: "A very long title that keeps going well past the sixty character limit for search", metaDescription: "Shared description", h1Text: "A", h2Texts: ["Sub"], fullText: "alpha beta gamma" },
    { url: `${A}/b`, title: "Shared title", metaDescription: "Shared description", h1Text: "B" }, { url: `${A}/c`, title: "Shared title", metaDescription: "x".repeat(200) },
  ] };
  assert.equal(fixTypeOf(issue({ title: "Title tag is 81 characters (recommended under 60)" })), "title_long");
  assert.equal(fixTypeOf(issue({ title: "Meta description is 200 characters (recommended under 160)" })), "description_long");
  assert.equal(fixTypeOf(issue({ id: "site_duptitle_0", title: 'Duplicate page title used on 2 pages: "Shared title"' })), "dup_titles");
  assert.equal(fixTypeOf(issue({ id: "site_dupmeta_3", title: "Duplicate meta description used on 2 pages" })), "dup_descriptions");

  const long = proposeFixes(issue({ title: "Title tag is 81 characters (recommended under 60)", urls: [`${A}/a`] }), c);
  assert.equal(long.rows[0].params.expected, c.pages[0].title); assert.equal(long.rows[0].value, c.pages[0].title); assert.equal(long.rows[0].ai, "title"); assert.match(long.rows[0].detail, /81|characters/);
  const dup = proposeFixes(issue({ id: "site_duptitle_0", title: 'Duplicate page title used on 2 pages: "Shared title"', urls: [`${A}/b`, `${A}/c`] }), c);
  assert.deepEqual(dup.rows.map((r) => r.value), ["", ""]); assert.deepEqual(dup.rows.map((r) => r.params.expected), ["Shared title", "Shared title"]); assert.equal(new Set(dup.rows.map((r) => r.id)).size, 2);
  const dd = proposeFixes(issue({ id: "site_dupmeta_0", title: "Duplicate meta description used on 2 pages", urls: [`${A}/a`, `${A}/b`] }), c);
  assert.equal(dd.rows[0].kind, "set_meta_description"); assert.equal(dd.rows[0].ai, "description"); assert.equal(dd.rows[0].params.expected, "Shared description");
  const fix = rowToFix(dup.rows[0], "A unique title for B");
  assert.equal(validateFix(fix, site).ok, true); assert.equal(fix.expected, "Shared title");
  // missing ones are AI-capable too
  assert.equal(proposeFixes(issue({ title: "Missing meta description", urls: [`${A}/b`] }), c).rows[0].ai, "description");
  assert.equal(proposeFixes(issue({ title: "Missing page title", urls: [`${A}/b`] }), c).rows[0].ai, "title");
  assert.equal(proposeFixes(issue({ title: "Missing canonical tag", urls: [`${A}/b`] }), c).rows[0].ai, undefined);
});

test("suggestion helpers: model input, avoid list and page text", () => {
  const c = { pages: [{ url: `${A}/a`, title: "T", metaDescription: "D", h1Text: "H", h2Texts: ["1", "2", "3", "4", "5", "6", "7"], fullText: "z".repeat(5000) }, { url: `${A}/b`, title: "T", metaDescription: "" }] };
  const r = proposeFixes(issue({ title: "Missing page title", urls: [`${A}/a`] }), { pages: [{ ...c.pages[0], title: "" }] }).rows[0];
  const it = suggestionItem(r, c);
  assert.equal(it.kind, "title"); assert.equal(it.url, `${A}/a`); assert.equal(it.h2Texts.length, 6); assert.equal(it.snippet.length, 1200); assert.equal(it.id, r.id);
  assert.deepEqual(avoidList(c), ["T", "D"]); assert.equal(avoidList({ pages: Array.from({ length: 100 }, (_, i) => ({ title: `t${i}` })) }, 80).length, 80);
  assert.ok(pagePlainText(r, c).length <= 3000 + 200); assert.match(pagePlainText(r, c), /^T D H 1 2/);
  assert.equal(suggestionItem(r, { pages: [] }).title, ""); // unknown page -> empty, never throws
});

test("low CTR from Search Console: title and description rows for the page, carrying the queries it ranks for", () => {
  const c = { pages: [{ url: `${A}/shoes`, title: "Shoes", metaDescription: "We sell shoes.", h1Text: "Red shoes", fullText: "red shoes for sale" }] };
  const iss = { id: "gsc_lowctr", title: "Low click-through rate", urls: [`${A}/shoes`], queries: ["red shoes", "buy shoes", 42, null] };
  assert.equal(fixTypeOf(iss), "low_ctr");
  const p = proposeFixes(iss, c);
  assert.deepEqual(p.rows.map((r) => r.kind), ["set_title", "set_meta_description"]); assert.deepEqual(p.rows.map((r) => r.ai), ["title", "description"]);
  assert.deepEqual(p.rows[0].params, { expected: "Shoes" }); assert.deepEqual(p.rows[1].params, { expected: "We sell shoes." });
  assert.deepEqual(p.rows[0].queries, ["red shoes", "buy shoes"]); assert.match(p.note, /red shoes, buy shoes/);
  assert.equal(new Set(p.rows.map((r) => r.id)).size, 2);
  const item = suggestionItem(p.rows[0], c);
  assert.deepEqual(item.queries, ["red shoes", "buy shoes"]); assert.match(pagePlainText(p.rows[0], c), /buy shoes/);
  assert.equal("queries" in suggestionItem({ ...p.rows[0], queries: [] }, c), false);
  assert.equal(validateFix(rowToFix(p.rows[0], "Red Shoes for Sale"), site).ok, true); // queries never leak into the fix sent to the API
  assert.equal("queries" in rowToFix(p.rows[0], "x"), false);
});
