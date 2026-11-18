import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_TYPES, DAYS, emptyLocalSchema, cleanLocalSchema, prefillFromCrawl, buildLocalBusinessJsonLd, jsonLdScript } from "../lib/localSchema.js";
import { collectLocalSignals, runLocalChecks } from "../lib/localSeo.js";

const profile = { name: "Mwangi Plumbing Ltd", phone: "+254 700 123 456", address: "12 Kenyatta Avenue, Nairobi", offer: "plumbing services", areas: "Nairobi, Thika" };
const full = () => {
  const f = emptyLocalSchema();
  Object.assign(f, { type: "Plumber", street: "12 Kenyatta Avenue", locality: "Nairobi", region: "Nairobi County", postalCode: "00100", country: "KE", email: "hello@mwangi.co.ke", image: "https://mwangi.co.ke/shop.jpg", logo: "https://mwangi.co.ke/logo.png", priceRange: "KES 500-5,000", lat: "-1.2864", lng: "36.8172", mapUrl: "https://maps.app.goo.gl/abc", description: "Fast, honest plumbing.", sameAs: "https://www.facebook.com/mwangi\nhttps://www.instagram.com/mwangi\nnot a url" });
  for (const d of ["mon", "tue", "wed", "thu", "fri"]) f.hours[d] = { closed: false, open: "08:00", close: "17:00" };
  f.hours.sat = { closed: false, open: "09:00", close: "13:00" };
  f.hours.sun = { closed: true, open: "", close: "" };
  return f;
};

test("a complete form builds full LocalBusiness JSON-LD, with days of equal hours grouped", () => {
  const { jsonLd: ld, ready, issues } = buildLocalBusinessJsonLd(profile, full(), { siteUrl: "https://mwangi.co.ke/" });
  assert.equal(ready, true);
  assert.equal(ld["@context"], "https://schema.org"); assert.equal(ld["@type"], "Plumber"); assert.equal(ld["@id"], "https://mwangi.co.ke/#localbusiness"); assert.equal(ld.url, "https://mwangi.co.ke/");
  assert.equal(ld.name, "Mwangi Plumbing Ltd"); assert.equal(ld.telephone, "+254 700 123 456");
  assert.deepEqual(ld.address, { "@type": "PostalAddress", streetAddress: "12 Kenyatta Avenue", addressLocality: "Nairobi", addressRegion: "Nairobi County", postalCode: "00100", addressCountry: "KE" });
  assert.deepEqual(ld.geo, { "@type": "GeoCoordinates", latitude: -1.2864, longitude: 36.8172 });
  assert.deepEqual(ld.openingHoursSpecification, [
    { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "08:00", closes: "17:00" },
    { "@type": "OpeningHoursSpecification", dayOfWeek: ["Saturday"], opens: "09:00", closes: "13:00" }]);
  assert.deepEqual(ld.sameAs, ["https://www.facebook.com/mwangi", "https://www.instagram.com/mwangi"]);
  assert.deepEqual(ld.areaServed, [{ "@type": "City", name: "Nairobi" }, { "@type": "City", name: "Thika" }]);
  assert.equal(ld.hasMap, "https://maps.app.goo.gl/abc"); assert.equal(ld.priceRange, "KES 500-5,000");
  assert.ok(issues.some((i) => /1 profile link isn't/.test(i.text))); // the invalid line was dropped and said so
});

test("it never adds review or rating markup, and says why", () => {
  const { jsonLd, issues } = buildLocalBusinessJsonLd(profile, full(), { siteUrl: "https://mwangi.co.ke" });
  assert.ok(!("aggregateRating" in jsonLd) && !("review" in jsonLd));
  assert.ok(issues.some((i) => i.level === "tip" && /Review stars are deliberately not included/.test(i.text)));
});

test("empty fields are left out, not guessed; missing required details block 'ready'", () => {
  const r = buildLocalBusinessJsonLd({ name: "", phone: "", address: "12 Some Road, Town", areas: "" }, emptyLocalSchema(), { siteUrl: "" });
  assert.equal(r.ready, false);
  assert.deepEqual(Object.keys(r.jsonLd), ["@context", "@type"]);
  const errs = r.issues.filter((i) => i.level === "error").map((i) => i.text);
  assert.ok(errs.some((t) => /business name/.test(t))); assert.ok(errs.some((t) => /Fill in the address fields/.test(t)));
  assert.ok(r.issues.some((i) => /No website address/.test(i.text))); assert.ok(r.issues.some((i) => /phone number/.test(i.text)));
});

test("bad values are dropped with a message instead of producing wrong markup", () => {
  const f = full();
  Object.assign(f, { email: "nope", image: "javascript:alert(1)", logo: "ftp://x.com/l.png", lat: "95", lng: "36", mapUrl: "maps", type: "NotAType" });
  f.hours.mon = { closed: false, open: "8am", close: "17:00" };
  const { jsonLd: ld, issues } = buildLocalBusinessJsonLd({ ...profile, phone: "0700123456" }, f, { siteUrl: "not a url" });
  for (const k of ["email", "image", "logo", "geo", "hasMap", "url", "@id"]) assert.ok(!(k in ld), k);
  assert.equal(ld["@type"], "LocalBusiness"); // unknown type falls back
  assert.ok(!ld.openingHoursSpecification[0].dayOfWeek.includes("Monday"));
  const text = issues.map((i) => i.text).join(" | ");
  for (const re of [/email address doesn't look valid/, /image address must be a full https/, /logo address must be a full https/, /Latitude and longitude must both be numbers/, /Google Maps link must be a full https/, /Monday: set both/, /country code/]) assert.match(text, re);
});

test("street is required once any address part is given, and the country hint appears", () => {
  const f = emptyLocalSchema(); f.locality = "Nairobi"; f.country = "Kenya";
  const r = buildLocalBusinessJsonLd(profile, f, { siteUrl: "https://s.com" });
  assert.equal(r.ready, false); assert.ok(r.issues.some((i) => /Add the street address/.test(i.text))); assert.ok(r.issues.some((i) => /2-letter country code/.test(i.text)));
});

test("jsonLdScript wraps the data and can't be broken out of with </script>", () => {
  const f = full(); f.description = "Evil </script><script>alert(1)</script> text";
  const s = jsonLdScript(buildLocalBusinessJsonLd(profile, f, { siteUrl: "https://s.com" }).jsonLd);
  assert.match(s, /^<script type="application\/ld\+json">\n\{/); assert.match(s, /\n<\/script>$/);
  assert.equal(s.split("</script>").length, 2); assert.ok(!s.includes("<script>alert"));
  assert.deepEqual(JSON.parse(s.replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "")).description, "Evil </script><script>alert(1)</script> text");
});

test("what the generator writes is exactly what the Local SEO check recognises (round trip)", () => {
  const ld = buildLocalBusinessJsonLd(profile, full(), { siteUrl: "https://mwangi.co.ke" }).jsonLd;
  const s = collectLocalSignals([ld]);
  assert.equal(s.isLocal, true); assert.deepEqual(s.types, ["Plumber"]); assert.deepEqual(s.telephones, ["+254 700 123 456"]);
  assert.equal(s.hasHours && s.hasGeo && s.hasSameAs, true); assert.deepEqual(s.streets, ["12 Kenyatta Avenue"]);
  const crawl = { startUrl: "https://mwangi.co.ke/", pages: [{ url: "https://mwangi.co.ke/", title: "Mwangi Plumbing Ltd", h1Text: "Plumbers", fullText: "x", contactText: "Mwangi Plumbing Ltd 12 Kenyatta Avenue Nairobi +254 700 123 456", phones: ["+254 700 123 456"], telLinks: ["+254700123456"], externalLinkUrls: [], localSignals: s, schemaSignals: { hasLocalBusiness: true } }] };
  const check = runLocalChecks(crawl, profile).checks.find((c) => c.id === "schema_local");
  assert.equal(check.status, "pass");
});

test("prefillFromCrawl reads existing markup; cleanLocalSchema sanitises and keeps all seven days", () => {
  const pf = prefillFromCrawl({ startUrl: "https://s.com/", pages: [{ url: "https://s.com/", localSignals: collectLocalSignals([{ "@type": "Dentist", name: "Smile Dental", telephone: "0711", address: { "@type": "PostalAddress", streetAddress: "1 Road", addressLocality: "Thika", postalCode: "01000" } }]) }] });
  assert.equal(pf.found, true); assert.deepEqual(pf.fields, { type: "Dentist", street: "1 Road", locality: "Thika", postalCode: "01000" }); assert.equal(pf.name, "Smile Dental"); assert.equal(pf.telephone, "0711");
  assert.deepEqual(prefillFromCrawl({ pages: [{ url: "https://s.com/" }] }), { found: false, fields: {}, telephone: "", name: "" });
  const c = cleanLocalSchema({ type: "Bogus", street: "  A   B ", hours: { mon: { open: "08:00", close: "17:00", closed: 1 } } });
  assert.equal(c.type, "LocalBusiness"); assert.equal(c.street, "A B"); assert.equal(Object.keys(c.hours).length, 7); assert.equal(c.hours.mon.closed, true); assert.deepEqual(c.hours.tue, { closed: false, open: "", close: "" });
  assert.equal(DAYS.length, 7); assert.ok(SCHEMA_TYPES.length > 30 && new Set(SCHEMA_TYPES.map((t) => t[0])).size === SCHEMA_TYPES.length);
});
