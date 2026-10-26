import test from "node:test";
import assert from "node:assert/strict";
import { detectStack, looksClientRendered, collectHtmlMarkers, pickHostHeaders } from "../lib/stackDetector.js";

const page = (o = {}) => ({ url: "https://a.com/", generator: "", scriptSrcs: [], stylesheetHrefs: [], htmlMarkers: [], mounts: [], wordCount: 400, scriptCount: 2, hostHeaders: {}, ...o });
const names = (r) => r.technologies.map((t) => t.name);
const tech = (r, n) => r.technologies.find((t) => t.name === n);

test("no pages -> null", () => { assert.equal(detectStack([]), null); assert.equal(detectStack(null), null); });

test("plain hand-written HTML on GitHub Pages is detected as high-suitability for GitHub fixes", () => {
  const r = detectStack([page({ scriptSrcs: ["/js/site.js"], hostHeaders: { server: "GitHub.com", "x-github-request-id": "ABC" } }), page({ url: "https://a.com/about" })]);
  assert.equal(r.rendering.type, "static-html"); assert.equal(r.github.suitability, "high");
  assert.equal(r.hosting[0].name, "GitHub Pages"); assert.equal(r.hosting[0].confidence, "high");
  assert.equal(r.summary, "Plain HTML · on GitHub Pages"); assert.equal(r.jsRendering.needed, false);
  assert.deepEqual(r.technologies, []);
});

test("jQuery/Bootstrap are libraries, not 'the stack': a jQuery + Bootstrap static site is still plain HTML", () => {
  const r = detectStack([page({ scriptSrcs: ["https://code.jquery.com/jquery-3.7.1.min.js"], stylesheetHrefs: ["/css/bootstrap.min.css"] })]);
  assert.deepEqual(names(r).sort(), ["Bootstrap", "jQuery"]);
  assert.equal(r.rendering.type, "static-html"); assert.equal(r.github.suitability, "high"); assert.equal(r.summary, "Plain HTML");
});

test("WordPress is a CMS: low suitability for GitHub fixes", () => {
  const r = detectStack([page({ generator: "WordPress 6.5", stylesheetHrefs: ["/wp-content/themes/x/style.css"], htmlMarkers: ["wp-block"] })]);
  assert.equal(tech(r, "WordPress").confidence, "high"); assert.equal(r.rendering.type, "platform-rendered");
  assert.equal(r.github.suitability, "low"); assert.match(r.github.why, /not in a GitHub repository/);
  assert.match(r.summary, /^WordPress/);
});

test("Next.js with real content is pre-rendered (no JS-rendering warning), medium suitability", () => {
  const r = detectStack([page({ htmlMarkers: ["__NEXT_DATA__"], scriptSrcs: ["/_next/static/chunks/main.js"], mounts: [{ id: "__next", textLength: 5000 }], hostHeaders: { "x-vercel-id": "x", server: "Vercel" } })]);
  assert.equal(tech(r, "Next.js").confidence, "high"); assert.equal(r.rendering.type, "pre-rendered");
  assert.equal(r.jsRendering.needed, false); assert.equal(r.github.suitability, "medium"); assert.equal(r.summary, "Next.js · on Vercel");
});

test("a Create-React-App / Vite style SPA: empty #root + scripts is flagged as client-rendered, with the pages listed", () => {
  const shell = (u) => page({ url: u, wordCount: 3, scriptCount: 2, mounts: [{ id: "root", textLength: 0 }], scriptSrcs: ["/static/js/main.4f3a.js"] });
  const r = detectStack([shell("https://a.com/"), shell("https://a.com/about"), shell("https://a.com/contact")]);
  assert.equal(r.rendering.type, "client-rendered"); assert.equal(r.jsRendering.needed, true); assert.equal(r.jsRendering.pages.length, 3);
  assert.match(r.jsRendering.note, /3 of 3 crawled pages.*does not run JavaScript/);
  assert.ok(names(r).includes("React")); assert.match(r.summary, /renders in the browser/);
});

test("mixed: some shells among real pages", () => {
  const real = (u) => page({ url: u });
  const shell = page({ url: "https://a.com/app", wordCount: 2, mounts: [{ id: "app", textLength: 0 }] });
  const r = detectStack([real("https://a.com/"), real("https://a.com/b"), real("https://a.com/c"), shell]);
  assert.equal(r.rendering.type, "mixed"); assert.deepEqual(r.jsRendering.pages, ["https://a.com/app"]); assert.equal(r.jsRendering.needed, true);
});

test("looksClientRendered needs an empty mount AND little text AND scripts — a short plain page is not flagged", () => {
  assert.equal(looksClientRendered({ mounts: [{ id: "root", textLength: 0 }], wordCount: 5, scriptCount: 1 }), true);
  assert.equal(looksClientRendered({ mounts: [], wordCount: 5, scriptCount: 3 }), false); // photo page, no mount point
  assert.equal(looksClientRendered({ mounts: [{ id: "root", textLength: 0 }], wordCount: 300, scriptCount: 1 }), false);
  assert.equal(looksClientRendered({ mounts: [{ id: "root", textLength: 0 }], wordCount: 5, scriptCount: 0 }), false);
  assert.equal(looksClientRendered({ mounts: [{ id: "app", textLength: 900 }], wordCount: 5, scriptCount: 1 }), false);
  assert.equal(looksClientRendered(null), false);
});

test("static site generators are medium suitability; weak hints alone don't name a framework", () => {
  const hugo = detectStack([page({ generator: "Hugo 0.120.0" })]);
  assert.equal(hugo.rendering.type, "static-generated"); assert.equal(hugo.github.suitability, "medium"); assert.equal(hugo.summary, "Hugo");
  const weak = detectStack([page({ mounts: [{ id: "root", textLength: 800 }] })]); // a #root div alone says nothing
  assert.deepEqual(names(weak), []); assert.equal(weak.github.suitability, "high");
});

test("builders (Wix, Squarespace, Webflow, Shopify) are low suitability", () => {
  for (const [signals, name] of [[{ generator: "Wix.com Website Builder" }, "Wix"], [{ generator: "Squarespace" }, "Squarespace"], [{ htmlMarkers: ["data-wf-page"] }, "Webflow"], [{ scriptSrcs: ["https://cdn.shopify.com/s/x.js"] }, "Shopify"]]) {
    const r = detectStack([page(signals)]); assert.ok(names(r).includes(name), name); assert.equal(r.github.suitability, "low", name);
  }
});

test("hosting: specific hosts beat generic server names; nginx alone is reported; headers come from the first page", () => {
  assert.equal(detectStack([page({ hostHeaders: { server: "nginx" } })]).hosting[0].name, "nginx");
  const both = detectStack([page({ hostHeaders: { server: "nginx", "x-nf-request-id": "1" } })]);
  assert.deepEqual(both.hosting.map((h) => h.name), ["Netlify"]);
  assert.equal(detectStack([page({ hostHeaders: { server: "Vercel" } }), page({ hostHeaders: { server: "nginx" } })]).hosting[0].name, "Vercel");
});

test("collectHtmlMarkers and pickHostHeaders", () => {
  const html = '<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{}</script><div class="wp-block-group"></div></body></html>';
  assert.deepEqual(collectHtmlMarkers(html).sort(), ["__NEXT_DATA__", "wp-block"]);
  assert.deepEqual(collectHtmlMarkers(""), []); assert.deepEqual(collectHtmlMarkers(null), []);
  assert.deepEqual(pickHostHeaders({ server: "nginx", "set-cookie": "secret=1", "x-powered-by": "x".repeat(200) }), { server: "nginx", "x-powered-by": "x".repeat(80) });
});

test("every result says how sure it is", () => {
  const r = detectStack([page({ generator: "Hugo" }), page({ url: "https://a.com/b" })]);
  assert.match(r.basis, /2 crawled pages.*best guess/);
  for (const t of r.technologies) assert.ok(["high", "medium", "low"].includes(t.confidence) && t.evidence.length > 0);
});
