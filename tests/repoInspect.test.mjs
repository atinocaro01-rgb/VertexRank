import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTree, pageUrlToFile, unsupportedAdvice } from "../lib/repoInspect.js";

const tree = (...paths) => paths.map((path) => ({ path, type: "blob" }));

test("plain HTML repo is allowed and its web root is found", () => {
  const r = analyzeTree(tree("index.html", "about.html", "css/site.css", "js/site.js", "img/a.png", "README.md", "CNAME"));
  assert.equal(r.verdict, "plain-html"); assert.equal(r.allowed, true); assert.equal(r.htmlCount, 2); assert.equal(r.siteRoots[0].path, "");
});

test("tooling next to HTML is allowed with a warning; workflows add a heads-up", () => {
  const r = analyzeTree(tree("index.html", "package.json", "gulpfile.js", ".github/workflows/deploy.yml"));
  assert.equal(r.verdict, "html-with-tooling"); assert.equal(r.allowed, true); assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /build step/); assert.match(r.warnings[1], /GitHub Actions/);
});

test("frameworks, generators, WordPress, PHP and empty repos are refused, each with its own reason", () => {
  const cases = [
    [tree("package.json", "next.config.js", "pages/index.js", "public/index.html"), "framework"],
    [tree("src/App.jsx", "src/Nav.jsx", "src/Foot.jsx", "index.html", "package.json"), "framework"],
    [tree("_config.yml", "index.html", "_layouts/default.html"), "static-generator"],
    [tree("hugo.toml", "content/a.md", "layouts/index.html"), "static-generator"],
    [tree("a.njk", "b.njk", "index.html"), "static-generator"],
    [tree("wp-config.php", "wp-content/themes/x/index.php", "index.php"), "wordpress"],
    [tree("index.php", "a.php", "b.php", "index.html"), "php"],
    [tree("README.md", "notes.txt"), "empty"],
  ];
  for (const [entries, verdict] of cases) { const r = analyzeTree(entries); assert.equal(r.verdict, verdict, verdict); assert.equal(r.allowed, false); assert.ok(r.reasons.length > 0); assert.ok(unsupportedAdvice(verdict).length > 20, verdict); }
  assert.equal(analyzeTree(tree("config.json", "index.html")).verdict, "plain-html"); // a bare config.json isn't a generator
});

test("node_modules, vendor and .git never count as site files", () => {
  const r = analyzeTree(tree("index.html", "node_modules/pkg/README.html", "node_modules/x/index.html", "vendor/a/index.html", ".git/x.html"));
  assert.equal(r.htmlCount, 1);
});

test("web-root candidates: common folders first, build output demoted and flagged", () => {
  const r = analyzeTree(tree("docs/index.html", "docs/a.html", "docs/b.html", "dist/index.html", "dist/x.html", "dist/y.html", "dist/z.html"));
  assert.equal(r.siteRoots[0].path, "docs"); assert.equal(r.siteRoots.find((x) => x.path === "dist").generated, true);
  const onlyDist = analyzeTree(tree("dist/index.html", "dist/a.html"));
  assert.equal(onlyDist.siteRoots[0].generated, true); assert.ok(onlyDist.warnings.some((w) => /build output/.test(w)));
  assert.deepEqual(analyzeTree(tree("a/b/c.html")).siteRoots, []); // no index.html anywhere -> no candidate
  assert.equal(analyzeTree(null).verdict, "empty");
});

test("pageUrlToFile mirrors static-host URL mapping and refuses ambiguity", () => {
  const files = new Set(["index.html", "about.html", "blog/index.html", "contact/index.html", "contact.html", "docs/guide.html", "sub/page.htm", "caf\u00e9.html"]);
  const f = (pageUrl, siteRoot = "") => pageUrlToFile({ pageUrl, siteRoot, htmlFiles: files });
  assert.deepEqual(f("https://a.com/"), { ok: true, path: "index.html" });
  assert.deepEqual(f("https://a.com/about"), { ok: true, path: "about.html" });
  assert.deepEqual(f("https://a.com/about.html?x=1#y"), { ok: true, path: "about.html" });
  assert.deepEqual(f("https://a.com/blog"), { ok: true, path: "blog/index.html" });
  assert.deepEqual(f("https://a.com/blog/"), { ok: true, path: "blog/index.html" });
  assert.deepEqual(f("https://a.com/sub/page"), { ok: true, path: "sub/page.htm" });
  assert.deepEqual(f("https://a.com/caf%C3%A9"), { ok: true, path: "café.html" });
  const amb = f("https://a.com/contact"); assert.equal(amb.ok, false); assert.equal(amb.code, "AMBIGUOUS");
  const miss = f("https://a.com/nope"); assert.equal(miss.code, "NOT_FOUND"); assert.match(miss.message, /may be generated/);
  assert.deepEqual(pageUrlToFile({ pageUrl: "https://a.com/guide", siteRoot: "docs", htmlFiles: files }), { ok: true, path: "docs/guide.html" });
  assert.deepEqual(pageUrlToFile({ pageUrl: "https://a.com/guide", siteRoot: "/docs/", htmlFiles: files }), { ok: true, path: "docs/guide.html" });
  assert.equal(f("https://a.com/%2e%2e/etc/passwd").ok, false); // traversal attempts never map to a file
  assert.equal(f("not a url").code, "INVALID");
});
