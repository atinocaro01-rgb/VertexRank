import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMarket, collectSchemaSignals } from "../lib/marketChecks.js";

const page = (url, o = {}) => ({ url, htmlLang: "en", hreflangs: [], telLinks: [], schemaSignals: {}, ...o });
const crawl = (pages) => ({ startUrl: pages[0].url, pages });
const ids = (f) => f.map((x) => x.id);
const get = (f, id) => f.find((x) => x.id === id);

test("collectSchemaSignals walks nested JSON-LD", () => {
  const s = collectSchemaSignals([
    { "@context": "https://schema.org", "@type": "Dentist", telephone: "+254 700 000000", address: { "@type": "PostalAddress", addressCountry: "KE" } },
    { "@type": "Product", offers: { "@type": "Offer", priceCurrency: "kes" } },
    { "@graph": [{ "@type": ["Organization", "Store"], address: { addressCountry: { "@type": "Country", name: "Kenya" } } }] },
  ]);
  assert.deepEqual(s.addressCountries.sort(), ["KE", "Kenya"]); assert.deepEqual(s.currencies, ["KES"]);
  assert.deepEqual(s.telephones, ["+254 700 000000"]); assert.equal(s.hasLocalBusiness, true); assert.equal(s.hasPostalAddress, true);
  assert.deepEqual(collectSchemaSignals(null).addressCountries, []);
  const deep = { "@type": "Thing" }; let n = deep; for (let i = 0; i < 50; i++) { n.child = { x: i }; n = n.child; }
  assert.doesNotThrow(() => collectSchemaSignals(deep)); // bounded depth
});

test("Worldwide and empty crawls produce nothing", () => {
  assert.deepEqual(analyzeMarket(crawl([page("https://a.com/", { htmlLang: "de" })]), "Worldwide"), []);
  assert.deepEqual(analyzeMarket({ pages: [] }, "Kenya"), []);
  assert.deepEqual(analyzeMarket(null, "Kenya"), []);
  assert.deepEqual(analyzeMarket(crawl([page("https://a.com/")]), "Atlantis"), []); // unknown -> Worldwide
});

test("a site that fits the market with local signals has no findings", () => {
  const p = page("https://a.com/", { htmlLang: "en-KE", telLinks: ["+254 700 000000"], schemaSignals: { addressCountries: ["KE"], currencies: ["KES"], hasLocalBusiness: true, hasPostalAddress: true, telephones: ["+254700000000"] } });
  assert.deepEqual(analyzeMarket(crawl([p, page("https://a.com/b", { htmlLang: "sw" })]), "Kenya"), []);
});

test("language: mismatch severity depends on how much of the site is affected; missing lang is Low", () => {
  const mostly = analyzeMarket(crawl([page("https://a.com/", { htmlLang: "de" }), page("https://a.com/b", { htmlLang: "de" }), page("https://a.com/c", { htmlLang: "en" })]), "Kenya");
  assert.equal(get(mostly, "mkt_lang_mismatch").severity, "Medium");
  assert.match(get(mostly, "mkt_lang_mismatch").title, /2 of 3 pages/);
  const few = analyzeMarket(crawl([page("https://a.com/"), page("https://a.com/b"), page("https://a.com/c"), page("https://a.com/d", { htmlLang: "fr" })]), "Kenya");
  assert.equal(get(few, "mkt_lang_mismatch").severity, "Low");
  assert.ok(get(analyzeMarket(crawl([page("https://a.com/", { htmlLang: "" })]), "Kenya"), "mkt_lang_missing"));
  // the same pages are fine for a market where German is used
  assert.equal(get(analyzeMarket(crawl([page("https://a.com/", { htmlLang: "de" })]), "Germany"), "mkt_lang_mismatch"), undefined);
});

test("hreflang: malformed, relative, no self-reference, no x-default", () => {
  const A = "https://a.com/";
  const entries = [{ lang: "en_US", href: "https://a.com/us" }, { lang: "fr", href: "/fr/" }];
  const f = analyzeMarket(crawl([page(A, { hreflangs: entries })]), "Kenya");
  for (const id of ["mkt_hreflang_invalid", "mkt_hreflang_relative", "mkt_hreflang_no_self", "mkt_hreflang_no_default"]) assert.ok(ids(f).includes(id), id);
  const good = analyzeMarket(crawl([page(A, { hreflangs: [{ lang: "en-KE", href: A }, { lang: "x-default", href: A }] })]), "Kenya");
  assert.deepEqual(ids(good).filter((i) => i.startsWith("mkt_hreflang")), []);
});

test("hreflang that never targets the selected market is flagged; a language-level entry counts as covering it", () => {
  const A = "https://a.com/";
  const noKenya = analyzeMarket(crawl([page(A, { hreflangs: [{ lang: "en-US", href: A }, { lang: "de-DE", href: "https://a.com/de" }, { lang: "x-default", href: A }] })]), "Kenya");
  assert.ok(ids(noKenya).includes("mkt_hreflang_market_missing") === false, "en-US is a language match for Kenya (en)");
  const fr = analyzeMarket(crawl([page(A, { hreflangs: [{ lang: "de-DE", href: A }, { lang: "ja-JP", href: "https://a.com/ja" }, { lang: "x-default", href: A }] })]), "Kenya");
  assert.equal(get(fr, "mkt_hreflang_market_missing").severity, "Medium");
});

test("schema address country, currency and phone code", () => {
  const A = "https://a.com/";
  const f = analyzeMarket(crawl([page(A, { telLinks: ["+1 555 0100"], schemaSignals: { addressCountries: ["US"], currencies: ["USD"], hasPostalAddress: true, telephones: [] } })]), "Kenya");
  assert.equal(get(f, "mkt_schema_country").severity, "Medium"); assert.match(get(f, "mkt_schema_country").fix, /"KE"/);
  assert.equal(get(f, "mkt_schema_currency").severity, "Low");
  assert.match(get(f, "mkt_phone_country").title, /\+254/);
  assert.equal(get(f, "mkt_no_local_signals"), undefined); // address + phone present
  // one matching address among several is fine (multi-location business)
  const multi = analyzeMarket(crawl([page(A, { schemaSignals: { addressCountries: ["US", "Kenya"], hasPostalAddress: true } })]), "Kenya");
  assert.equal(get(multi, "mkt_schema_country"), undefined);
  // numbers without a + prefix can't be judged
  assert.equal(get(analyzeMarket(crawl([page(A, { telLinks: ["0700 000000"], schemaSignals: {} })]), "Kenya"), "mkt_phone_country"), undefined);
});

test("no local signals is an informational nudge with a purely-online caveat", () => {
  const f = get(analyzeMarket(crawl([page("https://a.com/"), page("https://a.com/b")]), "Kenya"), "mkt_no_local_signals");
  assert.equal(f.severity, "Low"); assert.match(f.fix, /purely online/); assert.match(f.why, /2 crawled pages/);
});

test("every finding has the shape the audit and queue expect", () => {
  const f = analyzeMarket(crawl([page("https://a.com/", { htmlLang: "de", hreflangs: [{ lang: "x", href: "/" }], telLinks: ["+1 1"], schemaSignals: { addressCountries: ["US"], currencies: ["USD"] } })]), "Kenya");
  assert.ok(f.length >= 5);
  for (const x of f) {
    assert.match(x.id, /^mkt_/); assert.ok(["Critical", "High", "Medium", "Low"].includes(x.severity));
    assert.ok(x.title && x.why && x.fix && x.urls.length > 0 && Array.isArray(x.evidence));
  }
});
