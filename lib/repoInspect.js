// Looks at a repository's file listing and answers the question this whole flow depends on: "is this really a
// plain-HTML site whose HTML files ARE the pages people see?" — and, if so, where its web root is and which file serves
// which URL. Pure functions over a list of paths (no network): unit-tested in tests/repoInspect.test.mjs.
//
// Verdicts:
//   plain-html        HTML files, no build tooling or framework signals           -> allowed
//   html-with-tooling HTML files plus package.json / bundler config but no framework -> allowed, with a warning
//   framework         React/Vue/Svelte/Astro/Next/Nuxt/etc. sources or configs      -> not supported yet
//   static-generator  Jekyll/Hugo/Eleventy/MkDocs/Docusaurus or template languages   -> not supported yet
//   wordpress         wp-content / wp-config.php                                     -> not supported
//   php               several PHP files                                              -> not supported
//   empty             no HTML files at all                                           -> nothing to fix
//
// "Not supported yet" is deliberate: in those repos the HTML a visitor sees is OUTPUT, so editing it (if it is even
// committed) would be overwritten by the next build. Even in the allowed cases every individual fix is still verified
// against the file's contents (lib/htmlFixes.js), which is the real safety net for mixed sites.

const HTML_EXT = /\.html?$/i;
const IGNORED_DIR = /(^|\/)(node_modules|\.git|vendor|bower_components|\.next|\.nuxt|\.cache|coverage)(\/|$)/;
const OUTPUT_DIRS = new Set(["dist", "build", "_site", "out", "public_html_build", ".output", "site"]);
const COMMON_WEB_ROOTS = ["", "docs", "public", "www", "html", "web", "static", "src", "site"];

const base = (p) => p.slice(p.lastIndexOf("/") + 1);
const dir = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const depth = (p) => p.split("/").length - 1;

const FRAMEWORK_CONFIG = /^(next|nuxt|vite|astro|svelte|gatsby|remix|vue|angular|ember|solid|qwik)\.config\.[cm]?[jt]s$|^angular\.json$|^gatsby-(config|node)\.[jt]s$|^nuxt\.config\.[jt]s$|^svelte\.config\.js$/i;
const GENERATOR_CONFIG = /^_config\.ya?ml$|^(hugo|config)\.(toml|ya?ml|json)$|^\.eleventy\.js$|^eleventy\.config\.[cm]?js$|^mkdocs\.ya?ml$|^docusaurus\.config\.[jt]s$|^_quarto\.ya?ml$|^antora-playbook\.ya?ml$/i;
const BUNDLER_CONFIG = /^(webpack|rollup|gulpfile|Gruntfile|parcel)\b|^webpack\.config\./i;
const COMPONENT_SRC = /\.(jsx|tsx|vue|svelte|astro)$/i;
const TEMPLATE_SRC = /\.(njk|liquid|hbs|handlebars|ejs|pug|jade|twig|mustache|erb|haml)$/i;

/**
 * entries: [{ path, type: "blob" | "tree" }] as returned by GitHub's git trees API.
 * Returns { verdict, allowed, reasons[], warnings[], counts, htmlCount, siteRoots[] }.
 */
export function analyzeTree(entries) {
  const files = (entries || []).filter((e) => e && e.type === "blob" && typeof e.path === "string" && !IGNORED_DIR.test(e.path)).map((e) => e.path);
  const html = files.filter((p) => HTML_EXT.test(p));
  const names = files.map((p) => ({ path: p, name: base(p), top: depth(p) <= 1 }));

  const count = (re) => files.filter((p) => re.test(p)).length;
  const counts = {
    html: html.length, component: count(COMPONENT_SRC), template: count(TEMPLATE_SRC), php: count(/\.php$/i),
    markdown: count(/\.mdx?$/i), css: count(/\.css$/i), js: count(/\.[cm]?js$/i),
  };
  const configs = (re) => names.filter((f) => f.top && re.test(f.name)).map((f) => f.path);
  const frameworkConfigs = configs(FRAMEWORK_CONFIG);
  const generatorConfigs = configs(GENERATOR_CONFIG).filter((p) => !(base(p) === "config.json" || /^config\.(toml|ya?ml)$/i.test(base(p))) || files.some((f) => /^(content|layouts|archetypes)\//.test(f)));
  const bundlerConfigs = configs(BUNDLER_CONFIG);
  const packageJson = files.some((p) => depth(p) <= 1 && base(p) === "package.json");
  const wordpress = files.some((p) => /(^|\/)wp-content\//.test(p) || /(^|\/)wp-config(-sample)?\.php$/.test(p));
  const workflows = files.filter((p) => /^\.github\/workflows\/.+\.ya?ml$/.test(p));

  const reasons = [];
  const warnings = [];
  let verdict;
  if (wordpress) { verdict = "wordpress"; reasons.push("This is a WordPress installation (wp-content / wp-config.php). Pages live in a database, not in HTML files."); }
  else if (frameworkConfigs.length || counts.component >= 3) {
    verdict = "framework";
    if (frameworkConfigs.length) reasons.push(`Framework configuration found: ${frameworkConfigs.slice(0, 3).join(", ")}.`);
    if (counts.component >= 3) reasons.push(`${counts.component} component source files (.jsx/.tsx/.vue/.svelte/.astro): the HTML visitors see is generated from them.`);
  } else if (generatorConfigs.length || counts.template >= 2) {
    verdict = "static-generator";
    if (generatorConfigs.length) reasons.push(`Static-site-generator configuration found: ${generatorConfigs.slice(0, 3).join(", ")}.`);
    if (counts.template >= 2) reasons.push(`${counts.template} template files (.njk/.liquid/.hbs/.ejs/.pug…): the HTML is generated from them.`);
  } else if (counts.php >= 3) { verdict = "php"; reasons.push(`${counts.php} PHP files: pages are assembled on the server.`); }
  else if (counts.html === 0) { verdict = "empty"; reasons.push("No .html files were found in this repository."); }
  else if (packageJson || bundlerConfigs.length) {
    verdict = "html-with-tooling";
    reasons.push(`${counts.html} HTML file${counts.html === 1 ? "" : "s"} found, alongside ${packageJson ? "a package.json" : ""}${packageJson && bundlerConfigs.length ? " and " : ""}${bundlerConfigs.length ? `build tooling (${bundlerConfigs.slice(0, 2).join(", ")})` : ""}.`);
    warnings.push("There is build tooling in this repository. If a build step rewrites these HTML files before deploying, a fix to the source may not reach the live page. Every fix is checked against what the crawler saw, and mismatches are refused, but review each diff.");
  } else {
    verdict = "plain-html";
    reasons.push(`${counts.html} HTML file${counts.html === 1 ? "" : "s"} and no framework, generator or build tooling detected.`);
  }
  if (workflows.length && (verdict === "plain-html" || verdict === "html-with-tooling")) {
    warnings.push(`GitHub Actions workflows exist (${workflows.slice(0, 2).join(", ")}). If one builds or transforms the site before deploying, check that it doesn't change the pages VertexRank will edit.`);
  }

  // candidate web roots: every directory that holds an index.html, with how many HTML files live under it
  const roots = new Map();
  for (const p of html) {
    let d = dir(p);
    for (;;) {
      if (!roots.has(d)) roots.set(d, { path: d, htmlCount: 0, hasIndex: false });
      roots.get(d).htmlCount++;
      if (d === "") break;
      d = dir(d);
    }
  }
  for (const p of html) if (/^index\.html?$/i.test(base(p))) { const r = roots.get(dir(p)); if (r) r.hasIndex = true; }
  const siteRoots = [...roots.values()]
    .filter((r) => r.hasIndex)
    .map((r) => ({ ...r, generated: OUTPUT_DIRS.has(base(r.path)) && r.path !== "", common: COMMON_WEB_ROOTS.includes(r.path) }))
    .sort((a, b) => Number(a.generated) - Number(b.generated) || Number(b.common) - Number(a.common) || b.htmlCount - a.htmlCount || a.path.length - b.path.length)
    .slice(0, 8);
  if (siteRoots[0]?.generated) warnings.push(`The best web-root candidate (${siteRoots[0].path}/) looks like build output; edits there are overwritten by the next build.`);

  const allowed = verdict === "plain-html" || verdict === "html-with-tooling";
  return { verdict, allowed, reasons, warnings, counts, htmlCount: html.length, siteRoots };
}

/** Human-readable summary of what to do when a repo isn't supported. */
export function unsupportedAdvice(verdict) {
  return {
    framework: "Fixes for framework projects (Next.js, React, Vue, Svelte, Astro…) belong in components, layouts or metadata configuration and need framework-specific handling, which isn't built yet.",
    "static-generator": "Fixes for static-site-generator projects (Jekyll, Hugo, Eleventy…) belong in templates, front matter or config, not in generated HTML, and aren't supported yet.",
    wordpress: "WordPress keeps pages in a database, so a GitHub pull request can't change page titles or content.",
    php: "PHP sites assemble pages on the server, so the HTML files aren't the whole story. Not supported.",
    empty: "No HTML files were found, so there is nothing to fix in this repository. Check that you picked the right repository and branch.",
  }[verdict] || "";
}

/* ------------------------------------------------------------------ */
/* URL -> file                                                        */
/* ------------------------------------------------------------------ */

/**
 * Finds the file in `htmlFiles` (repo paths) that serves `pageUrl` when `siteRoot` is the web root.
 * Mirrors how static hosts (GitHub Pages, Netlify…) map URLs: "/" -> index.html, "/about" -> about.html or about/index.html,
 * "/about/" -> about/index.html, "/x.html" -> x.html. Refuses when two different files could serve the URL.
 */
export function pageUrlToFile({ pageUrl, siteRoot = "", htmlFiles }) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(pageUrl).pathname); } catch { return { ok: false, code: "INVALID", message: "The page URL isn't valid." }; }
  if (pathname.includes("\\") || pathname.split("/").includes("..")) return { ok: false, code: "INVALID", message: "The page path isn't allowed." };
  const root = String(siteRoot || "").replace(/^\/+|\/+$/g, "");
  const rel = pathname.replace(/^\/+/, "");
  const join = (p) => (root ? (p ? `${root}/${p}` : root) : p);

  let candidates;
  if (rel === "") candidates = [join("index.html"), join("index.htm")];
  else if (pathname.endsWith("/")) { const d = rel.replace(/\/+$/, ""); candidates = [join(`${d}/index.html`), join(`${d}/index.htm`), join(`${d}.html`)]; }
  else if (/\.html?$/i.test(rel)) candidates = [join(rel)];
  else candidates = [join(`${rel}.html`), join(`${rel}.htm`), join(`${rel}/index.html`), join(`${rel}/index.htm`)];

  const set = htmlFiles instanceof Set ? htmlFiles : new Set(htmlFiles);
  const found = [...new Set(candidates)].filter((c) => set.has(c));
  if (found.length === 1) return { ok: true, path: found[0] };
  if (found.length > 1) return { ok: false, code: "AMBIGUOUS", message: `More than one file could serve ${pathname} (${found.join(", ")}); not editing either.`, tried: found };
  return { ok: false, code: "NOT_FOUND", message: `No file in the repository serves ${pathname}${root ? ` under ${root}/` : ""} (looked for ${candidates.slice(0, 3).join(", ")}). The page may be generated, or the web root may be wrong.`, tried: candidates };
}
