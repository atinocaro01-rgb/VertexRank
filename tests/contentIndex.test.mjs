import test from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, parseFeed, parseWpPosts, sitemapLocs, isContentUrl, titleFromSlug, mergeContentIndex, sitemapPosts, sitemapPriority } from "../lib/contentIndex.js";

test("decodeEntities handles CDATA, numeric and named entities, and strips tags", () => {
  assert.equal(decodeEntities("<![CDATA[Teachers &amp; Parents]]>"), "Teachers & Parents");
  assert.equal(decodeEntities("It&#8217;s &#x2014; <b>bold</b> &nbsp;text"), "It’s — bold text");
  assert.equal(decodeEntities(null), "");
});

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>
<item><title><![CDATA[How to write schemes of work]]></title><link>https://s.com/blog/schemes/</link><pubDate>Mon, 02 Nov 2026 10:00:00 +0000</pubDate></item>
<item><title>Grade 9 &amp; senior school checklist</title><link>https://s.com/blog/grade-9/</link></item>
<item><title>No link here</title></item></channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom post</title><link href="https://s.com/a-post" rel="alternate"/><updated>2026-10-01T00:00:00Z</updated></entry></feed>`;

test("parseFeed reads RSS items and Atom entries, skips items without a link, ignores non-feeds", () => {
  const r = parseFeed(RSS);
  assert.deepEqual(r.map((x) => x.title), ["How to write schemes of work", "Grade 9 & senior school checklist"]);
  assert.equal(r[0].url, "https://s.com/blog/schemes/"); assert.match(r[0].date, /Nov 2026/);
  assert.deepEqual(parseFeed(ATOM), [{ title: "Atom post", url: "https://s.com/a-post", date: "2026-10-01T00:00:00Z" }]);
  assert.deepEqual(parseFeed("<html><body>Not found</body></html>"), []); assert.deepEqual(parseFeed(""), []);
});

test("parseWpPosts reads the WordPress REST shape and drops bad rows", () => {
  const r = parseWpPosts([{ title: { rendered: "CBC &#8211; notes" }, link: "https://s.com/cbc-notes/", date: "2026-09-01T10:00:00" }, { title: { rendered: "" }, link: "https://s.com/x" }, { title: { rendered: "No link" } }]);
  assert.deepEqual(r, [{ title: "CBC – notes", url: "https://s.com/cbc-notes/", date: "2026-09-01T10:00:00" }]);
  assert.deepEqual(parseWpPosts({ code: "rest_no_route" }), []);
});

test("sitemapLocs separates sitemap indexes from url sets", () => {
  assert.deepEqual(sitemapLocs(`<urlset><url><loc>https://s.com/a</loc></url><url><loc> https://s.com/b?x=1&amp;y=2 </loc></url></urlset>`), { isIndex: false, locs: ["https://s.com/a", "https://s.com/b?x=1&y=2"] });
  const idx = sitemapLocs(`<sitemapindex><sitemap><loc>https://s.com/post-sitemap.xml</loc></sitemap></sitemapindex>`);
  assert.equal(idx.isIndex, true); assert.equal(idx.locs.length, 1);
  assert.deepEqual(sitemapLocs("<html/>"), { isIndex: false, locs: [] });
});

test("isContentUrl keeps articles and drops the homepage, taxonomy pages, pagination, files and other hosts", () => {
  const ok = (u) => isContentUrl(u, "s.com");
  assert.equal(ok("https://s.com/blog/grade-9-checklist/"), true); assert.equal(ok("https://www.s.com/about"), true);
  for (const u of ["https://s.com/", "https://s.com/tag/cbc", "https://s.com/category/news/", "https://s.com/author/jo", "https://s.com/blog/page/2", "https://s.com/logo.png", "https://s.com/wp-content/x", "https://other.com/blog/a", "not a url"]) assert.equal(ok(u), false, u);
});

test("titleFromSlug makes a readable guess and refuses meaningless slugs", () => {
  assert.equal(titleFromSlug("https://s.com/blog/grade-9-teacher-checklist/"), "Grade 9 teacher checklist");
  assert.equal(titleFromSlug("https://s.com/how_to%20plan.html"), "How to plan");
  assert.equal(titleFromSlug("https://s.com/blog/12345"), ""); assert.equal(titleFromSlug("https://s.com/a"), "");
});

test("mergeContentIndex prefers real titles over slug guesses for the same URL and puts real titles first", () => {
  const sm = sitemapPosts(["https://s.com/blog/schemes/", "https://s.com/blog/only-in-sitemap-post", "https://s.com/tag/x"], "s.com");
  assert.equal(sm.length, 2);
  const merged = mergeContentIndex([sm, [{ title: "How to write schemes of work", url: "https://www.s.com/blog/schemes", source: "feed", date: "2026-11-02" }]]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((m) => [m.title, m.titleFromSlug]), [["How to write schemes of work", false], ["Only in sitemap post", true]]);
  assert.equal(mergeContentIndex([Array.from({ length: 600 }, (_, i) => ({ title: `T${i}`, url: `https://s.com/p${i}`, source: "feed" }))]).length, 400);
});

test("sub-sitemaps that look like articles are read first", () => {
  const urls = ["https://s.com/product-sitemap.xml", "https://s.com/misc.xml", "https://s.com/post-sitemap.xml"].sort((a, b) => sitemapPriority(a) - sitemapPriority(b));
  assert.deepEqual(urls, ["https://s.com/post-sitemap.xml", "https://s.com/misc.xml", "https://s.com/product-sitemap.xml"]);
});
