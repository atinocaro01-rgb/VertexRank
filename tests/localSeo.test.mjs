import test from "node:test";
import assert from "node:assert/strict";
import { samePhone, extractPhones, collectLocalSignals, mentions, runLocalChecks, areaReport, localIdeaFromArea, parseAreas, cleanProfile, LOCAL_CHECKLIST, ALL_CHECKLIST_ITEMS, checklistProgress, checklistMarkdown } from "../lib/localSeo.js";
import { isMarked } from "../lib/contentIdeas.js";

test("samePhone ignores formatting, country code and trunk zero", () => {
  assert.equal(samePhone("+254 700 123 456", "0700123456"), true);
  assert.equal(samePhone("(020) 123-4567", "+254201234567"), true);
  assert.equal(samePhone("0700 123 456", "0700 123 457"), false);
  assert.equal(samePhone("123", "123"), false); // too short to mean anything
});

test("extractPhones finds numbers, skips dates and duplicates", () => {
  assert.deepEqual(extractPhones("Call +254 700 123 456 or 0700-123-456. Updated 2026-11-17. Also 020 444 5555."), ["+254 700 123 456", "020 444 5555"]);
  assert.deepEqual(extractPhones("order 12345"), []);
  assert.deepEqual(extractPhones(""), []);
});

test("collectLocalSignals reads the business, address, phone, hours, geo and sameAs from JSON-LD", () => {
  const s = collectLocalSignals([{ "@context": "https://schema.org", "@type": "Plumber", name: "Mwangi Plumbing", telephone: "+254700123456", openingHours: "Mo-Fr 08:00-17:00", geo: { "@type": "GeoCoordinates", latitude: 1, longitude: 2 }, sameAs: ["https://facebook.com/x"], address: { "@type": "PostalAddress", streetAddress: "12 Kenyatta Ave", addressLocality: "Nairobi", postalCode: "00100" } }]);
  assert.equal(s.isLocal, true); assert.deepEqual(s.types, ["Plumber"]); assert.deepEqual(s.names, ["Mwangi Plumbing"]);
  assert.deepEqual(s.telephones, ["+254700123456"]); assert.deepEqual(s.streets, ["12 Kenyatta Ave"]); assert.deepEqual(s.localities, ["Nairobi"]);
  assert.equal(s.hasHours && s.hasGeo && s.hasSameAs, true);
  const none = collectLocalSignals([{ "@type": "Article", name: "x" }]);
  assert.equal(none.isLocal, false); assert.equal(collectLocalSignals(null).isLocal, false);
});

test("mentions matches most significant words, ignoring filler", () => {
  assert.equal(mentions("Visit us at 12 Kenyatta Avenue, Nairobi", "12 Kenyatta Ave, Nairobi", 0.6), true);
  assert.equal(mentions("Mwangi Plumbing Limited", "Mwangi Plumbing Ltd", 0.8), true);
  assert.equal(mentions("Something else entirely", "Mwangi Plumbing Ltd", 0.8), false);
  assert.equal(mentions("anything", "the and"), false);
});

const profile = { name: "Mwangi Plumbing Ltd", address: "12 Kenyatta Avenue, Nairobi", phone: "+254 700 123 456", offer: "plumbing services", areas: "Nairobi, Thika, Kiambu" };
const home = { url: "https://m.co.ke/", title: "Mwangi Plumbing Ltd | Nairobi plumbers", h1Text: "Plumbers in Nairobi", fullText: "Fast repairs.", contactText: "Mwangi Plumbing Ltd | 12 Kenyatta Avenue, Nairobi | Call 0700 123 456", phones: ["0700 123 456", "0711 999 888"], telLinks: ["+254700123456"], externalLinkUrls: [{ url: "https://maps.app.goo.gl/abc" }, { url: "https://g.page/r/xyz/review" }], localSignals: collectLocalSignals([{ "@type": "Plumber", name: "Mwangi Plumbing Ltd", telephone: "0700123456", address: { "@type": "PostalAddress", streetAddress: "12 Kenyatta Avenue" } }]), schemaSignals: { hasLocalBusiness: true } };
const thika = { url: "https://m.co.ke/plumber-in-thika", title: "Plumber in Thika", h1Text: "Plumber in Thika", fullText: "We serve Thika.", contactText: "", phones: ["0711 999 888"], telLinks: [], externalLinkUrls: [] };
const kiambu = { url: "https://m.co.ke/blog/pipes", title: "Pipe care tips", h1Text: "Pipe care", fullText: "Our team travels to Kiambu on Fridays.", contactText: "", phones: [], telLinks: [], externalLinkUrls: [] };
const crawl = { startUrl: "https://m.co.ke/", pages: [home, thika, kiambu] };
const by = (r, id) => r.checks.find((c) => c.id === id);

test("runLocalChecks: a healthy home page passes NAP, schema, tel link and maps link; flags the second phone number", () => {
  const r = runLocalChecks(crawl, profile);
  assert.equal(r.recrawl, false);
  for (const id of ["nap_name", "nap_address", "nap_phone", "tel_link", "gbp_link", "review_link"]) assert.equal(by(r, id).status, "pass", id);
  assert.equal(by(r, "schema_local").status, "warn"); assert.match(by(r, "schema_local").title, /opening hours/); assert.ok(by(r, "schema_local").rec);
  assert.equal(by(r, "nap_other_phones").status, "warn"); assert.deepEqual(r.phones.map((p) => p.number), ["0711 999 888"]); assert.equal(r.phones[0].pages, 2);
});

test("runLocalChecks: wrong details fail with a fix; no schema is a High-priority fail", () => {
  const r = runLocalChecks({ startUrl: "https://x.com/", pages: [{ url: "https://x.com/", title: "Home", h1Text: "Hi", fullText: "Welcome", contactText: "", phones: [], telLinks: [], externalLinkUrls: [] }] }, profile);
  assert.equal(by(r, "nap_phone").status, "fail"); assert.equal(by(r, "nap_phone").rec.priority, "High");
  assert.equal(by(r, "schema_local").status, "fail"); assert.equal(by(r, "schema_local").rec.actionType, "Schema Markup");
  assert.equal(by(r, "gbp_link").status, "warn"); assert.equal(by(r, "tel_link").status, "warn");
});

test("runLocalChecks: schema that disagrees with what you typed is flagged; no details entered gives guidance not verdicts; old crawls are marked for re-crawl", () => {
  const wrong = { ...home, localSignals: collectLocalSignals([{ "@type": "Plumber", name: "Other Name Co", telephone: "0799000000", openingHours: "x", geo: {}, sameAs: ["y"], address: { "@type": "PostalAddress", streetAddress: "1 St" } }]) };
  const r = runLocalChecks({ startUrl: home.url, pages: [wrong] }, profile);
  assert.equal(by(r, "schema_name").status, "warn"); assert.equal(by(r, "schema_phone").status, "warn");
  const blank = runLocalChecks(crawl, {});
  assert.equal(blank.needsProfile, true); assert.equal(by(blank, "nap_profile").status, "info"); assert.ok(!blank.checks.some((c) => c.id === "nap_phone"));
  const old = runLocalChecks({ startUrl: "https://o.com/", pages: [{ url: "https://o.com/", title: "Old", fullText: "x" }] }, profile);
  assert.equal(old.recrawl, true); assert.equal(old.checks.some((c) => c.id === "tel_link" || c.id === "nap_other_phones"), false);
  assert.deepEqual(runLocalChecks(null, profile), { recrawl: false, needsProfile: false, checks: [], areas: [], phones: [] });
});

test("areaReport: dedicated page, mention only, or nothing; and the planned page is a user-owned blue idea", () => {
  const r = areaReport(crawl.pages, parseAreas(profile.areas));
  assert.deepEqual(r.map((a) => [a.area, a.status]), [["Nairobi", "page"], ["Thika", "page"], ["Kiambu", "mention"]]);
  assert.deepEqual(areaReport(crawl.pages, ["Mombasa"])[0].status, "none");
  const idea = localIdeaFromArea("Kiambu", "plumbing services", "ci_1", "w1");
  assert.equal(idea.status, "Idea"); assert.equal(idea.primaryKeyword, "plumbing services kiambu"); assert.match(idea.title, /Plumbing services in Kiambu/); assert.equal(isMarked(idea), true);
  assert.match(localIdeaFromArea("Kiambu", "", "ci_2", "w1").title, /Our services in Kiambu/);
});

test("profile cleaning and area parsing", () => {
  assert.deepEqual(parseAreas("Nairobi, Thika;\nKiambu, nairobi ,,"), ["Nairobi", "Thika", "Kiambu", "nairobi"]);
  assert.equal(cleanProfile({ name: "  A   B  ", phone: 5 }).name, "A B"); assert.equal(cleanProfile(null).areas, "");
});

test("the hand-ticked checklist has unique ids, three groups and counts progress", () => {
  assert.equal(LOCAL_CHECKLIST.length, 3);
  assert.equal(new Set(ALL_CHECKLIST_ITEMS.map((i) => i.id)).size, ALL_CHECKLIST_ITEMS.length);
  assert.ok(ALL_CHECKLIST_ITEMS.every((i) => i.text && i.how));
  const state = { gbp_claim: { done: true }, gbp_hours: { done: true }, rev_ask: { done: false }, cit_dupes: { done: true } };
  assert.equal(checklistProgress(state, "gbp").done, 2); assert.equal(checklistProgress(state).done, 3); assert.equal(checklistProgress({}).done, 0);
  assert.match(checklistMarkdown(state), /- \[x\] Claim and verify the profile/);
  assert.match(checklistMarkdown(state), /- \[ \] You ask happy customers/);
});
