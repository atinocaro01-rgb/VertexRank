// Parsing helpers for "what has this site already published?" (pure: no network, no dependencies). Tests: tests/contentIndex.test.mjs.
// The crawl only reaches ~30-60 pages, so blog posts beyond that are read from the site's own WordPress API, RSS/Atom feed and
// sitemap. Titles come from the feed/API when available; sitemap-only posts get a title guessed from the URL slug and are marked so.

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };
export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; })
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const tag = (block, name) => { const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")); return m ? decodeEntities(m[1]) : ""; };

/** RSS 2.0 (<item>) and Atom (<entry>) feeds -> [{ title, url, date }]. Returns [] for anything else. */
export function parseFeed(xml) {
  const text = String(xml || "");
  if (!/<(rss|feed|rdf:RDF)\b/i.test(text.slice(0, 2000))) return [];
  const out = [];
  for (const m of text.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const b = m[2];
    const title = tag(b, "title");
    let url = tag(b, "link");
    if (!url) { const a = b.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i); url = a ? decodeEntities(a[1]) : ""; }
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title: title.slice(0, 200), url, date: (tag(b, "pubDate") || tag(b, "updated") || tag(b, "published") || tag(b, "dc:date")).slice(0, 40) });
    if (out.length >= 500) break;
  }
  return out;
}

/** WordPress REST (/wp-json/wp/v2/posts) JSON -> [{ title, url, date }]. */
export function parseWpPosts(json) {
  if (!Array.isArray(json)) return [];
  return json.map((p) => ({ title: decodeEntities(p?.title?.rendered ?? p?.title), url: String(p?.link || ""), date: String(p?.date || "").slice(0, 40) }))
    .filter((p) => p.title && /^https?:\/\//i.test(p.url)).slice(0, 500).map((p) => ({ ...p, title: p.title.slice(0, 200) }));
}

/** A sitemap or sitemap index -> { isIndex, locs }. */
export function sitemapLocs(xml) {
  const text = String(xml || "");
  const isIndex = /<sitemapindex\b/i.test(text);
  if (!isIndex && !/<urlset\b/i.test(text)) return { isIndex: false, locs: [] };
  const locs = [...text.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1])).filter((u) => /^https?:\/\//i.test(u));
  return { isIndex, locs };
}

const FILE_EXT = /\.(jpe?g|png|gif|webp|svg|ico|pdf|css|js|json|xml|txt|zip|mp4|mp3|woff2?|docx?|xlsx?)$/i;
const NOT_CONTENT = /^\/(tag|tags|category|categories|author|authors|page|wp-content|wp-json|wp-admin|feed|cart|checkout|my-account|search|login|register|cdn-cgi)(\/|$)/i;
const stripWww = (h) => String(h || "").replace(/^www\./i, "").toLowerCase();

/** Same-site URL that looks like an article/page worth knowing about (not the homepage, a tag/author page, pagination or a file). */
export function isContentUrl(url, originHost) {
  try {
    const u = new URL(url);
    if (originHost && stripWww(u.host) !== stripWww(originHost)) return false;
    const path = u.pathname.replace(/\/+$/, "");
    if (!path || path === "") return false;
    if (FILE_EXT.test(path) || NOT_CONTENT.test(path) || /\/page\/\d+$/i.test(path)) return false;
    return true;
  } catch { return false; }
}

/** A readable title guessed from a URL's last path segment ("/blog/grade-9-teacher-checklist/" -> "Grade 9 teacher checklist"). */
export function titleFromSlug(url) {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    let t = decodeURIComponent(seg).replace(/\.(html?|php|aspx?)$/i, "").replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim();
    if (t.length < 4 || /^\d+$/.test(t)) return "";
    return t.charAt(0).toUpperCase() + t.slice(1);
  } catch { return ""; }
}

export function normalizeUrlKey(u) {
  try { const x = new URL(u); return `${stripWww(x.host)}${x.pathname.replace(/\/+$/, "")}`.toLowerCase(); } catch { return String(u || "").toLowerCase(); }
}

const RANK = { wordpress: 0, feed: 1, sitemap: 2 };

/** Merges lists of { title, url, date, source } by URL, preferring real titles (WordPress, then feed) over slug guesses. */
export function mergeContentIndex(lists, cap = 400) {
  const byUrl = new Map();
  for (const item of lists.flat()) {
    if (!item?.url || !item?.title) continue;
    const k = normalizeUrlKey(item.url);
    const cur = byUrl.get(k);
    if (!cur || (RANK[item.source] ?? 3) < (RANK[cur.source] ?? 3)) byUrl.set(k, { title: item.title, url: item.url, date: item.date || cur?.date || "", source: item.source, titleFromSlug: item.source === "sitemap" });
  }
  return [...byUrl.values()].sort((a, b) => (a.titleFromSlug - b.titleFromSlug) || String(b.date).localeCompare(String(a.date))).slice(0, cap);
}

/** Sitemap URLs -> [{ title, url, source: "sitemap" }] for content-like pages. */
export function sitemapPosts(urls, originHost, cap = 2000) {
  const out = [];
  for (const url of urls) {
    if (out.length >= cap) break;
    if (!isContentUrl(url, originHost)) continue;
    const title = titleFromSlug(url);
    if (title) out.push({ title, url, date: "", source: "sitemap" });
  }
  return out;
}

export const FEED_PATHS = ["/feed", "/feed/", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml", "/rss", "/blog/feed", "/blog/rss.xml", "/blog/feed.xml"];
export const SITEMAP_PATHS = ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml", "/post-sitemap.xml"];
/** Sub-sitemaps that most likely hold articles are fetched first. */
export const sitemapPriority = (u) => (/post|blog|news|article|insight|guide|learn|resource|stories|journal/i.test(u) ? 0 : /page|product|category|tag|author|image|video/i.test(u) ? 2 : 1);
