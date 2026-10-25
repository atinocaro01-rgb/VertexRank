// Target-country handling shared by the UI and every AI route (no React, no I/O — unit-tested in tests/country.test.mjs).
//
// A website has one "target country" (or "Worldwide" for sites with no single market). Every AI route
// receives it and puts the SAME line in its prompt, so no analysis quietly assumes the US (or any other
// market) when the user said otherwise.

export const WORLDWIDE = "Worldwide";

// "Worldwide" first (for sites with no single target country), then A–Z.
export const COUNTRIES = ["Worldwide", "Algeria", "Argentina", "Australia", "Austria", "Bangladesh", "Belgium", "Botswana", "Brazil", "Cameroon", "Canada", "Chile", "China", "Colombia", "Czech Republic", "Côte d'Ivoire", "Denmark", "Egypt", "Ethiopia", "Finland", "France", "Germany", "Ghana", "Greece", "Hong Kong", "Hungary", "India", "Indonesia", "Ireland", "Israel", "Italy", "Japan", "Jordan", "Kenya", "Malawi", "Malaysia", "Mexico", "Morocco", "Mozambique", "Namibia", "Netherlands", "New Zealand", "Nigeria", "Norway", "Pakistan", "Peru", "Philippines", "Poland", "Portugal", "Qatar", "Romania", "Rwanda", "Saudi Arabia", "Senegal", "Singapore", "South Africa", "South Korea", "Spain", "Sri Lanka", "Sweden", "Switzerland", "Taiwan", "Tanzania", "Thailand", "Tunisia", "Turkey", "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Vietnam", "Zambia", "Zimbabwe"];

const COUNTRY_SET = new Set(COUNTRIES);

/**
 * The value that is safe to put in a prompt. Anything that is not a known country (missing, blank, or an
 * arbitrary string a client made up — which would otherwise be a free-text injection point into the prompt)
 * becomes "Worldwide", i.e. "don't assume a market".
 */
export function normalizeCountry(country) {
  const c = typeof country === "string" ? country.trim() : "";
  return COUNTRY_SET.has(c) ? c : WORLDWIDE;
}

/** The one prompt line every AI route uses. */
export function countryPromptLine(country) {
  const c = normalizeCountry(country);
  return c === WORLDWIDE
    ? "Target country/market: Worldwide (no single target country — do not assume any specific country or local market)"
    : `Target country/market: ${c} (tailor spelling, currency, local directories, regulations and search behaviour to this market where relevant; do not assume any other market)`;
}
