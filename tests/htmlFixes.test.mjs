import test from "node:test";
import assert from "node:assert/strict";
import { scanTags, normalizeText, decodeEntities, escapeAttr, applySplices } from "../lib/htmlScan.js";
import { applyHtmlFix, buildFileFix, validateFix } from "../lib/htmlFixes.js";

const PAGE = "https://a.com/about";
const fix = (kind, o = {}) => ({ id: "f1", kind, pageUrl: PAGE, ...o });
const run = (html, f, ctx = { pageUrl: PAGE }) => applyHtmlFix(html, f, ctx);

const DOC = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Old Title</title>
  <meta name="description" content="Old description">
  <link rel="canonical" href="https://a.com/about">
</head>
<body>
  <h1>Hello</h1>
</body>
</html>
`;

test("scanTags: comments, raw text, quoted '>' in attributes, unquoted/valueless attrs, case, self-closing", () => {
  const html = `<!-- <title>fake</title> --><HTML LANG=en><head><script>var s = "<title>nope</title>";</script><style>a>b{}</style>
<meta name="d" content="a > b" data-x><img src=pic.png alt='q"x' /><title>Real <b>T</b></title></head>`;
  const tags = scanTags(html);
  const names = tags.filter((t) => !t.closing).map((t) => t.name);
  assert.deepEqual(names, ["html", "head", "script", "style", "meta", "img", "title"]); // nothing inside comments/script/style/title
  const meta = tags.find((t) => t.name === "meta");
  assert.equal(meta.attrs.find((a) => a.nameLower === "content").value, "a > b");
  assert.equal(meta.attrs.find((a) => a.nameLower === "data-x").value, null);
  const img = tags.find((t) => t.name === "img");
  assert.equal(img.selfClosing, true); assert.equal(img.attrs[0].value, "pic.png"); assert.equal(img.attrs[1].value, 'q"x');
  assert.equal(tags.find((t) => t.name === "html").attrs[0].value, "en");
  // positions are exact string indices
  for (const t of tags) assert.ok(html.slice(t.start, t.end).startsWith("<"));
  assert.doesNotThrow(() => scanTags('<a href="unterminated')); assert.doesNotThrow(() => scanTags("a < b and <3 <")); assert.deepEqual(scanTags(""), []);
});

test("entities and splices", () => {
  assert.equal(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41; &nbsp;f"), `a & b <c> "d" 'e' A  f`);
  assert.equal(normalizeText("  Hello\n   &amp;   World  "), "Hello & World");
  assert.equal(escapeAttr(`a"b&c<d>`), "a&quot;b&amp;c&lt;d&gt;");
  assert.equal(applySplices("0123456789", [{ start: 2, end: 4, text: "X" }, { start: 7, end: 7, text: "Y" }]), "01X456Y789");
});

test("set_title: replaces only the text, leaves every other byte alone", () => {
  const r = run(DOC, fix("set_title", { value: "New & Better Title", expected: "Old Title" }));
  assert.equal(r.ok, true);
  assert.equal(r.html, DOC.replace("Old Title", "New &amp; Better Title"));
});

test("set_title: refuses when the file disagrees with what the crawler saw (JavaScript/build-generated pages)", () => {
  const r = run(DOC, fix("set_title", { value: "X", expected: "Something the browser showed" }));
  assert.equal(r.ok, false); assert.equal(r.code, "MISMATCH"); assert.match(r.message, /isn't what the crawler saw/); assert.match(r.message, /JavaScript or a build step/);
  const noTitleInFile = DOC.replace(/\s*<title>.*<\/title>/, "");
  const r2 = run(noTitleInFile, fix("set_title", { value: "X", expected: "Seen by crawler" }));
  assert.equal(r2.code, "MISMATCH"); assert.match(r2.message, /doesn't contain one/);
  const r3 = run(DOC, fix("set_title", { value: "X", expected: "" })); // crawler saw no title but the file has one
  assert.equal(r3.code, "MISMATCH");
});

test("set_title: inserts a missing title as the first child of <head>, matching indentation and line endings", () => {
  const noTitle = DOC.replace(/\s*<title>.*<\/title>/, "");
  const r = run(noTitle, fix("set_title", { value: "Fresh", expected: "" }));
  assert.equal(r.ok, true); assert.match(r.html, /<head>\n  <title>Fresh<\/title>\n  <meta charset="utf-8">/);
  const crlf = noTitle.replace(/\n/g, "\r\n");
  const rc = run(crlf, fix("set_title", { value: "Fresh" }));
  assert.match(rc.html, /<head>\r\n  <title>Fresh<\/title>\r\n  <meta charset/); assert.ok(!/[^\r]\n/.test(rc.html), "no bare LF introduced into a CRLF file");
  const compact = run("<html><head><meta charset=utf-8></head><body></body></html>", fix("set_title", { value: "C" }));
  assert.equal(compact.html, "<html><head><title>C</title><meta charset=utf-8></head><body></body></html>");
});

test("set_title: ambiguous or impossible situations are refused, never guessed", () => {
  assert.equal(run(DOC.replace("</head>", "<title>Second</title></head>"), fix("set_title", { value: "X" })).code, "AMBIGUOUS");
  assert.equal(run("<html><body>hi</body></html>", fix("set_title", { value: "X" })).code, "NO_HEAD");
  assert.equal(run(DOC, fix("set_title", { value: "  " })).code, "INVALID");
  assert.equal(run(DOC, fix("set_title", { value: "Old Title" })).code, "NO_CHANGE");
  // an inline SVG <title> in the body is not the page title
  const svg = DOC.replace("<h1>Hello</h1>", '<svg><title>Icon</title></svg>');
  assert.equal(run(svg, fix("set_title", { value: "New", expected: "Old Title" })).html.includes("<svg><title>Icon</title></svg>"), true);
});

test("set_meta_description: replace in place (any quote style), insert after the title, refuse mismatches", () => {
  const r = run(DOC, fix("set_meta_description", { value: 'New "quoted" description', expected: "Old description" }));
  assert.equal(r.ok, true); assert.ok(r.html.includes('content="New &quot;quoted&quot; description"'));
  const single = run(DOC.replace('content="Old description"', "content='Old description'"), fix("set_meta_description", { value: "It's new" }));
  assert.ok(single.html.includes(`content='It&#39;s new'`));
  const bare = DOC.replace('<meta name="description" content="Old description">\n  ', "");
  const ins = run(bare, fix("set_meta_description", { value: "Added", expected: "" }));
  assert.match(ins.html, /<title>Old Title<\/title>\n  <meta name="description" content="Added">\n  <link rel="canonical"/);
  assert.equal(run(DOC, fix("set_meta_description", { value: "x", expected: "different" })).code, "MISMATCH");
  assert.equal(run(bare, fix("set_meta_description", { value: "x", expected: "crawler saw this" })).code, "MISMATCH");
  assert.equal(run(DOC.replace("</head>", '<meta name="description" content="dup"></head>'), fix("set_meta_description", { value: "x" })).code, "AMBIGUOUS");
  const noContent = DOC.replace('content="Old description"', "");
  assert.ok(run(noContent, fix("set_meta_description", { value: "Filled" })).html.includes('<meta name="description"  content="Filled">') || run(noContent, fix("set_meta_description", { value: "Filled" })).html.includes('content="Filled"'));
});

test("set_canonical: update, insert, refuse; validates the URL", () => {
  const u = run(DOC, fix("set_canonical", { href: "https://a.com/about/", expected: "https://a.com/about" }));
  assert.equal(u.ok, true); assert.ok(u.html.includes('href="https://a.com/about/"'));
  const none = DOC.replace(/\s*<link rel="canonical"[^>]*>/, "");
  const ins = run(none, fix("set_canonical", { href: PAGE, expected: "" }));
  assert.match(ins.html, /<head>\n  <link rel="canonical" href="https:\/\/a\.com\/about">\n  <meta charset/);
  assert.equal(run(none, fix("set_canonical", { href: PAGE, expected: "https://a.com/js-added" })).code, "MISMATCH");
  assert.equal(run(DOC.replace("</head>", '<link rel="canonical" href="/x"></head>'), fix("set_canonical", { href: PAGE })).code, "AMBIGUOUS");
  assert.equal(run(DOC, fix("set_canonical", { href: "not a url" })).code, "INVALID");
  assert.equal(run(DOC, fix("set_canonical", { href: "javascript:alert(1)" })).code, "INVALID");
  assert.equal(run(DOC.replace('rel="canonical"', 'rel="alternate canonical"'), fix("set_canonical", { href: PAGE + "/", expected: PAGE })).ok, true); // rel with several tokens
});

test("set_lang: add when absent; refuse when JavaScript sets it; refuse to overwrite silently", () => {
  assert.equal(run(DOC, fix("set_lang", { value: "en-KE", expected: "" })).html.includes('<html lang="en-KE">'), true);
  assert.equal(run('<HTML class="x"><head></head></HTML>', fix("set_lang", { value: "en" })).html, '<HTML lang="en" class="x"><head></head></HTML>');
  assert.equal(run(DOC, fix("set_lang", { value: "en", expected: "en" })).code, "MISMATCH"); // crawler saw lang=en, file has none
  assert.equal(run('<html lang="de"><head></head></html>', fix("set_lang", { value: "en" })).code, "ALREADY_SET");
  assert.equal(run('<html lang="de"><head></head></html>', fix("set_lang", { value: "en", expected: "de" })).html, '<html lang="en"><head></head></html>');
  assert.equal(run(DOC, fix("set_lang", { value: "english" })).code, "INVALID");
  assert.equal(run("<div>fragment</div>", fix("set_lang", { value: "en" })).code, "NO_HTML_TAG");
});

test("add_image_alt: only images that have NO alt attribute (alt='' means decorative and is left alone)", () => {
  const html = '<body><img src="/a.png"><img src="/a.png" alt=""><img src="/b.png" /><img class="x" src="/a.png"/></body>';
  const r = run(html, fix("add_image_alt", { src: "/a.png", alt: 'A "cat"' }));
  assert.equal(r.ok, true);
  assert.equal(r.html, '<body><img src="/a.png" alt="A &quot;cat&quot;"><img src="/a.png" alt=""><img src="/b.png" /><img class="x" src="/a.png" alt="A &quot;cat&quot;"/></body>');
  assert.match(r.note, /2 image tags/);
  assert.equal(run('<img src="/a.png" alt="">', fix("add_image_alt", { src: "/a.png", alt: "x" })).code, "ALREADY_HAS_ALT");
  assert.equal(run(html, fix("add_image_alt", { src: "/zzz.png", alt: "x" })).code, "NOT_FOUND");
  assert.equal(run(html, fix("add_image_alt", { src: "/a.png", alt: " " })).code, "INVALID");
});

test("add_jsonld: inserts pretty-printed markup; refuses duplicates and JavaScript-injected markup; escapes </script", () => {
  const org = { "@context": "https://schema.org", "@type": "Organization", name: "Acme </script>", url: "https://a.com" };
  const r = run(DOC, fix("add_jsonld", { json: org, expectedTypes: [] }));
  assert.equal(r.ok, true);
  assert.match(r.html, /<head>\n  <script type="application\/ld\+json">\n    \{\n      "@context": "https:\/\/schema.org",/);
  assert.ok(!r.html.includes("Acme </script>") && r.html.includes("Acme <\\/script>"), "closing script tag escaped");
  const parsed = JSON.parse(r.html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]); assert.equal(parsed.name, "Acme </script>");
  assert.equal(run(r.html, fix("add_jsonld", { json: org })).code, "DUPLICATE_TYPE");
  assert.equal(run(DOC, fix("add_jsonld", { json: { ...org }, expectedTypes: ["Organization"] })).code, "MISMATCH"); // crawler saw it, file doesn't have it
  assert.equal(run(DOC, fix("add_jsonld", { json: "{bad json" })).code, "INVALID");
  assert.equal(run(DOC, fix("add_jsonld", { json: { "@type": "Thing" } })).code, "INVALID"); // no @context
  assert.equal(run(DOC, fix("add_jsonld", { json: { "@context": "https://schema.org" } })).code, "INVALID"); // no @type
  assert.equal(run("<html><body></body></html>", fix("add_jsonld", { json: org })).code, "NO_HEAD");
  const graph = { "@context": "https://schema.org", "@graph": [{ "@type": "WebSite", name: "A" }] };
  assert.equal(run(r.html, fix("add_jsonld", { json: graph })).ok, true); // a different type is fine
});

test("remove_noindex: drops the token, deletes an emptied tag with its line, refuses header-based noindex", () => {
  const withMeta = DOC.replace("</head>", '  <meta name="robots" content="noindex, follow">\n</head>');
  assert.ok(run(withMeta, fix("remove_noindex")).html.includes('<meta name="robots" content="follow">'));
  const only = DOC.replace("</head>", '  <meta name="robots" content="noindex">\n</head>');
  assert.equal(run(only, fix("remove_noindex")).html, DOC);
  assert.ok(run(DOC.replace("</head>", '<meta name="robots" content="none"></head>'), fix("remove_noindex")).html.includes('content="nofollow"'));
  assert.equal(run(DOC.replace("</head>", '<meta name="googlebot" content="NOINDEX,nosnippet"></head>'), fix("remove_noindex")).html.includes('content="nosnippet"'), true);
  const r = run(DOC, fix("remove_noindex")); assert.equal(r.code, "NOT_FOUND"); assert.match(r.message, /X-Robots-Tag header/);
});

test("replace_href: absolute and root-relative links are rewritten, relative ones are left for a human, fragments kept", () => {
  const html = `<a href="https://a.com/old">1</a> <a href='/old/'>2</a> <a href="https://a.com/old#top">3</a> <a href="old.html">4</a> <a href="https://a.com/other">5</a> <a href="#x">6</a>`;
  const r = run(html, fix("replace_href", { from: "https://a.com/old", to: "https://a.com/new" }));
  assert.equal(r.ok, true);
  assert.equal(r.html, `<a href="https://a.com/new">1</a> <a href='/new'>2</a> <a href="https://a.com/new#top">3</a> <a href="old.html">4</a> <a href="https://a.com/other">5</a> <a href="#x">6</a>`);
  assert.match(r.note, /Updated 3 links/);
  const other = run(`<a href="/old">x</a>`, fix("replace_href", { from: "https://a.com/old", to: "https://b.com/elsewhere" }));
  assert.equal(other.html, `<a href="https://b.com/elsewhere">x</a>`); // different site -> absolute
  assert.equal(run(`<a href="old.html">x</a>`, { id: "f", kind: "replace_href", pageUrl: "https://a.com/", from: "https://a.com/old.html", to: "https://a.com/new.html" }, { pageUrl: "https://a.com/" }).code, "RELATIVE_ONLY");
  assert.equal(run(`<a href="/zzz">x</a>`, fix("replace_href", { from: "https://a.com/old", to: "https://a.com/new" })).code, "NOT_FOUND");
  assert.equal(run(html, fix("replace_href", { from: "https://a.com/old", to: "https://a.com/old/" })).code, "NO_CHANGE");
  assert.equal(run(html, fix("replace_href", { from: "nope", to: "https://a.com/new" })).code, "INVALID");
});

test("files: robots.txt and sitemap.xml are built safely", () => {
  const r = buildFileFix({ kind: "create_robots_txt", sitemapUrl: "https://a.com/sitemap.xml" }, { siteUrl: "https://a.com/x" });
  assert.equal(r.content, "User-agent: *\nAllow: /\n\nSitemap: https://a.com/sitemap.xml\n"); assert.equal(r.path, "robots.txt");
  assert.equal(buildFileFix({ kind: "create_robots_txt" }, { siteUrl: "https://a.com" }).content, "User-agent: *\nAllow: /\n");
  assert.equal(buildFileFix({ kind: "create_robots_txt", sitemapUrl: "https://evil.com/s.xml" }, { siteUrl: "https://a.com" }).ok, false);
  const s = buildFileFix({ kind: "create_sitemap_xml", urls: ["https://a.com/b", "https://a.com/a?x=1&y=2", "https://a.com/b#frag", "https://evil.com/c", "javascript:x", "nonsense"] }, { siteUrl: "https://a.com" });
  assert.equal(s.ok, true); assert.equal(s.path, "sitemap.xml");
  assert.deepEqual([...s.content.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]), ["https://a.com/a?x=1&amp;y=2", "https://a.com/b"]);
  assert.equal(buildFileFix({ kind: "create_sitemap_xml", urls: ["https://evil.com/"] }, { siteUrl: "https://a.com" }).ok, false);
});

test("validateFix keeps only known fields and rejects hostile input", () => {
  const site = { siteUrl: "a.com" };
  const good = validateFix({ id: "x", kind: "set_title", pageUrl: "https://www.a.com/p", value: "T", expected: "O", evil: "<script>", __proto__: { polluted: 1 } }, site);
  assert.equal(good.ok, true); assert.deepEqual(good.fix, { id: "x", kind: "set_title", pageUrl: "https://www.a.com/p", value: "T", expected: "O" });
  assert.equal({}.polluted, undefined);
  for (const bad of [null, "str", { id: "x", kind: "rm_rf", pageUrl: "https://a.com/" }, { kind: "set_title", pageUrl: "https://a.com/", value: "T" },
    { id: "x", kind: "set_title", pageUrl: "https://evil.com/p", value: "T" }, { id: "x", kind: "set_title", pageUrl: "file:///etc/passwd", value: "T" },
    { id: "x", kind: "set_title", pageUrl: "https://a.com/", value: "x".repeat(301) }, { id: "x", kind: "set_title", pageUrl: "https://a.com/", value: "" },
    { id: "x", kind: "create_sitemap_xml", urls: [] }, { id: "x", kind: "replace_href", pageUrl: "https://a.com/", from: "a" }, { id: "x", kind: "add_image_alt", pageUrl: "https://a.com/", src: "s" }]) {
    assert.equal(validateFix(bad, site).ok, false, JSON.stringify(bad)?.slice(0, 60));
  }
  assert.equal(validateFix({ id: "r", kind: "create_robots_txt" }, site).ok, true); // file fixes need no pageUrl
});
