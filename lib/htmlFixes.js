// The fix engine for plain-HTML sites: turns "set this page's title", "add this alt text", "point this link at its final
// URL" and similar intents into precise edits of an HTML source file, or into new files (robots.txt, sitemap.xml).
//
// Safety rules baked into every fix (these exist because a site might NOT be 100% plain HTML):
//   1. VERIFY BEFORE EDITING. Each fix carries what the crawler saw (`expected`). If the file doesn't agree — e.g. the
//      crawler saw a title but the file has none — the page is being changed by JavaScript or a build step, so the file
//      is NOT the source of truth and the fix is refused with an explanation instead of guessing.
//   2. MINIMAL EDITS. Changes are string splices on the original text; formatting, line endings and everything else are
//      left byte-for-byte alone, so the pull-request diff shows only the real change.
//   3. REFUSE WHEN AMBIGUOUS. Several <title> tags, several matching links, a missing <head>: block, never pick one.
//   4. NEVER OVERWRITE WHAT IS THERE. New files (robots.txt, sitemap.xml) are only created when absent.
//
// Pure functions (no network, no GitHub): unit-tested in tests/htmlFixes.test.mjs.

import { scanTags, getAttr, attrValue, normalizeText, escapeText, escapeAttr, applySplices, detectEol } from "./htmlScan.js";

export const PAGE_FIX_KINDS = ["set_title", "set_meta_description", "set_canonical", "set_lang", "add_image_alt", "add_jsonld", "remove_noindex", "replace_href"];
export const FILE_FIX_KINDS = ["create_robots_txt", "create_sitemap_xml"];
export const FIX_KINDS = [...PAGE_FIX_KINDS, ...FILE_FIX_KINDS];

const ok = (html, note) => ({ ok: true, html, ...(note ? { note } : {}) });
const fail = (code, message) => ({ ok: false, code, message });

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const stripWww = (h) => String(h).replace(/^www\./i, "").toLowerCase();

/* ------------------------------------------------------------------ */
/* structure helpers                                                  */
/* ------------------------------------------------------------------ */

function headInfo(html, tags) {
  const open = tags.find((t) => !t.closing && t.name === "head");
  const close = open ? tags.find((t) => t.closing && t.name === "head" && t.start >= open.end) : null;
  const body = tags.find((t) => !t.closing && t.name === "body");
  if (!open) return { hasHead: false, start: 0, end: body ? body.start : html.length, open: null };
  return { hasHead: true, start: open.end, end: close ? close.start : body ? body.start : html.length, open };
}
const inHead = (head, tag) => tag.start >= head.start && tag.start < head.end;

/** Whitespace prefix of the line containing `pos`, or null if something other than whitespace precedes `pos` on that line. */
function lineIndent(html, pos) {
  const lineStart = html.lastIndexOf("\n", pos - 1) + 1;
  const prefix = html.slice(lineStart, pos);
  return /^[ \t]*$/.test(prefix) ? prefix : null;
}

/** Splice that inserts `snippet` right after `afterPos`, on its own line indented like the tag at `anchorStart`. */
function insertAfter(html, afterPos, anchorStart, snippet, eol) {
  const indent = lineIndent(html, anchorStart);
  return { start: afterPos, end: afterPos, text: indent === null ? snippet : eol + indent + snippet };
}

/** Splice that inserts `snippet` as the first child of <head>, matching the indentation of what follows. */
function insertAtHeadStart(html, head, snippet, eol) {
  const m = /^[ \t]*\r?\n([ \t]*)\S/.exec(html.slice(head.open.end, head.open.end + 400));
  return { start: head.open.end, end: head.open.end, text: m ? eol + m[1] + snippet : snippet };
}

function replaceAttrValue(html, tag, attrName, newValue) {
  const a = getAttr(tag, attrName);
  const escaped = escapeAttr(newValue);
  if (!a) {
    const at = tag.attrs.length ? tag.attrs[tag.attrs.length - 1].end : tag.start + 1 + tag.name.length;
    return { start: at, end: at, text: ` ${attrName}="${escaped}"` };
  }
  if (a.value === null) return { start: a.end, end: a.end, text: `="${escaped}"` }; // valueless attribute
  if (a.quote === '"') return { start: a.valueStart, end: a.valueEnd, text: escaped };
  if (a.quote === "'") return { start: a.valueStart, end: a.valueEnd, text: escaped.replace(/'/g, "&#39;") };
  return { start: a.valueStart, end: a.valueEnd, text: `"${escaped}"` }; // unquoted -> quoted
}

const sameText = (current, expected) => normalizeText(current) === normalizeText(expected ?? "");
const quote = (s) => `“${String(s).slice(0, 80)}${String(s).length > 80 ? "…" : ""}”`;

const MISSING_IN_FILE = (what, saw) =>
  `The crawler saw a ${what} (${quote(saw)}) but the file doesn't contain one. The page is probably being changed by JavaScript or a build step, so this file isn't the source of truth. Not edited.`;
const DIFFERENT_IN_FILE = (what, saw, has) =>
  `The file's ${what} (${quote(has)}) isn't what the crawler saw on the live page (${quote(saw)}). The live page is probably produced by JavaScript or a build step, so editing this file may not change it. Not edited.`;

/* ------------------------------------------------------------------ */
/* page fixes                                                         */
/* ------------------------------------------------------------------ */

function setTitle(html, fix) {
  const value = oneLine(fix.value);
  if (!value) return fail("INVALID", "A title is required.");
  const tags = scanTags(html);
  const head = headInfo(html, tags);
  const titles = tags.filter((t) => !t.closing && t.name === "title" && inHead(head, t));
  if (titles.length > 1) return fail("AMBIGUOUS", `The file has ${titles.length} <title> tags in <head>; refusing to guess which one to change.`);
  if (titles.length === 1) {
    const open = titles[0];
    const close = tags.find((t) => t.closing && t.name === "title" && t.start >= open.end);
    if (!close) return fail("MALFORMED", "The <title> tag isn't closed.");
    const current = html.slice(open.end, close.start);
    if (fix.expected !== undefined && !sameText(current, fix.expected)) {
      return normalizeText(fix.expected) === "" ? fail("MISMATCH", `The crawler saw no title, but the file has one (${quote(normalizeText(current))}). It may be set by JavaScript. Not edited.`) : fail("MISMATCH", DIFFERENT_IN_FILE("title", normalizeText(fix.expected), normalizeText(current)));
    }
    if (normalizeText(current) === value) return fail("NO_CHANGE", "The title already has this value.");
    return ok(applySplices(html, [{ start: open.end, end: close.start, text: escapeText(value) }]));
  }
  if (fix.expected && normalizeText(fix.expected)) return fail("MISMATCH", MISSING_IN_FILE("title", normalizeText(fix.expected)));
  if (!head.hasHead) return fail("NO_HEAD", "The file has no <head> section to add a <title> to.");
  return ok(applySplices(html, [insertAtHeadStart(html, head, `<title>${escapeText(value)}</title>`, detectEol(html))]), "Added a <title> tag.");
}

function setMetaDescription(html, fix) {
  const value = oneLine(fix.value);
  if (!value) return fail("INVALID", "A description is required.");
  const tags = scanTags(html);
  const head = headInfo(html, tags);
  const metas = tags.filter((t) => !t.closing && t.name === "meta" && inHead(head, t) && (attrValue(t, "name") || "").toLowerCase() === "description");
  if (metas.length > 1) return fail("AMBIGUOUS", `The file has ${metas.length} meta description tags; refusing to guess which one to change.`);
  if (metas.length === 1) {
    const tag = metas[0];
    const current = attrValue(tag, "content") ?? "";
    if (fix.expected !== undefined && !sameText(current, fix.expected)) {
      return normalizeText(fix.expected) === "" ? fail("MISMATCH", `The crawler saw no meta description, but the file has one (${quote(normalizeText(current))}). It may be set by JavaScript. Not edited.`) : fail("MISMATCH", DIFFERENT_IN_FILE("meta description", normalizeText(fix.expected), normalizeText(current)));
    }
    if (normalizeText(current) === value) return fail("NO_CHANGE", "The meta description already has this value.");
    return ok(applySplices(html, [replaceAttrValue(html, tag, "content", value)]));
  }
  if (fix.expected && normalizeText(fix.expected)) return fail("MISMATCH", MISSING_IN_FILE("meta description", normalizeText(fix.expected)));
  if (!head.hasHead) return fail("NO_HEAD", "The file has no <head> section to add a meta description to.");
  const eol = detectEol(html);
  const snippet = `<meta name="description" content="${escapeAttr(value)}">`;
  const title = tags.find((t) => !t.closing && t.name === "title" && inHead(head, t));
  const titleClose = title && tags.find((t) => t.closing && t.name === "title" && t.start >= title.end);
  const splice = titleClose ? insertAfter(html, titleClose.end, title.start, snippet, eol) : insertAtHeadStart(html, head, snippet, eol);
  return ok(applySplices(html, [splice]), "Added a meta description tag.");
}

const relTokens = (tag) => (attrValue(tag, "rel") || "").toLowerCase().split(/\s+/).filter(Boolean);

function setCanonical(html, fix) {
  let target;
  try { target = new URL(fix.href); } catch { return fail("INVALID", "The canonical URL isn't a valid URL."); }
  if (target.protocol !== "https:" && target.protocol !== "http:") return fail("INVALID", "The canonical URL must be http(s).");
  const href = target.href;
  const tags = scanTags(html);
  const head = headInfo(html, tags);
  const links = tags.filter((t) => !t.closing && t.name === "link" && inHead(head, t) && relTokens(t).includes("canonical"));
  if (links.length > 1) return fail("AMBIGUOUS", `The file has ${links.length} canonical tags; refusing to guess which one to change.`);
  if (links.length === 1) {
    const tag = links[0];
    const current = attrValue(tag, "href") ?? "";
    if (fix.expected !== undefined && String(current).trim() !== String(fix.expected ?? "").trim()) {
      return fail("MISMATCH", DIFFERENT_IN_FILE("canonical URL", String(fix.expected ?? ""), current));
    }
    if (current.trim() === href) return fail("NO_CHANGE", "The canonical tag already has this value.");
    return ok(applySplices(html, [replaceAttrValue(html, tag, "href", href)]));
  }
  if (fix.expected && String(fix.expected).trim()) return fail("MISMATCH", MISSING_IN_FILE("canonical tag", fix.expected));
  if (!head.hasHead) return fail("NO_HEAD", "The file has no <head> section to add a canonical tag to.");
  return ok(applySplices(html, [insertAtHeadStart(html, head, `<link rel="canonical" href="${escapeAttr(href)}">`, detectEol(html))]), "Added a canonical tag.");
}

function setLang(html, fix) {
  const lang = oneLine(fix.value);
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) return fail("INVALID", "That isn't a valid language code (for example en or en-KE).");
  const tags = scanTags(html);
  const tag = tags.find((t) => !t.closing && t.name === "html");
  if (!tag) return fail("NO_HTML_TAG", "The file has no <html> tag to set the language on.");
  const a = getAttr(tag, "lang");
  if (a) {
    const current = attrValue(tag, "lang") ?? "";
    if (fix.expected === undefined) return fail("ALREADY_SET", `The <html> tag already declares lang=${quote(current)}.`);
    if (normalizeText(current) !== normalizeText(fix.expected ?? "")) return fail("MISMATCH", DIFFERENT_IN_FILE("lang attribute", fix.expected ?? "", current));
    if (current === lang) return fail("NO_CHANGE", "The lang attribute already has this value.");
    return ok(applySplices(html, [replaceAttrValue(html, tag, "lang", lang)]));
  }
  if (fix.expected && normalizeText(fix.expected)) return fail("MISMATCH", MISSING_IN_FILE("lang attribute", normalizeText(fix.expected)));
  const at = tag.start + 1 + tag.name.length;
  return ok(applySplices(html, [{ start: at, end: at, text: ` lang="${escapeAttr(lang)}"` }]), "Added a lang attribute.");
}

function addImageAlt(html, fix) {
  const alt = oneLine(fix.alt);
  const src = String(fix.src ?? "").trim();
  if (!alt) return fail("INVALID", "Alt text is required.");
  if (!src) return fail("INVALID", "The image source is required.");
  const tags = scanTags(html);
  const imgs = tags.filter((t) => !t.closing && t.name === "img" && (attrValue(t, "src") || "").trim() === src);
  if (imgs.length === 0) return fail("NOT_FOUND", `No <img> with src ${quote(src)} in this file. If the image is added by JavaScript, it can't be fixed here.`);
  const missing = imgs.filter((t) => !getAttr(t, "alt"));
  if (missing.length === 0) return fail("ALREADY_HAS_ALT", `Every matching image already has an alt attribute (alt="" marks an image as decorative, so it is left alone).`);
  const splices = missing.map((t) => {
    const at = t.attrs.length ? t.attrs[t.attrs.length - 1].end : t.start + 1 + t.name.length;
    return { start: at, end: at, text: ` alt="${escapeAttr(alt)}"` };
  });
  return ok(applySplices(html, splices), `Added alt text to ${missing.length} image tag${missing.length === 1 ? "" : "s"}.`);
}

function jsonLdTypes(obj, out = new Set()) {
  if (Array.isArray(obj)) { obj.forEach((o) => jsonLdTypes(o, out)); return out; }
  if (obj && typeof obj === "object") {
    for (const t of [].concat(obj["@type"] || [])) if (typeof t === "string") out.add(t);
    if (obj["@graph"]) jsonLdTypes(obj["@graph"], out);
  }
  return out;
}

function addJsonLd(html, fix) {
  let data = fix.json;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { return fail("INVALID", "The structured data isn't valid JSON."); } }
  const obj = Array.isArray(data) ? data[0] : data;
  if (!obj || typeof obj !== "object") return fail("INVALID", "The structured data must be a JSON object.");
  if (!/schema\.org/i.test(JSON.stringify(obj["@context"] ?? ""))) return fail("INVALID", 'The structured data needs "@context": "https://schema.org".');
  const newTypes = jsonLdTypes(data);
  if (newTypes.size === 0) return fail("INVALID", 'The structured data needs an "@type".');
  const tags = scanTags(html);
  const head = headInfo(html, tags);
  if (!head.hasHead) return fail("NO_HEAD", "The file has no <head> section to add structured data to.");

  const present = new Set();
  for (const t of tags.filter((x) => !x.closing && x.name === "script" && (attrValue(x, "type") || "").toLowerCase() === "application/ld+json")) {
    const close = tags.find((c) => c.closing && c.name === "script" && c.start >= t.end);
    if (!close) continue;
    try { jsonLdTypes(JSON.parse(html.slice(t.end, close.start)), present); } catch { /* an unparsable block is left alone */ }
  }
  const dup = [...newTypes].filter((t) => present.has(t));
  if (dup.length) return fail("DUPLICATE_TYPE", `The file already has ${dup.join(", ")} structured data; adding another block would duplicate it.`);
  const missingFromFile = (fix.expectedTypes || []).filter((t) => !present.has(t));
  if (missingFromFile.length) {
    return fail("MISMATCH", `The crawler saw ${missingFromFile.join(", ")} structured data that isn't in this file, so the page's markup is probably injected by JavaScript. Not edited.`);
  }

  const eol = detectEol(html);
  const m = /^[ \t]*\r?\n([ \t]*)\S/.exec(html.slice(head.open.end, head.open.end + 400));
  const indent = m ? m[1] : "";
  const json = JSON.stringify(data, null, 2).replace(/<\//g, "<\\/").split("\n").map((l) => (m ? indent + "  " : "") + l).join(eol);
  const snippet = m
    ? `<script type="application/ld+json">${eol}${json}${eol}${indent}</script>`
    : `<script type="application/ld+json">${JSON.stringify(data).replace(/<\//g, "<\\/")}</script>`;
  return ok(applySplices(html, [insertAtHeadStart(html, head, snippet, eol)]), `Added ${[...newTypes].join(", ")} structured data.`);
}

function removeNoindex(html) {
  const tags = scanTags(html);
  const eol = detectEol(html);
  const hits = tags.filter((t) => !t.closing && t.name === "meta" && ["robots", "googlebot"].includes((attrValue(t, "name") || "").toLowerCase())
    && (attrValue(t, "content") || "").toLowerCase().split(",").map((s) => s.trim()).some((s) => s === "noindex" || s === "none"));
  if (hits.length === 0) return fail("NOT_FOUND", "There's no noindex meta tag in this file. If the page is noindex, it comes from an X-Robots-Tag header or server configuration, which can't be changed in HTML.");
  const splices = hits.map((tag) => {
    const tokens = (attrValue(tag, "content") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const kept = [];
    for (const t of tokens) {
      const l = t.toLowerCase();
      if (l === "noindex") continue;
      const v = l === "none" ? "nofollow" : t;
      if (!kept.some((k) => k.toLowerCase() === v.toLowerCase())) kept.push(v);
    }
    if (kept.length > 0) return replaceAttrValue(html, tag, "content", kept.join(", "));
    // nothing left: remove the whole tag (and its line if it sits alone on it)
    const lineStart = html.lastIndexOf("\n", tag.start - 1) + 1;
    let lineEnd = html.indexOf("\n", tag.end);
    lineEnd = lineEnd === -1 ? html.length : lineEnd + 1;
    const alone = /^[ \t]*$/.test(html.slice(lineStart, tag.start)) && /^[ \t]*\r?\n?$/.test(html.slice(tag.end, lineEnd));
    return alone ? { start: lineStart, end: lineEnd, text: "" } : { start: tag.start, end: tag.end, text: "" };
  });
  void eol;
  return ok(applySplices(html, splices), `Removed noindex from ${hits.length} meta tag${hits.length === 1 ? "" : "s"}.`);
}

const urlKey = (u) => {
  const x = new URL(u);
  x.hash = "";
  if (x.pathname.length > 1 && x.pathname.endsWith("/")) x.pathname = x.pathname.slice(0, -1);
  return x.href;
};

function replaceHref(html, fix, ctx) {
  let from; let to; let page;
  try { from = new URL(fix.from); to = new URL(fix.to); page = new URL(ctx.pageUrl); } catch { return fail("INVALID", "The link URLs aren't valid."); }
  if (!/^https?:$/.test(to.protocol) || !/^https?:$/.test(from.protocol)) return fail("INVALID", "Links must be http(s) URLs.");
  if (urlKey(from.href) === urlKey(to.href)) return fail("NO_CHANGE", "The old and new link are the same.");
  const tags = scanTags(html);
  const splices = [];
  let relativeOnly = 0;
  for (const tag of tags.filter((t) => !t.closing && t.name === "a")) {
    const a = getAttr(tag, "href");
    const raw = a && a.value !== null ? attrValue(tag, "href").trim() : null;
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(raw) || raw.startsWith("//")) continue;
    let abs;
    try { abs = new URL(raw, page); } catch { continue; }
    if (!/^https?:$/.test(abs.protocol) || urlKey(abs.href) !== urlKey(from.href)) continue;
    const isAbsolute = /^https?:\/\//i.test(raw);
    const isRootRelative = raw.startsWith("/");
    if (!isAbsolute && !isRootRelative) { relativeOnly++; continue; } // "about.html", "../x": depends on the base; leave to a human
    const frag = abs.hash && !to.hash ? abs.hash : to.hash;
    const target = new URL(to.href); target.hash = "";
    const base = isRootRelative && target.origin === page.origin ? target.pathname + target.search : target.href;
    splices.push(replaceAttrValue(html, tag, "href", base + frag));
  }
  if (splices.length === 0) {
    return relativeOnly > 0
      ? fail("RELATIVE_ONLY", `Only relative links to this URL were found (${relativeOnly}). Rewriting those safely depends on each file's location, so it needs a manual edit.`)
      : fail("NOT_FOUND", "No link to that URL was found in this file. If the link is added by JavaScript, it can't be fixed here.");
  }
  return ok(applySplices(html, splices), `Updated ${splices.length} link${splices.length === 1 ? "" : "s"}${relativeOnly ? ` (${relativeOnly} relative link${relativeOnly === 1 ? "" : "s"} left for a manual edit)` : ""}.`);
}

/** Applies one page-level fix to an HTML source string. Returns { ok:true, html, note? } or { ok:false, code, message }. */
export function applyHtmlFix(html, fix, ctx = {}) {
  switch (fix?.kind) {
    case "set_title": return setTitle(html, fix);
    case "set_meta_description": return setMetaDescription(html, fix);
    case "set_canonical": return setCanonical(html, fix);
    case "set_lang": return setLang(html, fix);
    case "add_image_alt": return addImageAlt(html, fix);
    case "add_jsonld": return addJsonLd(html, fix);
    case "remove_noindex": return removeNoindex(html);
    case "replace_href": return replaceHref(html, fix, ctx);
    default: return fail("UNSUPPORTED", `Unsupported fix: ${fix?.kind}`);
  }
}

/* ------------------------------------------------------------------ */
/* new files                                                          */
/* ------------------------------------------------------------------ */

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Builds the content of a new file. `siteUrl` is the site's origin. Returns { ok, path, content } or { ok:false, code, message }. */
export function buildFileFix(fix, { siteUrl }) {
  let origin;
  try { origin = new URL(siteUrl).origin; } catch { return fail("INVALID", "The site URL isn't valid."); }
  if (fix.kind === "create_robots_txt") {
    const lines = ["User-agent: *", "Allow: /"];
    if (fix.sitemapUrl) {
      let s;
      try { s = new URL(fix.sitemapUrl); } catch { return fail("INVALID", "The sitemap URL isn't valid."); }
      if (s.origin !== origin) return fail("INVALID", "The sitemap must be on the same site.");
      lines.push("", `Sitemap: ${s.href}`);
    }
    return { ok: true, path: "robots.txt", content: lines.join("\n") + "\n", note: "Creates robots.txt allowing all crawlers." };
  }
  if (fix.kind === "create_sitemap_xml") {
    const seen = new Set();
    const urls = [];
    for (const u of fix.urls || []) {
      let x;
      try { x = new URL(u); } catch { continue; }
      if (x.origin !== origin || !/^https?:$/.test(x.protocol)) continue;
      x.hash = "";
      if (!seen.has(x.href)) { seen.add(x.href); urls.push(x.href); }
    }
    if (urls.length === 0) return fail("INVALID", "No valid URLs on this site to list in the sitemap.");
    if (urls.length > 5000) return fail("INVALID", "A sitemap file can list at most 5,000 URLs here.");
    urls.sort();
    const body = urls.map((u) => `  <url>\n    <loc>${xmlEscape(u)}</loc>\n  </url>`).join("\n");
    return { ok: true, path: "sitemap.xml", content: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`, note: `Creates sitemap.xml listing ${urls.length} URL${urls.length === 1 ? "" : "s"}.` };
  }
  return fail("UNSUPPORTED", `Unsupported fix: ${fix?.kind}`);
}

/* ------------------------------------------------------------------ */
/* validation of fixes arriving from the client                       */
/* ------------------------------------------------------------------ */

const isStr = (v, max) => typeof v === "string" && v.length <= max;

/**
 * Validates and sanitises one fix received over the API. Returns { ok:true, fix } with only known fields, or { ok:false, error }.
 * `siteUrl`: the website's address; page URLs must be on the same site.
 */
export function validateFix(raw, { siteUrl }) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Each fix must be an object." };
  const kind = raw.kind;
  if (!FIX_KINDS.includes(kind)) return { ok: false, error: `Unknown fix kind: ${String(kind).slice(0, 40)}` };
  const id = isStr(raw.id, 80) && raw.id ? raw.id : null;
  if (!id) return { ok: false, error: "Each fix needs an id." };
  const fix = { id, kind };
  let site;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(String(siteUrl)) && !/^https?:\/\//i.test(String(siteUrl))) return { ok: false, error: "The website URL isn't valid." };
  try { site = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`); } catch { return { ok: false, error: "The website URL isn't valid." }; }

  if (PAGE_FIX_KINDS.includes(kind)) {
    if (!isStr(raw.pageUrl, 2048)) return { ok: false, error: "Each page fix needs a pageUrl." };
    let page;
    try { page = new URL(raw.pageUrl); } catch { return { ok: false, error: "A pageUrl isn't a valid URL." }; }
    if (!/^https?:$/.test(page.protocol) || stripWww(page.host) !== stripWww(site.host)) return { ok: false, error: `${raw.pageUrl.slice(0, 80)} isn't on ${site.host}.` };
    fix.pageUrl = page.href;
  }
  const optText = (k, max) => { if (raw[k] !== undefined && raw[k] !== null) { if (!isStr(raw[k], max)) return `${k} is too long or not text.`; fix[k] = raw[k]; } else if (raw[k] === null) fix[k] = null; return null; };
  let err = null;
  switch (kind) {
    case "set_title": if (!isStr(raw.value, 300) || !raw.value.trim()) err = "A title (up to 300 characters) is required."; else { fix.value = raw.value; err = optText("expected", 600); } break;
    case "set_meta_description": if (!isStr(raw.value, 600) || !raw.value.trim()) err = "A description (up to 600 characters) is required."; else { fix.value = raw.value; err = optText("expected", 1200); } break;
    case "set_canonical": if (!isStr(raw.href, 2048) || !raw.href) err = "A canonical URL is required."; else { fix.href = raw.href; err = optText("expected", 2048); } break;
    case "set_lang": if (!isStr(raw.value, 20) || !raw.value) err = "A language code is required."; else { fix.value = raw.value; err = optText("expected", 20); } break;
    case "add_image_alt": if (!isStr(raw.src, 2048) || !raw.src || !isStr(raw.alt, 300) || !raw.alt.trim()) err = "An image src and alt text are required."; else { fix.src = raw.src; fix.alt = raw.alt; } break;
    case "add_jsonld":
      if (typeof raw.json === "string" ? raw.json.length > 20000 : JSON.stringify(raw.json ?? null).length > 20000) err = "The structured data is too large.";
      else if (raw.json === undefined || raw.json === null) err = "Structured data is required.";
      else { fix.json = raw.json; if (Array.isArray(raw.expectedTypes)) fix.expectedTypes = raw.expectedTypes.filter((t) => isStr(t, 80)).slice(0, 10); }
      break;
    case "remove_noindex": break;
    case "replace_href": if (!isStr(raw.from, 2048) || !isStr(raw.to, 2048) || !raw.from || !raw.to) err = "Both the old and the new link are required."; else { fix.from = raw.from; fix.to = raw.to; } break;
    case "create_robots_txt": if (raw.sitemapUrl) { if (!isStr(raw.sitemapUrl, 2048)) err = "The sitemap URL is too long."; else fix.sitemapUrl = raw.sitemapUrl; } break;
    case "create_sitemap_xml": if (!Array.isArray(raw.urls) || raw.urls.length === 0 || raw.urls.length > 5000 || !raw.urls.every((u) => isStr(u, 2048))) err = "Between 1 and 5,000 URLs are required."; else fix.urls = raw.urls; break;
    default: break;
  }
  return err ? { ok: false, error: err } : { ok: true, fix };
}
