// Turns an audit finding into concrete, editable fix rows for the pull-request flow, using what the crawler recorded.
// Pure (no network, no React): unit-tested in tests/fixPlanner.test.mjs. The rows carry `expected` — what the crawler saw —
// which the server compares against the repository file before editing anything (see lib/htmlFixes.js).
//
// A row is either READY (nothing to type: self-canonical, remove noindex, redirect target) or NEEDS INPUT (a title, an
// alt text, a replacement URL): `input` describes the field and `value` is the prefill. Prefills are suggestions only;
// the person edits them before previewing.

import { marketProfile } from "./market.js";
import { classifyCanonical } from "./technicalChecks.js";

export const MAX_ROWS = 40;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search || "/"; } catch { return String(u); } };
const originOf = (u) => { try { return new URL(u).origin; } catch { return ""; } };
const pageFor = (crawl, url) => (crawl?.pages || []).find((p) => p.url === url || p.finalUrl === url) || null;

const INPUTS = {
  title: { key: "value", label: "New page title", placeholder: "A unique, descriptive title (about 50–60 characters)" },
  description: { key: "value", label: "New meta description", placeholder: "A helpful summary of the page (about 140–160 characters)", multiline: true },
  alt: { key: "alt", label: "Alt text", placeholder: "Describe what the image shows" },
  lang: { key: "value", label: "Language code", placeholder: "en, en-KE, fr…" },
  json: { key: "json", label: "Structured data (JSON-LD)", placeholder: '{"@context":"https://schema.org", …}', multiline: true },
  to: { key: "to", label: "Replacement URL", placeholder: "https://…" },
};

function row(kind, pageUrl, label, detail, { input = null, params = {}, value = "" } = {}) {
  return { id: `${kind}:${slug(pageUrl || "site")}:${slug(label + JSON.stringify(params)).slice(0, 24)}`.slice(0, 80), kind, ...(pageUrl ? { pageUrl } : {}), label, detail, input, params, value };
}

/** Which kind of finding is this? Returns a short code, or null when there is no automatic fix. */
export function fixTypeOf(issue) {
  const id = String(issue?.id || "");
  const title = String(issue?.title || "");
  if (id === "tech_home_noindex" || id === "tech_noindex_pages" || /^Page is set to noindex$/i.test(title)) return "noindex";
  if (id === "tech_redirecting_links") return "redirecting_links";
  if (id === "tech_broken_links") return "broken_links";
  if (id === "tech_robots_missing") return "robots";
  if (id === "tech_sitemap_missing") return "sitemap";
  if (id === "mkt_lang_missing") return "lang";
  if (/^Missing page title$/i.test(title)) return "title";
  if (/^Missing meta description$/i.test(title)) return "description";
  if (/^Missing canonical tag$/i.test(title)) return "canonical";
  if (/images? missing ALT text$/i.test(title)) return "alt";
  if (/^No structured data/i.test(title)) return "jsonld";
  return null;
}

/**
 * { supported, rows, note?, truncated } for an audit finding. `supported:false` means "nothing to automate here yet".
 */
export function proposeFixes(issue, crawl, { country } = {}) {
  const type = fixTypeOf(issue);
  if (!type) return { supported: false, rows: [], note: "This type of finding can't be fixed automatically yet." };
  const urls = (issue.urls || []).filter((u) => typeof u === "string");
  const rows = [];
  const notes = [];

  if (type === "title") {
    for (const url of urls) {
      const p = pageFor(crawl, url);
      rows.push(row("set_title", url, `Add a title to ${pathOf(url)}`, "The crawler found no <title>.", {
        input: INPUTS.title, params: { expected: "" }, value: String(p?.h1Text || "").trim().slice(0, 60),
      }));
    }
    if (rows.some((r) => r.value)) notes.push("Titles are prefilled from each page's main heading. Edit them before previewing.");
  } else if (type === "description") {
    for (const url of urls) rows.push(row("set_meta_description", url, `Add a meta description to ${pathOf(url)}`, "The crawler found no meta description.", { input: INPUTS.description, params: { expected: "" } }));
  } else if (type === "canonical") {
    for (const url of urls) {
      const p = pageFor(crawl, url);
      const self = p?.finalUrl || p?.url || url;
      rows.push(row("set_canonical", url, `Add a self-referencing canonical to ${pathOf(url)}`, `Sets the canonical to ${self}.`, { params: { href: self, expected: String(p?.canonical || "") } }));
    }
  } else if (type === "noindex") {
    for (const url of urls) rows.push(row("remove_noindex", url, `Remove noindex from ${pathOf(url)}`, "Removes the noindex directive from the page's meta robots tag. Only do this for pages meant to rank."));
  } else if (type === "lang") {
    const profile = marketProfile(country);
    for (const url of urls) rows.push(row("set_lang", url, `Set the language on ${pathOf(url)}`, "The <html> tag has no lang attribute.", { input: INPUTS.lang, params: { expected: "" }, value: profile ? profile.languages[0] : "en" }));
  } else if (type === "alt") {
    for (const url of urls) {
      const p = pageFor(crawl, url);
      const srcs = (p?.missingAltSrcs || []).slice(0, 5);
      if (!srcs.length) { notes.push(`${pathOf(url)}: no image without an alt attribute was recorded (images marked alt="" are decorative and are left alone).`); continue; }
      for (const src of srcs) rows.push(row("add_image_alt", url, `Alt text for ${src.split("/").pop() || src} on ${pathOf(url)}`, `<img src="${src}"> has no alt attribute.`, { input: INPUTS.alt, params: { src } }));
    }
  } else if (type === "jsonld") {
    for (const url of urls) {
      const p = pageFor(crawl, url);
      const isHome = pathOf(url) === "/";
      const template = isHome
        ? { "@context": "https://schema.org", "@type": "Organization", name: String(p?.title || "").split(/[|–-]/)[0].trim(), url: originOf(url) }
        : { "@context": "https://schema.org", "@type": "WebPage", name: String(p?.title || ""), url };
      rows.push(row("add_jsonld", url, `Add structured data to ${pathOf(url)}`, "The crawler found no schema.org markup. Edit the template so it describes the page accurately.", {
        input: INPUTS.json, params: { expectedTypes: p?.schemaTypes || [] }, value: JSON.stringify(template, null, 2),
      }));
    }
  } else if (type === "redirecting_links") {
    for (const e of issue.evidence || []) {
      if (!e?.url || !e?.finalUrl) continue;
      for (const page of e.linkedFrom || []) rows.push(row("replace_href", page, `${pathOf(page)}: link to ${pathOf(e.url)} → ${pathOf(e.finalUrl)}`, `Points the link straight at its final URL (${e.finalUrl}).`, { params: { from: e.url, to: e.finalUrl } }));
      if ((e.linkedFromCount || 0) > (e.linkedFrom || []).length) notes.push(`${e.url} is linked from ${e.linkedFromCount} pages; only the ${(e.linkedFrom || []).length} pages recorded are included.`);
    }
  } else if (type === "broken_links") {
    for (const e of issue.evidence || []) {
      if (!e?.url) continue;
      for (const page of e.linkedFrom || []) rows.push(row("replace_href", page, `${pathOf(page)}: broken link to ${pathOf(e.url)}`, `${e.url} returns ${e.status || "an error"}. Enter the URL it should point to.`, { input: INPUTS.to, params: { from: e.url } }));
      if ((e.linkedFromCount || 0) > (e.linkedFrom || []).length) notes.push(`${e.url} is linked from ${e.linkedFromCount} pages; only the ${(e.linkedFrom || []).length} pages recorded are included.`);
    }
  } else if (type === "robots") {
    const sm = crawl?.siteWide?.technical?.coverage?.sitemap;
    rows.push(row("create_robots_txt", null, "Create robots.txt", "Creates a robots.txt that allows all crawlers" + (sm?.found && sm.source ? " and points to your sitemap." : "."), { params: sm?.found && sm.source ? { sitemapUrl: sm.source } : {} }));
  } else if (type === "sitemap") {
    const pages = (crawl?.pages || []).filter((p) => !p.noindex && ["self", "missing"].includes(classifyCanonical(p.finalUrl || p.url, p.canonicalHrefs || []).state));
    if (pages.length === 0) return { supported: false, rows: [], note: "No indexable crawled pages to list in a sitemap." };
    rows.push(row("create_sitemap_xml", null, "Create sitemap.xml", `Lists the ${pages.length} indexable page${pages.length === 1 ? "" : "s"} VertexRank crawled${crawl.truncated ? " (the crawl didn't cover the whole site, so regenerate this when it grows)" : ""}.`, { params: { urls: pages.map((p) => p.finalUrl || p.url) } }));
  }

  if (rows.length === 0) return { supported: false, rows: [], note: notes[0] || "Nothing could be prepared for this finding." };
  const truncated = rows.length > MAX_ROWS;
  if (truncated) notes.push(`Showing the first ${MAX_ROWS} of ${rows.length} changes; do the rest in another pull request.`);
  return { supported: true, rows: rows.slice(0, MAX_ROWS), note: notes.join(" "), truncated };
}

/** A row is ready when it needs no input, or its input has text. */
export const rowReady = (row, value) => !row.input || String(value ?? "").trim().length > 0;

/** The fix object sent to the API for a row (the server validates it again). */
export function rowToFix(row, value) {
  return { id: row.id, kind: row.kind, ...(row.pageUrl ? { pageUrl: row.pageUrl } : {}), ...row.params, ...(row.input ? { [row.input.key]: String(value ?? "") } : {}) };
}
