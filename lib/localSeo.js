// Local SEO: what can be CHECKED from your own crawled pages (name/address/phone consistency, LocalBusiness schema, a Google
// Maps/Business Profile link, a page per service area) and the checklist for what can't be read automatically (Google Business
// Profile, citations, reviews), which you tick by hand. Pure and client-safe. Tests: tests/localSeo.test.mjs.
//
// Honest limits: nothing here can see your Google Business Profile, other websites' listings, or your reviews. Name/address checks
// only search the footer, <address> blocks, the start of each page's text and its structured data, so they can miss details placed
// elsewhere. The crawl must have been run after this feature was added for phone numbers and footer text to be available.

const LOCAL_TYPE = /LocalBusiness|Restaurant|Store|Dentist|Hotel|MedicalClinic|Physician|AutoRepair|BeautySalon|HealthClub|Attorney|LegalService|RealEstateAgent|FinancialService|Bakery|CafeOrCoffeeShop|BarOrPub|LodgingBusiness|Pharmacy|Hospital|School|HomeAndConstructionBusiness|Plumber|Electrician|Locksmith|MovingCompany|HairSalon|DaySpa|VeterinaryCare|AccountingService|InsuranceAgency|TravelAgency|AutoDealer|GroceryStore|ShoppingCenter/i;

const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const digitsOf = (s) => String(s || "").replace(/\D/g, "");

/** Two phone numbers are the same when their last 7-9 digits match (ignores +254, 0 prefixes, spaces and dashes). */
export function samePhone(a, b) {
  const x = digitsOf(a), y = digitsOf(b);
  const n = Math.min(9, x.length, y.length);
  return n >= 7 && x.slice(-n) === y.slice(-n);
}

/** Phone-number-like strings in text (9-15 digits). Returns up to `cap` distinct numbers, in order of appearance. */
export function extractPhones(text, cap = 8) {
  const out = [];
  for (const m of String(text || "").matchAll(/(?:\+|00)?\d[\d\s().-]{7,18}\d/g)) {
    const d = digitsOf(m[0]);
    if (d.length < 9 || d.length > 15) continue;
    if (/^(19|20)\d{2}[-/.\s]?\d{1,2}[-/.\s]?\d{1,2}$/.test(m[0].trim())) continue; // a date, not a phone
    if (!out.some((p) => samePhone(p, m[0]))) out.push(clip(m[0], 24));
    if (out.length >= cap) break;
  }
  return out;
}

/** What a page's JSON-LD says about the business (bounded walk). Used by the crawler. */
export function collectLocalSignals(blocks) {
  const out = { isLocal: false, types: new Set(), names: new Set(), telephones: new Set(), streets: new Set(), localities: new Set(), regions: new Set(), postalCodes: new Set(), hasHours: false, hasGeo: false, hasSameAs: false };
  let visited = 0;
  function walk(node, depth) {
    if (!node || typeof node !== "object" || depth > 8 || visited++ > 4000) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    const types = [].concat(node["@type"] || []).map(String);
    const local = types.some((t) => LOCAL_TYPE.test(t));
    if (local) { out.isLocal = true; types.filter((t) => LOCAL_TYPE.test(t)).forEach((t) => out.types.add(clip(t, 40))); if (typeof node.name === "string") out.names.add(clip(node.name, 120)); if (node.openingHours || node.openingHoursSpecification) out.hasHours = true; if (node.geo) out.hasGeo = true; if (node.sameAs) out.hasSameAs = true; }
    if (typeof node.telephone === "string" && node.telephone.trim()) out.telephones.add(clip(node.telephone, 30));
    if (types.includes("PostalAddress")) {
      for (const [k, set] of [["streetAddress", out.streets], ["addressLocality", out.localities], ["addressRegion", out.regions], ["postalCode", out.postalCodes]]) if (typeof node[k] === "string" && node[k].trim()) set.add(clip(node[k], 120));
    }
    for (const v of Object.values(node)) if (v && typeof v === "object") walk(v, depth + 1);
  }
  walk(blocks, 0);
  const arr = (s, n) => [...s].slice(0, n);
  return { isLocal: out.isLocal, types: arr(out.types, 4), names: arr(out.names, 3), telephones: arr(out.telephones, 4), streets: arr(out.streets, 3), localities: arr(out.localities, 3), regions: arr(out.regions, 3), postalCodes: arr(out.postalCodes, 3), hasHours: out.hasHours, hasGeo: out.hasGeo, hasSameAs: out.hasSameAs };
}

/* ------------------------------------------------------------------ */
/* text matching                                                      */
/* ------------------------------------------------------------------ */

const STOP = new Set(["the", "and", "ltd", "limited", "inc", "llc", "co", "company", "road", "rd", "street", "st", "avenue", "ave", "floor", "building", "plaza", "house", "box", "po"]);
const words = (s) => String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const sig = (s) => [...new Set(words(s).filter((w) => (w.length > 2 || /^\d+$/.test(w)) && !STOP.has(w)))].slice(0, 8);

/** True when most of `needle`'s significant words are in `haystack` (names and addresses are written many ways). */
export function mentions(haystack, needle, threshold = 0.7) {
  const need = sig(needle);
  if (!need.length) return false;
  const have = new Set(words(haystack));
  return need.filter((w) => have.has(w)).length / need.length >= threshold;
}

/* ------------------------------------------------------------------ */
/* the checks                                                         */
/* ------------------------------------------------------------------ */

export const EMPTY_PROFILE = { name: "", address: "", phone: "", offer: "", areas: "" };
export const cleanProfile = (p) => ({ name: clip(p?.name, 120), address: clip(p?.address, 240), phone: clip(p?.phone, 40), offer: clip(p?.offer, 80), areas: clip(p?.areas, 400) });
export const parseAreas = (s) => [...new Set(String(s || "").split(/[,\n;]/).map((x) => clip(x, 40)).filter(Boolean))].slice(0, 12);

const MAPS_HOST = /(^|\.)(maps\.google\.[a-z.]+|g\.page|maps\.app\.goo\.gl)$/i;
const isMapsLink = (u) => { try { const x = new URL(u); return MAPS_HOST.test(x.host) || (/(^|\.)google\.[a-z.]+$/i.test(x.host) && /^\/maps/.test(x.pathname)) || (x.host === "goo.gl" && /^\/maps/.test(x.pathname)); } catch { return false; } };
const isReviewLink = (u) => { try { const x = new URL(u); return (x.host === "g.page" && /^\/r\//.test(x.pathname)) || /writereview/i.test(x.pathname + x.search); } catch { return false; } };
const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search || "/"; } catch { return String(u || ""); } };
const CONTACT_PAGE = /contact|about|location|find[-\s]?us|visit|reach|get[-\s]?in[-\s]?touch|branches?|stores?/i;

function pageBlob(p) {
  const s = p.localSignals || {};
  return [p.contactText, p.fullText, p.title, p.h1Text, ...(s.names || []), ...(s.streets || []), ...(s.localities || []), ...(s.postalCodes || [])].filter(Boolean).join(" ");
}
function pagePhones(p) {
  return [...new Set([...(Array.isArray(p.phones) ? p.phones : []), ...(p.telLinks || []), ...(p.localSignals?.telephones || [])])];
}

const row = (id, status, title, detail, extra = {}) => ({ id, status, title, detail, ...extra });
const rec = (title, evidence, action, { priority = "Medium", urls = [], actionType = "Content Update" } = {}) => ({ title, evidence, recommendedAction: action, module: "Local SEO", source: "Crawl (observed)", actionType, priority, urls });

/**
 * Runs every automatic local check. `profile` is what the owner typed (name, address, phone, what they offer, areas they serve).
 * Returns { recrawl, needsProfile, checks: [{ id, status: pass|warn|fail|info, title, detail, rec? }], areas: [...], phones: [...] }.
 * Statuses: pass = looks right, warn = worth a look, fail = clearly missing, info = nothing to judge yet.
 */
export function runLocalChecks(crawl, profileIn) {
  const profile = cleanProfile(profileIn);
  const pages = Array.isArray(crawl?.pages) ? crawl.pages : [];
  if (!pages.length) return { recrawl: false, needsProfile: false, checks: [], areas: [], phones: [] };
  const recrawl = !pages.some((p) => Array.isArray(p.phones));
  const home = pages.find((p) => p.url === crawl.startUrl) || pages[0];
  const contact = pages.find((p) => p !== home && (CONTACT_PAGE.test(pathOf(p.url)) || CONTACT_PAGE.test(p.title || "")));
  const hasProfile = !!(profile.name || profile.address || profile.phone);
  const checks = [];

  // 1. NAP on the home page and the contact page.
  const testers = [
    ["name", "business name", profile.name, (p) => mentions(pageBlob(p), profile.name, 0.8)],
    ["address", "address", profile.address, (p) => mentions(pageBlob(p), profile.address, 0.6)],
    ["phone", "phone number", profile.phone, (p) => pagePhones(p).some((n) => samePhone(n, profile.phone)) || extractPhones(pageBlob(p)).some((n) => samePhone(n, profile.phone))],
  ];
  if (!hasProfile) checks.push(row("nap_profile", "info", "Enter your business details to check name, address and phone", "Fill in the form above. Nothing is guessed: the checks compare your pages with exactly what you type."));
  else for (const [key, label, value, test] of testers) {
    if (!value) { checks.push(row(`nap_${key}`, "info", `Add your ${label} to check it`, "Not entered yet.")); continue; }
    const onHome = test(home), onContact = contact ? test(contact) : null;
    const total = pages.filter(test).length;
    const where = `${total} of ${pages.length} crawled pages`;
    if (onHome || onContact) checks.push(row(`nap_${key}`, "pass", `Your ${label} appears on ${onHome ? "the homepage" : "the contact page"}`, `Found on ${where}.${onHome && contact && onContact === false ? " It is missing from the contact page." : ""}`));
    else checks.push(row(`nap_${key}`, "fail", `Your ${label} was not found on the homepage${contact ? " or the contact page" : ""}`, `Found on ${where}. Search engines and visitors compare these details with your Google Business Profile and directories, so show them in the same form everywhere (footer works well).`, { rec: rec(`Show your ${label} on the homepage and contact page`, `The crawl didn't find "${value}" on ${pathOf(home.url)}${contact ? ` or ${pathOf(contact.url)}` : ""}.`, `Add your ${label} exactly as written on your Google Business Profile to the site footer and the contact page.`, { priority: key === "phone" ? "High" : "Medium", urls: [home.url] }) }));
  }

  // 2. Other phone numbers on the site (possible inconsistency).
  const seen = [];
  for (const p of pages) for (const n of pagePhones(p)) {
    if (profile.phone && samePhone(n, profile.phone)) continue;
    const hit = seen.find((s) => samePhone(s.number, n));
    if (hit) { hit.pages += 1; if (hit.urls.length < 3) hit.urls.push(p.url); } else seen.push({ number: n, pages: 1, urls: [p.url] });
  }
  const others = seen.sort((a, b) => b.pages - a.pages).slice(0, 5);
  if (!recrawl && hasProfile && profile.phone) {
    if (others.length) checks.push(row("nap_other_phones", "warn", `${others.length} other phone number${others.length > 1 ? "s" : ""} found on the site`, `${others.map((o) => `${o.number} (${o.pages} page${o.pages > 1 ? "s" : ""})`).join(", ")}. Fine for a second line or department; a problem if it is an old number.`, { rec: rec("Check the other phone numbers on your site", `Besides ${profile.phone}, the crawl found ${others.map((o) => o.number).join(", ")}.`, "Decide which number is your main one. Replace any old or wrong numbers, and keep the main number identical to your Google Business Profile.", { urls: others.flatMap((o) => o.urls).slice(0, 5) }) }));
    else checks.push(row("nap_other_phones", "pass", "No conflicting phone numbers found", "Every phone number the crawl found matches the one you entered."));
  }

  // 3. Click-to-call.
  if (!recrawl) {
    const withTel = pages.filter((p) => (p.telLinks || []).length > 0).length;
    checks.push(withTel ? row("tel_link", "pass", "Click-to-call phone links are present", `tel: links found on ${withTel} page${withTel > 1 ? "s" : ""}.`) : row("tel_link", "warn", "No click-to-call (tel:) phone link found", "On a phone, a tappable number is how most local customers call you.", { rec: rec("Make your phone number tappable", "No tel: link was found on any crawled page.", `Wrap your phone number in a link like <a href="tel:${digitsOf(profile.phone) ? "+" + digitsOf(profile.phone) : "+000000000000"}">…</a> in the header, footer and contact page.`, { urls: [home.url] }) }));
  }

  // 4. LocalBusiness schema.
  const localPages = pages.filter((p) => p.localSignals?.isLocal || p.schemaSignals?.hasLocalBusiness);
  const best = localPages.find((p) => p.localSignals?.isLocal) || localPages[0];
  if (!localPages.length) checks.push(row("schema_local", "fail", "No LocalBusiness structured data found", "LocalBusiness markup states your name, address, phone and hours in a form search engines read directly.", { rec: rec("Add LocalBusiness structured data", "No crawled page has LocalBusiness (or a more specific type like Restaurant) JSON-LD.", "Add a JSON-LD block on the homepage or contact page with @type LocalBusiness (or the most specific type that fits), name, address (PostalAddress), telephone, openingHours, geo and sameAs links to your profiles. Match every detail to your Google Business Profile.", { priority: "High", urls: [home.url], actionType: "Schema Markup" }) }));
  else {
    const s = best.localSignals || {};
    const missing = [!s.streets?.length && !s.localities?.length && !best.schemaSignals?.hasPostalAddress ? "address" : "", !s.telephones?.length ? "telephone" : "", s.isLocal && !s.hasHours ? "opening hours" : "", s.isLocal && !s.hasGeo ? "geo coordinates" : "", s.isLocal && !s.hasSameAs ? "sameAs profile links" : ""].filter(Boolean);
    const onHome = localPages.includes(home);
    checks.push(row("schema_local", missing.length ? "warn" : "pass", missing.length ? `LocalBusiness markup is missing: ${missing.join(", ")}` : "LocalBusiness structured data is complete", `Found on ${localPages.length} page${localPages.length > 1 ? "s" : ""} (${(s.types || ["LocalBusiness"]).join(", ")})${onHome ? ", including the homepage" : ", but not the homepage"}. Only markup in the page HTML is checked.`, missing.length ? { rec: rec("Complete your LocalBusiness structured data", `Missing: ${missing.join(", ")} on ${pathOf(best.url)}.`, `Add the missing properties (${missing.join(", ")}) to the LocalBusiness JSON-LD, using the same details as your Google Business Profile.`, { urls: [best.url], actionType: "Schema Markup" }) } : {}));
    if (profile.name && s.names?.length && !s.names.some((n) => mentions(n, profile.name, 0.8) || mentions(profile.name, n, 0.8))) checks.push(row("schema_name", "warn", "The name in your markup differs from the one you entered", `Markup says "${s.names[0]}"; you entered "${profile.name}". Use one form everywhere.`));
    if (profile.phone && s.telephones?.length && !s.telephones.some((t) => samePhone(t, profile.phone))) checks.push(row("schema_phone", "warn", "The phone number in your markup differs from the one you entered", `Markup says ${s.telephones[0]}; you entered ${profile.phone}.`));
  }

  // 5. Link to the Google Maps / Business Profile listing, and a review link.
  const ext = pages.flatMap((p) => (p.externalLinkUrls || []).map((l) => l.url));
  const maps = [...new Set(ext.filter(isMapsLink))], reviews = [...new Set(ext.filter(isReviewLink))];
  checks.push(maps.length ? row("gbp_link", "pass", "The site links to your Google Maps / Business Profile listing", `${maps.length} link${maps.length > 1 ? "s" : ""} found (e.g. ${maps[0].slice(0, 70)}).`) : row("gbp_link", "warn", "No link to your Google Maps / Business Profile listing", "Linking to your listing from the contact page helps visitors find directions and reviews (and ties the site to the profile).", { rec: rec("Link your site to your Google Business Profile", "No link to Google Maps or g.page was found on any crawled page.", "Add a \"Find us on Google Maps\" link (use the Share link from your Business Profile) to the contact page and footer.", { urls: [(contact || home).url] }) }));
  checks.push(reviews.length ? row("review_link", "pass", "A \"leave a review\" link is on the site", `Found ${reviews.length} review link${reviews.length > 1 ? "s" : ""}.`) : row("review_link", "info", "No Google review link on the site", "Optional but useful: a direct link from your site (and receipts or emails) makes it easy for happy customers to review you."));

  return { recrawl, needsProfile: !hasProfile, checks, areas: areaReport(pages, parseAreas(profile.areas)), phones: others };
}

/** For each area you serve: does it have its own page (area in the URL, title or H1), only a mention, or nothing? */
export function areaReport(pages, areas) {
  return areas.map((area) => {
    const slug = words(area).join("-");
    const dedicated = pages.filter((p) => pathOf(p.url).toLowerCase().includes(slug) || mentions(p.title, area, 1) || mentions(p.h1Text, area, 1));
    if (dedicated.length) return { area, status: "page", urls: dedicated.slice(0, 3).map((p) => p.url), mentions: dedicated.length };
    const mentioning = pages.filter((p) => mentions(pageBlob(p), area, 1));
    return { area, status: mentioning.length ? "mention" : "none", urls: mentioning.slice(0, 3).map((p) => p.url), mentions: mentioning.length };
  });
}

const cap = (s) => String(s || "").trim().replace(/^./, (c) => c.toUpperCase());

/** A blue, unscheduled Content Planner topic for an area page. Kept on regenerate (it is yours). */
export function localIdeaFromArea(area, offer, id, websiteId) {
  const service = clip(offer, 60);
  const title = service ? `${cap(service)} in ${area}: what to know before you hire` : `Our services in ${area}`;
  return {
    id, websiteId, internalLinks: 0, status: "Idea", title: title.slice(0, 140), primaryKeyword: service ? `${service} ${area}`.toLowerCase() : `${area} `.toLowerCase().trim(), secondaryKeywords: service ? [`${service} near ${area}`.toLowerCase()] : [],
    intent: "Commercial", funnel: "Decision", pillar: "Local pages", format: "Case study", scheduledFor: "", internalLinkTargets: [],
    angle: `A page that is genuinely about ${area}: real local details only you have (areas covered, local examples or jobs, travel times, prices, local regulations, a map and your address if you have one there). Do not copy another city's page and swap the name: Google treats that as a doorway page.`,
    questions: [], outline: [], aeoRecs: "", geoRecs: "", rationale: `You serve ${area} but no page on the site is about it.`, source: "Added by you",
  };
}

/* ------------------------------------------------------------------ */
/* the checklist you tick by hand                                     */
/* ------------------------------------------------------------------ */

export const LOCAL_CHECKLIST = [
  { id: "gbp", title: "Google Business Profile", intro: "Your profile is what appears in the map pack and on Google Maps. VertexRank can't see it, so tick these off yourself.", items: [
    { id: "gbp_claim", text: "Claim and verify the profile", how: "At business.google.com. Verification is usually a postcard, call or video." },
    { id: "gbp_categories", text: "Pick the most specific primary category, plus relevant secondary ones", how: "The primary category is one of the strongest local ranking signals." },
    { id: "gbp_nap", text: "Name, address and phone are exactly the same as on your website", how: "Use the business's real name only: adding keywords to the name can get the profile suspended." },
    { id: "gbp_hours", text: "Opening hours are set, including holiday hours", how: "Wrong hours are one of the most common reasons for bad reviews." },
    { id: "gbp_services", text: "Services or products are listed with descriptions", how: "Use the words customers use." },
    { id: "gbp_photos", text: "Real photos added: logo, exterior, interior, team, work", how: "Add new ones regularly." },
    { id: "gbp_website", text: "The website link points to the best page (homepage or location page)", how: "For several branches, link each profile to its own location page." },
    { id: "gbp_posts", text: "You post updates or offers from time to time", how: "Even a monthly post shows the profile is active." },
    { id: "gbp_qa", text: "Common questions are answered in the profile", how: "Check the Q&A or add the answers in your description and services." },
  ] },
  { id: "citations", title: "Citations (listings on other sites)", intro: "A citation is your name, address and phone on another website. Consistency matters more than the number of them.", items: [
    { id: "cit_major", text: "Listed on the main map and business platforms that apply in your country", how: "For example Bing Places, Apple Business Connect and Facebook, plus the biggest local directory in your market." },
    { id: "cit_industry", text: "Listed in the directories for your industry", how: "Search \"[your industry] directory [your city]\" and use the ones real customers use." },
    { id: "cit_local", text: "Listed with local bodies (chamber of commerce, associations, local business groups)", how: "These are also good places to earn a real link." },
    { id: "cit_same", text: "The details in every listing match your website exactly", how: "Same business name, same address format, same main phone number." },
    { id: "cit_dupes", text: "Duplicate and old listings found and fixed or removed", how: "Search your phone number and old addresses; claim or request removal." },
  ] },
  { id: "reviews", title: "Reviews", intro: "Reviews influence both rankings and whether people choose you. Only genuine reviews from real customers: Google forbids fake reviews and paying or rewarding people for them.", items: [
    { id: "rev_ask", text: "You ask happy customers for a review after every job or sale", how: "Make it easy: send the direct review link by message or email, or show a QR code." },
    { id: "rev_link", text: "You have your direct Google review link and use it", how: "From your profile: \"Ask for reviews\" > copy the link." },
    { id: "rev_reply", text: "You reply to every review, good and bad, promptly and politely", how: "Replies show future customers how you treat people." },
    { id: "rev_negative", text: "Negative reviews get a calm, specific reply and an offer to fix it offline", how: "Never argue publicly, and don't ask for removal of honest reviews." },
    { id: "rev_policy", text: "Your team knows not to pay for, swap or fake reviews", how: "It risks the profile being suspended." },
  ] },
];

export const ALL_CHECKLIST_ITEMS = LOCAL_CHECKLIST.flatMap((g) => g.items.map((i) => ({ ...i, group: g.id })));

/** { done, total } for the whole checklist or one group. `state` is { [itemId]: { done: true, at: ISO } }. */
export function checklistProgress(state, groupId) {
  const items = ALL_CHECKLIST_ITEMS.filter((i) => !groupId || i.group === groupId);
  return { done: items.filter((i) => state?.[i.id]?.done).length, total: items.length };
}

export const checklistMarkdown = (state) => LOCAL_CHECKLIST.map((g) => `## ${g.title}\n${g.items.map((i) => `- [${state?.[i.id]?.done ? "x" : " "}] ${i.text}`).join("\n")}`).join("\n\n");
