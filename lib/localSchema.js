// LocalBusiness structured data (JSON-LD) generator (pure, client-safe). Tests: tests/localSchema.test.mjs.
//
// Built ONLY from what the owner typed (Local SEO details + the schema form): nothing is guessed or invented, empty fields are
// left out, and anything that would make the markup wrong or risky is flagged. Deliberately never outputs review or rating
// markup: Google does not show self-served review stars for a business's own LocalBusiness page, and fake or copied ratings
// can lead to a manual action.

import { parseAreas } from "./localSeo.js";

// Real schema.org subtypes of LocalBusiness only.
export const SCHEMA_TYPES = [
  ["LocalBusiness", "Local business (general)"], ["ProfessionalService", "Professional service"], ["HomeAndConstructionBusiness", "Home and construction"],
  ["Plumber", "Plumber"], ["Electrician", "Electrician"], ["Locksmith", "Locksmith"], ["HVACBusiness", "Heating and cooling"], ["RoofingContractor", "Roofing"], ["GeneralContractor", "General contractor"], ["MovingCompany", "Moving company"],
  ["AutomotiveBusiness", "Automotive business"], ["AutoRepair", "Auto repair"],
  ["Restaurant", "Restaurant"], ["CafeOrCoffeeShop", "Cafe or coffee shop"], ["Bakery", "Bakery"], ["Store", "Store"], ["GroceryStore", "Grocery store"],
  ["HealthAndBeautyBusiness", "Health and beauty"], ["BeautySalon", "Beauty salon"], ["HairSalon", "Hair salon"], ["DaySpa", "Day spa"], ["HealthClub", "Gym or health club"],
  ["Dentist", "Dentist"], ["MedicalClinic", "Medical clinic"], ["Physician", "Physician"], ["VeterinaryCare", "Veterinary care"],
  ["LegalService", "Legal service"], ["Attorney", "Attorney"], ["AccountingService", "Accounting service"], ["FinancialService", "Financial service"], ["InsuranceAgency", "Insurance agency"], ["RealEstateAgent", "Real estate agent"], ["TravelAgency", "Travel agency"],
  ["LodgingBusiness", "Lodging"], ["Hotel", "Hotel"], ["ChildCare", "Child care"], ["EntertainmentBusiness", "Entertainment business"],
];
const TYPE_IDS = new Set(SCHEMA_TYPES.map((t) => t[0]));

export const DAYS = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const URL_OK = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && !!x.host.includes("."); } catch { return false; } };
const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function emptyLocalSchema() {
  return { type: "LocalBusiness", street: "", locality: "", region: "", postalCode: "", country: "", email: "", logo: "", image: "", priceRange: "", lat: "", lng: "", mapUrl: "", description: "", sameAs: "", hours: Object.fromEntries(DAYS.map(([k]) => [k, { closed: false, open: "", close: "" }])) };
}

export function cleanLocalSchema(i) {
  const e = emptyLocalSchema();
  const hours = {};
  for (const [k] of DAYS) { const h = i?.hours?.[k] || {}; hours[k] = { closed: !!h.closed, open: clip(h.open, 5), close: clip(h.close, 5) }; }
  return {
    type: TYPE_IDS.has(i?.type) ? i.type : e.type, street: clip(i?.street, 160), locality: clip(i?.locality, 80), region: clip(i?.region, 80), postalCode: clip(i?.postalCode, 20), country: clip(i?.country, 60),
    email: clip(i?.email, 120), logo: clip(i?.logo, 500), image: clip(i?.image, 500), priceRange: clip(i?.priceRange, 40), lat: clip(i?.lat, 20), lng: clip(i?.lng, 20), mapUrl: clip(i?.mapUrl, 500),
    description: clip(i?.description, 500), sameAs: String(i?.sameAs ?? "").slice(0, 1500), hours,
  };
}

/** Fields found in the site's existing LocalBusiness markup (from the crawl), to save retyping. */
export function prefillFromCrawl(crawl) {
  const pages = crawl?.pages || [];
  const home = pages.find((p) => p.url === crawl?.startUrl) || pages[0];
  const src = [home, ...pages].find((p) => p?.localSignals?.isLocal);
  const s = src?.localSignals;
  if (!s) return { found: false, fields: {}, telephone: "", name: "" };
  const fields = {};
  const t = s.types?.find((x) => TYPE_IDS.has(x)); if (t) fields.type = t;
  if (s.streets?.[0]) fields.street = s.streets[0];
  if (s.localities?.[0]) fields.locality = s.localities[0];
  if (s.regions?.[0]) fields.region = s.regions[0];
  if (s.postalCodes?.[0]) fields.postalCode = s.postalCodes[0];
  return { found: true, fields, telephone: s.telephones?.[0] || "", name: s.names?.[0] || "", url: src.url };
}

const trimSlash = (u) => String(u || "").replace(/\/+$/, "");

/**
 * Builds the JSON-LD object from the owner's details. Returns { jsonLd, issues: [{ level, text }], ready }.
 * level: "error" (don't publish yet), "warn" (recommended), "tip". ready = no errors.
 */
export function buildLocalBusinessJsonLd(profile, input, { siteUrl = "" } = {}) {
  const p = { name: clip(profile?.name, 120), phone: clip(profile?.phone, 40), address: clip(profile?.address, 240), offer: clip(profile?.offer, 80), areas: profile?.areas };
  const f = cleanLocalSchema(input);
  const issues = [];
  const add = (level, text) => issues.push({ level, text });
  const ld = { "@context": "https://schema.org", "@type": f.type };

  const site = URL_OK(siteUrl) ? trimSlash(siteUrl) : "";
  if (site) { ld["@id"] = `${site}/#localbusiness`; }
  if (p.name) ld.name = p.name; else add("error", "Enter your business name in \"Your business details\" above. It is required.");
  if (site) ld.url = site + "/"; else add("warn", "No website address found for this site, so the url property is left out.");
  if (p.phone) { ld.telephone = p.phone; if (!/^\+/.test(p.phone)) add("warn", "Write the phone number with its country code (for example +254 700 000 000) so it works for everyone."); } else add("warn", "Add a phone number in \"Your business details\". Google recommends it.");
  if (f.email) { if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) ld.email = f.email; else add("warn", "The email address doesn't look valid, so it was left out."); }
  if (f.image) { if (URL_OK(f.image)) ld.image = f.image; else add("warn", "The image address must be a full https:// link, so it was left out."); } else add("tip", "Add a photo link (a real photo of your business). Google recommends at least one image.");
  if (f.logo) { if (URL_OK(f.logo)) ld.logo = f.logo; else add("warn", "The logo address must be a full https:// link, so it was left out."); }
  if (f.description) ld.description = f.description;
  if (f.priceRange) ld.priceRange = f.priceRange;

  // address
  const hasParts = f.street || f.locality || f.region || f.postalCode || f.country;
  if (hasParts) {
    const a = { "@type": "PostalAddress" };
    if (f.street) a.streetAddress = f.street; if (f.locality) a.addressLocality = f.locality; if (f.region) a.addressRegion = f.region; if (f.postalCode) a.postalCode = f.postalCode; if (f.country) a.addressCountry = f.country;
    ld.address = a;
    if (!f.street) add("error", "Add the street address. Google requires a full address for local business markup.");
    if (!f.locality) add("warn", "Add the city or town.");
    if (f.country && f.country.length !== 2) add("tip", "Use the 2-letter country code (for example KE, GB, US) in the country field.");
    if (!f.country) add("tip", "Add the 2-letter country code (for example KE, GB, US).");
  } else add("error", p.address ? "Fill in the address fields below (street, city, and so on). Your single address line can't be used as is." : "Add your address. Google requires it.");

  // geo
  if (f.lat || f.lng) {
    const lat = Number(f.lat), lng = Number(f.lng);
    if (f.lat !== "" && f.lng !== "" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) ld.geo = { "@type": "GeoCoordinates", latitude: lat, longitude: lng };
    else add("warn", "Latitude and longitude must both be numbers (latitude -90 to 90, longitude -180 to 180), so the location pin was left out.");
  } else add("tip", "Optional: add latitude and longitude (right-click your location in Google Maps and copy the numbers).");

  // opening hours: days with identical hours are grouped
  const groups = new Map();
  for (const [k, name] of DAYS) {
    const h = f.hours[k];
    if (h.closed || (!h.open && !h.close)) continue;
    if (!TIME.test(h.open) || !TIME.test(h.close)) { add("warn", `${name}: set both an opening and a closing time (24-hour, like 08:00 and 17:00). It was left out.`); continue; }
    const key = `${h.open}-${h.close}`;
    if (!groups.has(key)) groups.set(key, { days: [], opens: h.open, closes: h.close });
    groups.get(key).days.push(name);
  }
  if (groups.size) ld.openingHoursSpecification = [...groups.values()].map((g) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: g.days, opens: g.opens, closes: g.closes }));
  else add("warn", "Add your opening hours. Days left blank or marked closed are treated as closed.");

  // map + profiles
  if (f.mapUrl) { if (URL_OK(f.mapUrl)) ld.hasMap = f.mapUrl; else add("warn", "The Google Maps link must be a full https:// link, so it was left out."); }
  const lines = f.sameAs.split(/\n|,/).map((l) => l.trim()).filter(Boolean);
  const good = [...new Set(lines.filter(URL_OK))].slice(0, 10);
  if (lines.length > good.length) add("warn", `${lines.length - good.length} profile link${lines.length - good.length === 1 ? " isn't" : "s aren't"} a full https:// address and ${lines.length - good.length === 1 ? "was" : "were"} left out.`);
  if (good.length) ld.sameAs = good; else add("tip", "Add links to your real profiles (Facebook, Instagram, LinkedIn, Google Business Profile) so search engines connect them to this business.");

  const areas = parseAreas(p.areas);
  if (areas.length) ld.areaServed = areas.map((name) => ({ "@type": "City", name }));

  add("tip", "Review stars are deliberately not included. Google doesn't show self-published ratings for a business's own page, and fake or copied ratings can lead to a penalty.");
  return { jsonLd: ld, issues, ready: !issues.some((i) => i.level === "error") };
}

/** The <script> block to paste into the page's HTML. "<" is escaped so the data can never close the tag early. */
export function jsonLdScript(ld) {
  return `<script type="application/ld+json">\n${JSON.stringify(ld, null, 2).replace(/</g, "\\u003c")}\n</script>`;
}
