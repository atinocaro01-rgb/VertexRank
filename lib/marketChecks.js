// Deterministic target-market checks. Pure functions: they read what the crawler recorded on each page
// (html lang, hreflang links, JSON-LD address/currency/phone signals, tel: links) and the SELECTED country,
// and report where the site and the market disagree. Nothing here asks an AI; nothing is guessed.
//
// Because this runs in the browser against saved crawl data + the current country, changing a website's
// country updates these findings instantly — no re-crawl and no stale results.
//
// Honest limits: only what is on the crawled pages can be judged. We never claim a site "serves" a market,
// and we don't flag things that are legitimately optional (e.g. a site with no hreflang isn't "wrong").

import {
  isWorldwide, marketProfile, langFitsMarket, hreflangRelation, hreflangWellFormed, countryMatches, normalizeCountry,
} from "./market.js";

const EVIDENCE_CAP = 25;
const LOCAL_TYPE = /LocalBusiness|Restaurant|Store|Dentist|Hotel|MedicalClinic|Physician|AutoRepair|BeautySalon|HealthClub|Attorney|LegalService|RealEstateAgent|FinancialService|Bakery|CafeOrCoffeeShop|BarOrPub|LodgingBusiness|Pharmacy|Hospital|School/i;

/* ------------------------------------------------------------------ */
/* JSON-LD signal extraction (used by the crawler)                    */
/* ------------------------------------------------------------------ */

/**
 * Walks parsed JSON-LD blocks and collects market-relevant signals: address countries, price currencies,
 * telephones, whether a local-business type or postal address is present. Depth- and size-bounded.
 */
export function collectSchemaSignals(blocks) {
  const out = { addressCountries: new Set(), currencies: new Set(), telephones: new Set(), hasLocalBusiness: false, hasPostalAddress: false };
  let visited = 0;
  const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" && typeof v.name === "string" ? [v.name] : []);
  function walk(node, depth) {
    if (!node || typeof node !== "object" || depth > 8 || visited++ > 5000) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    const types = [].concat(node["@type"] || []).map(String);
    if (types.some((t) => LOCAL_TYPE.test(t))) out.hasLocalBusiness = true;
    if (types.includes("PostalAddress")) out.hasPostalAddress = true;
    for (const c of strings(node.addressCountry)) out.addressCountries.add(c.trim());
    if (typeof node.priceCurrency === "string") out.currencies.add(node.priceCurrency.trim().toUpperCase());
    if (typeof node.telephone === "string" && node.telephone.trim()) out.telephones.add(node.telephone.trim());
    for (const v of Object.values(node)) if (v && typeof v === "object") walk(v, depth + 1);
  }
  walk(blocks, 0);
  return {
    addressCountries: [...out.addressCountries].filter(Boolean).slice(0, 10),
    currencies: [...out.currencies].filter(Boolean).slice(0, 10),
    telephones: [...out.telephones].slice(0, 5),
    hasLocalBusiness: out.hasLocalBusiness,
    hasPostalAddress: out.hasPostalAddress || out.addressCountries.size > 0,
  };
}

/* ------------------------------------------------------------------ */
/* the analysis                                                       */
/* ------------------------------------------------------------------ */

const plural = (n, one, many) => (n === 1 ? one : many);
const unique = (a) => [...new Set(a)];
const normUrl = (u) => { try { const x = new URL(u); x.hash = ""; return x.toString().replace(/\/$/, ""); } catch { return String(u || ""); } };
const digits = (s) => String(s || "").replace(/[^\d+]/g, "");

/**
 * Returns findings in the same shape as the technical findings: { id, category, severity, title, why, fix, urls, evidence }.
 * Empty for Worldwide, or when the crawl has no pages.
 */
export function analyzeMarket(crawl, countryRaw) {
  const country = normalizeCountry(countryRaw);
  const pages = crawl?.pages || [];
  if (isWorldwide(country) || pages.length === 0) return [];
  const profile = marketProfile(country);
  const findings = [];
  const add = (f) => {
    const urls = unique(f.urls || []).filter(Boolean);
    if (urls.length) findings.push({ ...f, urls, evidence: (f.evidence || []).slice(0, EVIDENCE_CAP) });
  };
  const langs = profile.languages.join(", ");

  /* ---- page language ---- */
  const withLang = pages.filter((p) => String(p.htmlLang || "").trim());
  const wrongLang = withLang.filter((p) => langFitsMarket(p.htmlLang, country) === "mismatch");
  if (wrongLang.length > 0) {
    const share = wrongLang.length / withLang.length;
    add({
      id: "mkt_lang_mismatch", category: "Technical", severity: share >= 0.5 ? "Medium" : "Low",
      title: `${wrongLang.length} of ${withLang.length} ${plural(withLang.length, "page declares", "pages declare")} a language not commonly used in ${country} (${unique(wrongLang.map((p) => p.htmlLang)).join(", ")})`,
      why: `Search engines use the page language to decide who sees it. ${country} searchers mostly use ${langs}, so pages declared in another language are less likely to be shown to them.`,
      fix: `If these pages are meant for ${country}, publish them in a language people there use (${langs}) and set the matching lang attribute; if they target other markets on purpose, add hreflang so each audience gets the right version.`,
      urls: wrongLang.map((p) => p.url), evidence: wrongLang.map((p) => ({ url: p.url, note: `lang="${p.htmlLang}"; common in ${country}: ${langs}` })),
    });
  }
  const noLang = pages.filter((p) => !String(p.htmlLang || "").trim());
  if (noLang.length > 0) {
    add({
      id: "mkt_lang_missing", category: "Technical", severity: "Low",
      title: `${noLang.length} ${plural(noLang.length, "page has", "pages have")} no lang attribute on the <html> tag`,
      why: "The lang attribute tells browsers, assistive technology and search engines which language the page is in — essential when targeting a specific market.",
      fix: `Add a lang attribute to <html> (for ${country}, for example lang="${profile.english ? profile.english : profile.languages[0]}" if that is the page language).`,
      urls: noLang.map((p) => p.url), evidence: noLang.map((p) => ({ url: p.url, note: "no lang attribute" })),
    });
  }

  /* ---- hreflang ---- */
  const withHreflang = pages.filter((p) => (p.hreflangs || []).length > 0);
  const invalid = []; const noSelf = []; const relative = []; const noDefault = [];
  const allValues = [];
  for (const p of withHreflang) {
    const entries = p.hreflangs;
    entries.forEach((e) => allValues.push(e.lang));
    const bad = entries.filter((e) => !hreflangWellFormed(e.lang));
    if (bad.length) invalid.push({ page: p, note: `invalid value(s): ${bad.map((e) => e.lang || "(empty)").join(", ")}` });
    const rel = entries.filter((e) => e.href && !/^https?:\/\//i.test(e.href));
    if (rel.length) relative.push({ page: p, note: `relative URL(s): ${rel.slice(0, 3).map((e) => e.href).join(", ")}` });
    const self = normUrl(p.url);
    if (!entries.some((e) => normUrl(e.href) === self)) noSelf.push({ page: p, note: "lists alternates but not itself" });
    if (entries.length >= 2 && !entries.some((e) => String(e.lang).toLowerCase() === "x-default")) noDefault.push({ page: p, note: `${entries.length} alternates, no x-default` });
  }
  const hl = (id, severity, title, why, fix, list) => add({ id, category: "Technical", severity, title, why, fix, urls: list.map((x) => x.page.url), evidence: list.map((x) => ({ url: x.page.url, note: x.note })) });
  if (invalid.length) hl("mkt_hreflang_invalid", "Medium", `${invalid.length} ${plural(invalid.length, "page has", "pages have")} malformed hreflang values`,
    "hreflang must be an ISO 639-1 language code, optionally with an ISO 3166-1 region (en, en-KE, fr-CA) or x-default. Malformed values are ignored, so the right version isn't served.",
    "Correct the values (use a hyphen, not an underscore, and a two-letter region such as en-KE).", invalid);
  if (relative.length) hl("mkt_hreflang_relative", "Medium", `${relative.length} ${plural(relative.length, "page uses", "pages use")} relative URLs in hreflang`,
    "hreflang annotations need fully-qualified URLs (https://…); relative ones are not reliably understood.", "Use absolute URLs in every hreflang link.", relative);
  if (noSelf.length) hl("mkt_hreflang_no_self", "Medium", `${noSelf.length} ${plural(noSelf.length, "page declares", "pages declare")} hreflang alternates but doesn't reference itself`,
    "Each page in a hreflang set should list itself as well as its alternates; incomplete sets can be ignored.", "Add a self-referencing hreflang entry on every page of the set.", noSelf);
  if (noDefault.length) hl("mkt_hreflang_no_default", "Low", `${noDefault.length} ${plural(noDefault.length, "page has", "pages have")} several hreflang alternates but no x-default`,
    "x-default tells search engines which version to show visitors from markets you haven't targeted.", "Add an x-default entry pointing at your fallback or language-selector page.", noDefault);

  if (withHreflang.length > 0) {
    const rel = allValues.map((v) => hreflangRelation(v, country));
    const covers = rel.some((r) => r === "exact" || r === "region-only" || r === "language");
    if (!covers) {
      add({
        id: "mkt_hreflang_market_missing", category: "Technical", severity: "Medium",
        title: `hreflang is set up, but none of it targets ${country}`,
        why: `The site declares regional versions (${unique(allValues).slice(0, 6).join(", ")}) but no entry for ${country} or for a language used there (${langs}), so searchers in ${country} may be shown another region's version.`,
        fix: `Add an alternate for ${country} (for example ${profile.languages[0]}-${profile.code}) pointing at the version meant for that market, or confirm that ${country} is intentionally served by a different version.`,
        urls: withHreflang.map((p) => p.url), evidence: withHreflang.map((p) => ({ url: p.url, note: `hreflang: ${p.hreflangs.map((e) => e.lang).join(", ")}` })),
      });
    }
  }

  /* ---- structured data: address country, currency, phone ---- */
  const sig = (p) => p.schemaSignals || {};
  const countryPages = pages.filter((p) => (sig(p).addressCountries || []).length > 0);
  if (countryPages.length > 0) {
    const anyMatch = countryPages.some((p) => sig(p).addressCountries.some((c) => countryMatches(c, country) === true));
    if (!anyMatch) {
      add({
        id: "mkt_schema_country", category: "Schema", severity: "Medium",
        title: `Structured data lists an address country that isn't ${country}`,
        why: `The schema.org address on your pages names ${unique(countryPages.flatMap((p) => sig(p).addressCountries)).join(", ")}, while this website targets ${country}. Mismatches confuse local search and AI systems about where you operate.`,
        fix: `If the business operates in ${country}, set addressCountry to "${profile.code}" in the LocalBusiness/Organization markup; if the website's target country is wrong, change it in Websites.`,
        urls: countryPages.map((p) => p.url), evidence: countryPages.map((p) => ({ url: p.url, note: `addressCountry: ${sig(p).addressCountries.join(", ")}` })),
      });
    }
  }
  const currencyPages = pages.filter((p) => (sig(p).currencies || []).length > 0);
  if (currencyPages.length > 0 && !currencyPages.some((p) => sig(p).currencies.some((c) => profile.currencies.includes(c)))) {
    add({
      id: "mkt_schema_currency", category: "Schema", severity: "Low",
      title: `Prices in structured data aren't in ${profile.currencies.join("/")}`,
      why: `Product/offer markup uses ${unique(currencyPages.flatMap((p) => sig(p).currencies)).join(", ")}. Shoppers in ${country} usually expect prices in ${profile.currencies.join("/")}, and shopping surfaces may match listings by currency.`,
      fix: `If you sell in ${country}, publish ${profile.currencies[0]} prices (or a separate market version); ignore this if charging in another currency is intentional.`,
      urls: currencyPages.map((p) => p.url), evidence: currencyPages.map((p) => ({ url: p.url, note: `priceCurrency: ${sig(p).currencies.join(", ")}` })),
    });
  }

  const phones = [];
  for (const p of pages) {
    for (const t of [...(p.telLinks || []), ...(sig(p).telephones || [])]) {
      const d = digits(t);
      if (d.startsWith("+")) phones.push({ url: p.url, number: t, ok: d.slice(1).startsWith(profile.dial) });
    }
  }
  if (phones.length > 0 && !phones.some((x) => x.ok)) {
    add({
      id: "mkt_phone_country", category: "Technical", severity: "Low",
      title: `Phone numbers on the site don't use ${country}'s country code (+${profile.dial})`,
      why: `Local search and customers in ${country} look for a local number; international-format numbers with another country code suggest the business isn't based there.`,
      fix: `Add a ${country} number in international format (+${profile.dial} …) where the business can take calls there.`,
      urls: unique(phones.map((x) => x.url)), evidence: phones.slice(0, EVIDENCE_CAP).map((x) => ({ url: x.url, note: x.number })),
    });
  }

  /* ---- local-business signals (informational) ---- */
  const hasLocalSignal = pages.some((p) => sig(p).hasLocalBusiness || sig(p).hasPostalAddress || (p.telLinks || []).length > 0);
  if (!hasLocalSignal) {
    add({
      id: "mkt_no_local_signals", category: "Schema", severity: "Low",
      title: `No local-business signals found for ${country}`,
      why: `None of the ${pages.length} crawled pages has a postal address or LocalBusiness markup, or a click-to-call phone link. If you serve customers in ${country} in person, search engines have little to connect the business to that market.`,
      fix: `If you have a physical presence in ${country}: add your address and phone number to the site and mark them up with LocalBusiness schema, and claim your Google Business Profile. Ignore this if the business is purely online.`,
      urls: [crawl.startUrl || pages[0].url], evidence: [{ url: crawl.startUrl || pages[0].url, note: `checked ${pages.length} pages` }],
    });
  }

  return findings;
}
