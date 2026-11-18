// Reads what a site has already published from its own WordPress API, RSS/Atom feed and sitemap (server only).
// Every request goes through safeFetchText (public hosts only, size and time limits) and never leaves the site's own host.
import { safeFetchText, validatePublicUrl } from "./safeFetch.js";
import { parseFeed, parseWpPosts, sitemapLocs, sitemapPosts, mergeContentIndex, sitemapPriority, FEED_PATHS, SITEMAP_PATHS } from "./contentIndex.js";

const UA = "Mozilla/5.0 (compatible; VertexRankBot/1.0; +https://vertexrank.app/bot)";
const stripWww = (h) => h.replace(/^www\./i, "").toLowerCase();

export async function fetchContentIndex(siteUrl) {
  let start;
  try { start = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`); } catch { return { error: "That doesn't look like a valid URL." }; }
  const allowed = await validatePublicUrl(start);
  if (!allowed.ok) return { error: allowed.message };
  const origin = start.origin, host = start.host;
  const sameSite = (from, to) => stripWww(from.hostname) === stripWww(to.hostname);
  const get = async (path, accept) => {
    const url = path.startsWith("http") ? path : origin + path;
    try { const res = await safeFetchText(url, { timeoutMs: 7000, accept, maxBytes: 2 * 1024 * 1024, redirectPolicy: sameSite, headers: { "User-Agent": UA } }); return res.ok && res.text ? res.text : ""; } catch { return ""; }
  };
  const XML = ["application/xml", "text/xml", "application/rss+xml", "application/atom+xml", "text/plain", "application/octet-stream"];
  const notes = [];

  const wp = (async () => {
    const out = [];
    for (let page = 1; page <= 4; page++) {
      const body = await get(`/wp-json/wp/v2/posts?per_page=100&page=${page}&_fields=title,link,date`, ["application/json"]);
      let json; try { json = JSON.parse(body); } catch { break; }
      const rows = parseWpPosts(json);
      out.push(...rows.map((r) => ({ ...r, source: "wordpress" })));
      if (rows.length < 100) break;
    }
    return out;
  })();
  const feeds = (async () => {
    const results = await Promise.all(FEED_PATHS.map((p) => get(p, XML)));
    return results.flatMap((x) => parseFeed(x)).map((r) => ({ ...r, source: "feed" }));
  })();
  const sitemap = (async () => {
    const roots = (await Promise.all(SITEMAP_PATHS.map((p) => get(p, XML)))).map(sitemapLocs).filter((r) => r.locs.length);
    const urls = [];
    const subs = [];
    for (const r of roots) { if (r.isIndex) subs.push(...r.locs); else urls.push(...r.locs); }
    const sameHostSubs = [...new Set(subs)].filter((u) => { try { return stripWww(new URL(u).host) === stripWww(host); } catch { return false; } }).sort((a, b) => sitemapPriority(a) - sitemapPriority(b)).slice(0, 8);
    if (subs.length > sameHostSubs.length) notes.push("Some sub-sitemaps were skipped, so the list may be incomplete.");
    const bodies = await Promise.all(sameHostSubs.map((u) => get(u, XML)));
    for (const b of bodies) urls.push(...sitemapLocs(b).locs);
    return sitemapPosts(urls, host);
  })();

  const [w, f, s] = await Promise.all([wp, feeds, sitemap]);
  const posts = mergeContentIndex([w, f, s]);
  const counts = { wordpress: w.length, feed: f.length, sitemap: s.length, total: posts.length };
  if (!posts.length) notes.push("No feed, WordPress API or sitemap with posts was found. Use \"Paste titles\" to add your existing titles by hand.");
  else if (!w.length && !f.length) notes.push("Only the sitemap was readable, so titles are guessed from the URLs.");
  return { posts, counts, notes, scannedAt: new Date().toISOString() };
}
