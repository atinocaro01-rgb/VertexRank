// Target-market reference data and helpers (no dependencies; used by the UI, the API routes and tests).
//
// The selected country does two things in VertexRank:
//   1. It is passed into every AI analysis as a short, validated "target market" instruction
//      (marketPromptBlock), so recommendations are location-aware instead of defaulting to the US.
//   2. It drives deterministic checks against the crawl (lib/marketChecks.js): page language,
//      hreflang, schema address/currency, and local-business signals.
//
// Data notes: `languages` are widely used languages in the market (not only official ones), as
// primary BCP-47 subtags; `english` is the English spelling convention most local sites use.
// This is reference data for hints and consistency checks, not legal or linguistic authority.

const P = (code, languages, currencies, tld, dial, english = null) => ({ code, languages, currencies, tld, dial, english });

export const MARKETS = {
  Algeria: P("DZ", ["ar", "fr"], ["DZD"], ".dz", "213"),
  Argentina: P("AR", ["es"], ["ARS"], ".ar", "54"),
  Australia: P("AU", ["en"], ["AUD"], ".au", "61", "en-AU"),
  Austria: P("AT", ["de"], ["EUR"], ".at", "43"),
  Bangladesh: P("BD", ["bn", "en"], ["BDT"], ".bd", "880"),
  Belgium: P("BE", ["nl", "fr", "de"], ["EUR"], ".be", "32"),
  Botswana: P("BW", ["en", "tn"], ["BWP"], ".bw", "267", "en-GB"),
  Brazil: P("BR", ["pt"], ["BRL"], ".br", "55"),
  Cameroon: P("CM", ["fr", "en"], ["XAF"], ".cm", "237"),
  Canada: P("CA", ["en", "fr"], ["CAD"], ".ca", "1", "en-CA"),
  Chile: P("CL", ["es"], ["CLP"], ".cl", "56"),
  China: P("CN", ["zh"], ["CNY"], ".cn", "86"),
  Colombia: P("CO", ["es"], ["COP"], ".co", "57"),
  "Czech Republic": P("CZ", ["cs"], ["CZK"], ".cz", "420"),
  "Côte d'Ivoire": P("CI", ["fr"], ["XOF"], ".ci", "225"),
  Denmark: P("DK", ["da"], ["DKK"], ".dk", "45"),
  Egypt: P("EG", ["ar"], ["EGP"], ".eg", "20"),
  Ethiopia: P("ET", ["am"], ["ETB"], ".et", "251"),
  Finland: P("FI", ["fi", "sv"], ["EUR"], ".fi", "358"),
  France: P("FR", ["fr"], ["EUR"], ".fr", "33"),
  Germany: P("DE", ["de"], ["EUR"], ".de", "49"),
  Ghana: P("GH", ["en"], ["GHS"], ".gh", "233", "en-GB"),
  Greece: P("GR", ["el"], ["EUR"], ".gr", "30"),
  "Hong Kong": P("HK", ["zh", "en"], ["HKD"], ".hk", "852", "en-GB"),
  Hungary: P("HU", ["hu"], ["HUF"], ".hu", "36"),
  India: P("IN", ["en", "hi"], ["INR"], ".in", "91", "en-IN"),
  Indonesia: P("ID", ["id"], ["IDR"], ".id", "62"),
  Ireland: P("IE", ["en", "ga"], ["EUR"], ".ie", "353", "en-IE"),
  Israel: P("IL", ["he", "ar"], ["ILS"], ".il", "972"),
  Italy: P("IT", ["it"], ["EUR"], ".it", "39"),
  Japan: P("JP", ["ja"], ["JPY"], ".jp", "81"),
  Jordan: P("JO", ["ar"], ["JOD"], ".jo", "962"),
  Kenya: P("KE", ["en", "sw"], ["KES"], ".ke", "254", "en-GB"),
  Malawi: P("MW", ["en", "ny"], ["MWK"], ".mw", "265", "en-GB"),
  Malaysia: P("MY", ["ms", "en"], ["MYR"], ".my", "60", "en-GB"),
  Mexico: P("MX", ["es"], ["MXN"], ".mx", "52"),
  Morocco: P("MA", ["ar", "fr"], ["MAD"], ".ma", "212"),
  Mozambique: P("MZ", ["pt"], ["MZN"], ".mz", "258"),
  Namibia: P("NA", ["en"], ["NAD"], ".na", "264", "en-GB"),
  Netherlands: P("NL", ["nl"], ["EUR"], ".nl", "31"),
  "New Zealand": P("NZ", ["en", "mi"], ["NZD"], ".nz", "64", "en-NZ"),
  Nigeria: P("NG", ["en"], ["NGN"], ".ng", "234", "en-GB"),
  Norway: P("NO", ["nb", "no", "nn"], ["NOK"], ".no", "47"),
  Pakistan: P("PK", ["ur", "en"], ["PKR"], ".pk", "92", "en-GB"),
  Peru: P("PE", ["es"], ["PEN"], ".pe", "51"),
  Philippines: P("PH", ["fil", "en"], ["PHP"], ".ph", "63", "en-US"),
  Poland: P("PL", ["pl"], ["PLN"], ".pl", "48"),
  Portugal: P("PT", ["pt"], ["EUR"], ".pt", "351"),
  Qatar: P("QA", ["ar"], ["QAR"], ".qa", "974"),
  Romania: P("RO", ["ro"], ["RON"], ".ro", "40"),
  Rwanda: P("RW", ["rw", "en", "fr"], ["RWF"], ".rw", "250", "en-GB"),
  "Saudi Arabia": P("SA", ["ar"], ["SAR"], ".sa", "966"),
  Senegal: P("SN", ["fr"], ["XOF"], ".sn", "221"),
  Singapore: P("SG", ["en", "zh", "ms", "ta"], ["SGD"], ".sg", "65", "en-GB"),
  "South Africa": P("ZA", ["en", "af", "zu"], ["ZAR"], ".za", "27", "en-GB"),
  "South Korea": P("KR", ["ko"], ["KRW"], ".kr", "82"),
  Spain: P("ES", ["es"], ["EUR"], ".es", "34"),
  "Sri Lanka": P("LK", ["si", "ta", "en"], ["LKR"], ".lk", "94", "en-GB"),
  Sweden: P("SE", ["sv"], ["SEK"], ".se", "46"),
  Switzerland: P("CH", ["de", "fr", "it"], ["CHF"], ".ch", "41"),
  Taiwan: P("TW", ["zh"], ["TWD"], ".tw", "886"),
  Tanzania: P("TZ", ["sw", "en"], ["TZS"], ".tz", "255", "en-GB"),
  Thailand: P("TH", ["th"], ["THB"], ".th", "66"),
  Tunisia: P("TN", ["ar", "fr"], ["TND"], ".tn", "216"),
  Turkey: P("TR", ["tr"], ["TRY"], ".tr", "90"),
  Uganda: P("UG", ["en", "sw"], ["UGX"], ".ug", "256", "en-GB"),
  Ukraine: P("UA", ["uk"], ["UAH"], ".ua", "380"),
  "United Arab Emirates": P("AE", ["ar", "en"], ["AED"], ".ae", "971", "en-GB"),
  "United Kingdom": P("GB", ["en"], ["GBP"], ".uk", "44", "en-GB"),
  "United States": P("US", ["en"], ["USD"], ".us", "1", "en-US"),
  Vietnam: P("VN", ["vi"], ["VND"], ".vn", "84"),
  Zambia: P("ZM", ["en"], ["ZMW"], ".zm", "260", "en-GB"),
  Zimbabwe: P("ZW", ["en", "sn", "nd"], ["USD", "ZWG", "ZWL"], ".zw", "263", "en-GB"),
};

export const WORLDWIDE = "Worldwide";
/** The country picker's options, in order. */
export const COUNTRIES = [WORLDWIDE, ...Object.keys(MARKETS)];

/** Maps any input to a known country name, or "Worldwide". Anything unrecognised becomes "Worldwide" — never echoed into a prompt. */
export function normalizeCountry(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return WORLDWIDE;
  return COUNTRIES.find((c) => c.toLowerCase() === s) || WORLDWIDE;
}

export const isWorldwide = (country) => normalizeCountry(country) === WORLDWIDE;
export const marketProfile = (country) => MARKETS[normalizeCountry(country)] || null;

const SPELLING = { "en-US": "American English", "en-GB": "British English", "en-AU": "Australian English", "en-CA": "Canadian English", "en-IN": "Indian English", "en-IE": "Irish English", "en-NZ": "New Zealand English" };

/**
 * A short instruction appended to every AI system prompt. For a specific country it asks the model to tailor
 * location-sensitive advice; for Worldwide it explicitly forbids assuming a market. The country is validated
 * against the fixed list first, so user-supplied text can never reach the prompt.
 */
export function marketPromptBlock(country) {
  const name = normalizeCountry(country);
  if (name === WORLDWIDE) {
    return "\n\nTarget market: Worldwide — there is no single target country. Do not assume any specific country, currency, spelling convention, regulation or local market.";
  }
  const p = MARKETS[name];
  const english = p.english ? ` When writing English, use ${SPELLING[p.english] || p.english} spelling and conventions.` : "";
  return (
    `\n\nTarget market: ${name}. Tailor everything that is location-sensitive to this market. ` +
    `Languages commonly used there: ${p.languages.join(", ")}. Currency: ${p.currencies.join("/")}.${english} ` +
    `Consider how people in ${name} actually search and what local directories, review sites, marketplaces, entities and citation sources matter, ` +
    `but only mention a local specific when you are confident it exists — if unsure, say so rather than guessing. ` +
    `Never assume the US market unless the target is the United States. The market changes what is RELEVANT; it never changes the facts in the crawled data you are given.`
  );
}

/* ------------------------------------------------------------------ */
/* language / hreflang matching                                       */
/* ------------------------------------------------------------------ */

const primary = (tag) => String(tag || "").trim().toLowerCase().split(/[-_]/)[0];
const region = (tag) => (String(tag || "").trim().toLowerCase().split(/[-_]/)[1] || "").toLowerCase();

/** Does a page's <html lang> fit the market's languages? "unknown" when there is no lang or no market. */
export function langFitsMarket(lang, country) {
  const p = marketProfile(country);
  if (!p || !String(lang || "").trim()) return "unknown";
  return p.languages.includes(primary(lang)) || (primary(lang) === "no" && p.languages.includes("nb")) ? "fits" : "mismatch";
}

/**
 * How an hreflang value relates to the market: "x-default" | "exact" (language and region fit) |
 * "language" (language fits, region absent or other) | "region-only" (region fits, language doesn't) | "other".
 */
export function hreflangRelation(value, country) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "x-default") return "x-default";
  const p = marketProfile(country);
  if (!p) return "other";
  const langOk = p.languages.includes(primary(v));
  const regionOk = region(v) === p.code.toLowerCase();
  if (langOk && regionOk) return "exact";
  if (regionOk) return "region-only";
  return langOk ? "language" : "other";
}

/** Is this a plausibly well-formed hreflang value (ISO language, optional script/region) or x-default? */
export function hreflangWellFormed(value) {
  const v = String(value || "").trim();
  return /^x-default$/i.test(v) || /^[a-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|\d{3}))?$/.test(v);
}

/** Do two currency / country designators refer to the same market? Accepts names or ISO codes. */
export function countryMatches(designator, country) {
  const p = marketProfile(country);
  const d = String(designator || "").trim().toLowerCase();
  if (!p || !d) return null; // can't judge
  return d === normalizeCountry(country).toLowerCase() || d === p.code.toLowerCase() || (p.code === "GB" && (d === "uk" || d === "great britain")) || (p.code === "US" && (d === "usa" || d === "united states of america"));
}
