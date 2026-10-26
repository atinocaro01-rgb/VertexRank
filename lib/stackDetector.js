// Works out what a website is built with from signals the crawler already sees: the generator meta tag, script and
// stylesheet paths, framework markers in the HTML, response headers, and whether the page content is present in the
// HTML or only appears after JavaScript runs.
//
// Why: the right fix depends on the stack (a plain HTML file, a Next.js component, a WordPress theme), whether the
// crawler can even see the content (client-rendered sites look nearly empty to a crawler that doesn't run
// JavaScript), and whether a GitHub pull request can plausibly change the site at all.
//
// This is a FINGERPRINT, not a certainty: every detection lists its evidence and a confidence, and "unknown" is a
// valid answer. Pure functions, unit-tested in tests/stackDetector.test.mjs.

/* ------------------------------------------------------------------ */
/* signals collected during the crawl                                 */
/* ------------------------------------------------------------------ */

// [marker name, text that proves it is in the HTML]
const HTML_MARKERS = [
  ["__NEXT_DATA__", /id=["']__NEXT_DATA__["']/],
  ["__NUXT__", /window\.__NUXT__|id=["']__nuxt["']/],
  ["___gatsby", /id=["']___gatsby["']/],
  ["astro-island", /<astro-island|astro-island/],
  ["data-sveltekit", /data-sveltekit/],
  ["__remixContext", /__remixContext/],
  ["ng-version", /\bng-version=/],
  ["data-reactroot", /data-reactroot/],
  ["data-v-", /\bdata-v-[0-9a-f]{6,}/],
  ["data-wf-page", /data-wf-page=/],
  ["Shopify.theme", /Shopify\.theme|cdn\.shopify\.com/],
  ["wp-block", /wp-block-|wp-content\//],
];

/** Which framework/CMS markers appear in the first 400 KB of a page's HTML. */
export function collectHtmlMarkers(html) {
  const text = String(html || "").slice(0, 400_000);
  return HTML_MARKERS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

const HEADER_KEYS = ["server", "x-powered-by", "x-generator", "via", "x-github-request-id", "x-vercel-id", "x-nf-request-id", "cf-ray", "x-amz-cf-id", "x-served-by", "fly-request-id"];
/** The few response headers that reveal hosting/platform, trimmed (the crawler stores this on each page). */
export function pickHostHeaders(headers) {
  const out = {};
  for (const k of HEADER_KEYS) if (headers?.[k]) out[k] = String(headers[k]).slice(0, 80);
  return out;
}

/* ------------------------------------------------------------------ */
/* technology fingerprints                                            */
/* ------------------------------------------------------------------ */

const has = (list, ...needles) => list.some((s) => needles.some((n) => s.includes(n)));
const gen = (re) => (ctx) => ctx.generators.some((g) => re.test(g));
const script = (...n) => (ctx) => has(ctx.scripts, ...n);
const style = (...n) => (ctx) => has(ctx.styles, ...n);
const asset = (...n) => (ctx) => has(ctx.scripts, ...n) || has(ctx.styles, ...n);
const marker = (m) => (ctx) => ctx.markers.has(m);
const mount = (id) => (ctx) => ctx.mounts.has(id);
const header = (key, re) => (ctx) => re.test(ctx.headers[key] || "");

// weight 3 = conclusive on its own; 2 = strong; 1 = weak hint. Confidence: >=3 high, 2 medium, 1 low.
const TECH = [
  { name: "WordPress", kind: "cms", signals: [["generator tag says WordPress", gen(/wordpress/), 3], ["assets from /wp-content/ or /wp-includes/", asset("/wp-content/", "/wp-includes/"), 3], ["WordPress block classes", marker("wp-block"), 1]] },
  { name: "Shopify", kind: "cms", signals: [["assets from cdn.shopify.com", (c) => has(c.scripts, "cdn.shopify.com") || has(c.styles, "cdn.shopify.com") || c.markers.has("Shopify.theme"), 3], ["generator tag says Shopify", gen(/shopify/), 3]] },
  { name: "Wix", kind: "builder", signals: [["generator tag says Wix", gen(/wix\.com/), 3], ["assets from Wix domains", asset("parastorage.com", "wixstatic.com"), 3]] },
  { name: "Squarespace", kind: "builder", signals: [["generator tag says Squarespace", gen(/squarespace/), 3], ["assets from squarespace.com", asset("squarespace.com", "squarespace-cdn.com"), 2]] },
  { name: "Webflow", kind: "builder", signals: [["generator tag says Webflow", gen(/webflow/), 3], ["data-wf-page attribute", marker("data-wf-page"), 3], ["assets from website-files.com", asset("website-files.com"), 2]] },
  { name: "Ghost", kind: "cms", signals: [["generator tag says Ghost", gen(/^ghost/), 3]] },
  { name: "Next.js", kind: "framework", signals: [["__NEXT_DATA__ in the HTML", marker("__NEXT_DATA__"), 3], ["scripts from /_next/static/", script("/_next/static/"), 3], ["X-Powered-By: Next.js", header("x-powered-by", /next\.js/i), 3]] },
  { name: "Nuxt", kind: "framework", signals: [["__NUXT__ in the HTML", marker("__NUXT__"), 3], ["scripts from /_nuxt/", script("/_nuxt/"), 3]] },
  { name: "Gatsby", kind: "static-generator", signals: [["generator tag says Gatsby", gen(/gatsby/), 3], ["___gatsby mount point", marker("___gatsby"), 3]] },
  { name: "Astro", kind: "static-generator", signals: [["generator tag says Astro", gen(/astro/), 3], ["astro-island elements", marker("astro-island"), 3], ["assets from /_astro/", asset("/_astro/"), 3]] },
  { name: "SvelteKit", kind: "framework", signals: [["scripts from /_app/immutable/", script("/_app/immutable/"), 3], ["data-sveltekit attributes", marker("data-sveltekit"), 3]] },
  { name: "Remix", kind: "framework", signals: [["__remixContext in the HTML", marker("__remixContext"), 3]] },
  { name: "Angular", kind: "framework", signals: [["ng-version attribute", marker("ng-version"), 3]] },
  { name: "Vue", kind: "framework", signals: [["scoped data-v-… attributes", marker("data-v-"), 2], ["a Vue script bundle", script("vue.min.js", "vue.global", "/vue."), 2], ["#app mount point", mount("app"), 1]] },
  { name: "React", kind: "framework", signals: [["data-reactroot attribute", marker("data-reactroot"), 3], ["a React script bundle", script("react.production", "react-dom", "/static/js/main."), 2], ["#root mount point", mount("root"), 1]] },
  { name: "Vite build", kind: "tooling", signals: [["bundled /assets/index-….js", (c) => c.scripts.some((s) => /\/assets\/index-[\w-]{6,}\.js/.test(s)), 2]] },
  { name: "Hugo", kind: "static-generator", signals: [["generator tag says Hugo", gen(/^hugo/), 3]] },
  { name: "Jekyll", kind: "static-generator", signals: [["generator tag says Jekyll", gen(/jekyll/), 3]] },
  { name: "Eleventy", kind: "static-generator", signals: [["generator tag says Eleventy", gen(/eleventy|^11ty/), 3]] },
  { name: "Docusaurus", kind: "static-generator", signals: [["generator tag says Docusaurus", gen(/docusaurus/), 3]] },
  { name: "MkDocs", kind: "static-generator", signals: [["generator tag says MkDocs", gen(/mkdocs/), 3]] },
  { name: "Hexo", kind: "static-generator", signals: [["generator tag says Hexo", gen(/hexo/), 3]] },
  { name: "jQuery", kind: "library", signals: [["a jQuery script", script("jquery"), 3]] },
  { name: "Bootstrap", kind: "library", signals: [["a Bootstrap stylesheet or script", asset("bootstrap"), 3]] },
];

const HOSTING = [
  { name: "GitHub Pages", signals: [["server: GitHub.com", header("server", /github\.com/i), 3], ["x-github-request-id header", (c) => !!c.headers["x-github-request-id"], 3]] },
  { name: "Netlify", signals: [["server: Netlify", header("server", /netlify/i), 3], ["x-nf-request-id header", (c) => !!c.headers["x-nf-request-id"], 3]] },
  { name: "Vercel", signals: [["server: Vercel", header("server", /vercel/i), 3], ["x-vercel-id header", (c) => !!c.headers["x-vercel-id"], 3]] },
  { name: "Cloudflare (CDN or Pages)", signals: [["server: cloudflare", header("server", /cloudflare/i), 2], ["cf-ray header", (c) => !!c.headers["cf-ray"], 2]] },
  { name: "AWS (CloudFront / S3)", signals: [["x-amz-cf-id header", (c) => !!c.headers["x-amz-cf-id"], 3], ["via: CloudFront", header("via", /cloudfront/i), 3], ["server: AmazonS3", header("server", /amazons3/i), 3]] },
  { name: "Fly.io", signals: [["fly-request-id header", (c) => !!c.headers["fly-request-id"], 3]] },
  { name: "nginx", signals: [["server: nginx", header("server", /nginx/i), 1]] },
  { name: "Apache", signals: [["server: Apache", header("server", /apache/i), 1]] },
];

function score(def, ctx) {
  const hits = def.signals.filter(([, test]) => test(ctx));
  if (hits.length === 0) return null;
  const total = hits.reduce((n, h) => n + h[2], 0);
  return { name: def.name, kind: def.kind, confidence: total >= 3 ? "high" : total === 2 ? "medium" : "low", evidence: hits.map((h) => h[0]) };
}

/* ------------------------------------------------------------------ */
/* rendering                                                          */
/* ------------------------------------------------------------------ */

/**
 * Does this page look like an empty shell that fills itself in with JavaScript? True only when there is an app
 * mount point with almost no text in it AND the page as a whole has almost no text AND scripts are present. A short
 * page with no mount point (a photo page, say) is NOT flagged.
 */
export function looksClientRendered(page) {
  const mounts = Array.isArray(page?.mounts) ? page.mounts : [];
  const emptyMount = mounts.some((m) => (m.textLength || 0) < 100);
  return emptyMount && (page?.wordCount || 0) < 50 && (page?.scriptCount || 0) >= 1;
}

const FRAMEWORK_PRERENDER = new Set(["Next.js", "Nuxt", "SvelteKit", "Remix", "Astro", "Gatsby"]);

/* ------------------------------------------------------------------ */
/* the detector                                                       */
/* ------------------------------------------------------------------ */

/**
 * pages: crawled pages carrying { generator, scriptSrcs, stylesheetHrefs, htmlMarkers, mounts, wordCount, scriptCount, hostHeaders, url }.
 * Returns { summary, rendering, technologies, hosting, jsRendering, github } — see the field comments below.
 */
export function detectStack(pages) {
  const list = Array.isArray(pages) ? pages.filter(Boolean) : [];
  if (list.length === 0) return null;

  const ctx = {
    generators: [...new Set(list.map((p) => String(p.generator || "").trim().toLowerCase()).filter(Boolean))],
    scripts: [...new Set(list.flatMap((p) => p.scriptSrcs || []).map((s) => String(s).toLowerCase()))],
    styles: [...new Set(list.flatMap((p) => p.stylesheetHrefs || []).map((s) => String(s).toLowerCase()))],
    markers: new Set(list.flatMap((p) => p.htmlMarkers || [])),
    mounts: new Set(list.flatMap((p) => (p.mounts || []).map((m) => m.id))),
    headers: Object.assign({}, ...list.map((p) => p.hostHeaders || {}).reverse()), // earlier pages win
  };

  const found = TECH.map((t) => score(t, ctx)).filter(Boolean);
  // A bare #root/#app mount point alone (confidence "low") is too weak to name a framework by itself.
  const technologies = found.filter((t) => !(t.confidence === "low" && (t.name === "React" || t.name === "Vue")));
  const hosting = HOSTING.map((h) => score(h, ctx)).filter(Boolean)
    // nginx/Apache only mean something when nothing more specific was found
    .filter((h, _i, all) => !(["nginx", "Apache"].includes(h.name) && all.some((o) => !["nginx", "Apache"].includes(o.name))));

  // rendering
  const clientPages = list.filter(looksClientRendered);
  const share = clientPages.length / list.length;
  const kinds = new Set(technologies.map((t) => t.kind));
  const prerendering = technologies.some((t) => FRAMEWORK_PRERENDER.has(t.name));
  let type;
  if (share >= 0.5) type = "client-rendered";
  else if (clientPages.length > 0) type = "mixed";
  else if (kinds.has("cms") || kinds.has("builder")) type = "platform-rendered";
  else if (prerendering) type = "pre-rendered";
  else if (kinds.has("static-generator")) type = "static-generated";
  else if (technologies.some((t) => ["framework"].includes(t.kind))) type = "unknown-framework-rendering";
  else type = "static-html";

  const RENDER_LABEL = {
    "client-rendered": "Renders in the browser (content appears after JavaScript runs)",
    mixed: "Some pages render in the browser",
    "platform-rendered": "Rendered by the platform on the server",
    "pre-rendered": "Pre-rendered HTML (framework)",
    "static-generated": "Generated static HTML",
    "unknown-framework-rendering": "JavaScript framework (rendering unclear)",
    "static-html": "Plain HTML",
  };

  const jsNeeded = type === "client-rendered" || type === "mixed";
  const jsRendering = {
    needed: jsNeeded,
    pages: clientPages.map((p) => p.url).slice(0, 10),
    note: jsNeeded
      ? `${clientPages.length} of ${list.length} crawled pages look like empty shells that fill in with JavaScript. VertexRank reads the HTML as served and does not run JavaScript, so its content, headings, links and schema findings for these pages may be incomplete or wrong.`
      : "Content is present in the HTML as served, so the crawl sees what search engines see on first load.",
  };

  // can a GitHub pull request change this site?
  const primary = technologies.find((t) => ["cms", "builder"].includes(t.kind)) || technologies.find((t) => ["static-generator", "framework"].includes(t.kind)) || null;
  let github;
  if (primary && ["cms", "builder"].includes(primary.kind)) {
    github = { suitability: "low", why: `${primary.name} stores your pages and content in the platform, not in a GitHub repository (at most your theme is in one), so pull requests can't change page titles, descriptions or content.` };
  } else if (primary) {
    github = { suitability: "medium", why: `Built with ${primary.name}: fixes belong in templates, components or metadata configuration rather than in HTML files, so each fix type needs framework-specific handling.` };
  } else if (type === "static-html") {
    github = { suitability: "high", why: "No framework or CMS detected and the content is in the HTML: fixes can usually be direct edits to HTML files in the repository." };
  } else {
    github = { suitability: "unknown", why: "The build tooling couldn't be identified from the pages alone. Look at the repository (package.json, config files) to be sure." };
  }

  const names = technologies.filter((t) => t.kind !== "library" && t.kind !== "tooling" && t.confidence !== "low").map((t) => t.name);
  const lead = names.length ? names.join(" + ") : RENDER_LABEL[type] === "Plain HTML" ? "Plain HTML" : RENDER_LABEL[type];
  const summary = [lead, hosting[0] ? `on ${hosting[0].name}` : null, jsNeeded ? "renders in the browser" : null].filter(Boolean).join(" · ");

  return {
    summary,
    rendering: { type, label: RENDER_LABEL[type], clientRenderedPages: clientPages.length, pagesChecked: list.length },
    technologies, // [{ name, kind, confidence, evidence[] }] — libraries and tooling included, labelled by kind
    hosting, // [{ name, kind?, confidence, evidence[] }]
    jsRendering, // { needed, pages[], note }
    github, // { suitability: high | medium | low | unknown, why }
    basis: `Fingerprinted from ${list.length} crawled page${list.length === 1 ? "" : "s"} — a best guess, not a guarantee.`,
  };
}
