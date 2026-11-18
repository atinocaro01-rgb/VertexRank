// The 2026 SEO Playbook scorecard: six groups (Technical, On-Page, Local, Content, Off-Page, Advanced), every item either CHECKED
// from your saved data or ticked by you, with an honest status for each (pure, client-safe). Tests: tests/playbook.test.mjs.
//
// Statuses: pass (looks good), warn (partly), fail (clearly a problem), todo (not done yet), unknown (can't be measured yet:
// needs a crawl, Search Console or a re-crawl), na (you marked it not applicable). Score = (pass + half of warn) / measured items;
// unknown and not-applicable items are left out of the score rather than counted as good or bad. Nothing here predicts rankings.

import { computeAuditIssuesForMarket } from "./auditIssues.js";
import { runLocalChecks, checklistProgress } from "./localSeo.js";
import { refreshCandidates } from "./contentRefresh.js";
import { keywordPlacementFindings, topQueryByPage } from "./playbookChecks.js";
import { weakVitals } from "./pagespeed.js";

export const PLAYBOOK_GROUPS = [
  { id: "setup", title: "Setup & tracking", view: "search" },
  { id: "technical", title: "Technical SEO", view: "audit" },
  { id: "onpage", title: "On-Page SEO", view: "audit" },
  { id: "local", title: "Local SEO", view: "local" },
  { id: "content", title: "Content SEO", view: "content" },
  { id: "offpage", title: "Off-Page SEO", view: "backlinks" },
  { id: "advanced", title: "Advanced SEO", view: "competitors" },
  { id: "ai", title: "AI search", view: "geo" },
];

const POINTS = { pass: 1, warn: 0.5, fail: 0, todo: 0 };
const plural = (n, a, b) => (n === 1 ? a : b);
const NEEDS_CRAWL = "Run a site crawl first.";
const urlsOf = (list) => [...new Set((list || []).map((x) => (typeof x === "string" ? x : x?.url)).filter(Boolean))].slice(0, 25);

/** Share-based status: none bad = pass, up to 20% of pages = warn, more = fail. `bad` is a list of pages/URLs (or a count). */
function share(bad, total, what) {
  const list = Array.isArray(bad) ? urlsOf(bad) : [];
  const count = Array.isArray(bad) ? new Set(bad.map((x) => (typeof x === "string" ? x : x?.url))).size : bad;
  if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
  if (count === 0) return { status: "pass", detail: `None of the ${total} crawled pages ${what}.` };
  return { status: count / total <= 0.2 ? "warn" : "fail", detail: `${count} of ${total} crawled ${plural(total, "page", "pages")} ${what}.`, urls: list };
}

function progress(state, groupId, label) {
  const p = checklistProgress(state, groupId);
  return { status: p.done === p.total ? "pass" : p.done > 0 ? "warn" : "todo", detail: `${p.done} of ${p.total} ${label} ticked in Local SEO.` };
}

const normKey = (u) => { try { const x = new URL(u); return `${x.host.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`.toLowerCase(); } catch { return String(u || ""); } };
/** Click depth of every crawled page from the homepage, following the internal links the crawler recorded. Unreachable pages are left out. */
export function clickDepths(pages, startUrl) {
  const byKey = new Map(pages.map((p) => [normKey(p.url), p]));
  const home = byKey.get(normKey(startUrl)) || pages[0];
  if (!home) return new Map();
  const depth = new Map([[home.url, 0]]);
  const queue = [home];
  while (queue.length) {
    const cur = queue.shift();
    for (const l of cur.internalLinkUrls || []) {
      const next = byKey.get(normKey(l));
      if (next && !depth.has(next.url)) { depth.set(next.url, depth.get(cur.url) + 1); queue.push(next); }
    }
  }
  return depth;
}

/**
 * Builds every playbook item's status from one website's saved data. `marks` = { [itemId]: "done" | "na" } set by the owner.
 * Every item also carries `how` (plain steps to fix it), `urls` (affected pages when known) and `rec`, ready for Generate fix or the
 * Action Center, so any item that isn't passing can be acted on straight from the scorecard.
 */
export function evaluatePlaybook(b, { country = "Worldwide" } = {}) {
  const crawl = b?.siteCrawl || null;
  const pages = Array.isArray(crawl?.pages) ? crawl.pages : [];
  const total = pages.length;
  const sw = crawl?.siteWide || {};
  const gsc = b?.gscReport || null;
  const issues = total ? computeAuditIssuesForMarket(crawl, country, { gscReport: gsc }) : [];
  const issuesLike = (re) => issues.filter((i) => re.test(i.title) || re.test(i.id || ""));
  const issueById = (...ids) => issues.filter((i) => ids.includes(i.id));
  const pagesWith = (re) => pages.filter((p) => (p.issues || []).some((i) => re.test(i.title)));
  const signal = (key) => pages.some((p) => p[key] !== undefined);
  const marks = b?.playbookMarks || {};
  const ticks = b?.localChecklist || {};
  const local = total ? runLocalChecks(crawl, b?.localProfile) : { checks: [], areas: [], needsProfile: false };
  const localCheck = (id) => local.checks.find((c) => c.id === id);
  const speed = (b?.pageSpeed || []).filter((r) => r.strategy === "mobile");
  const speedAll = speed.length ? speed : (b?.pageSpeed || []);
  const submitted = (re) => (b?.backlinks || []).filter((x) => x.status === "Submitted" && (!re || re.test(x.type || ""))).length;
  const home = pages.find((p) => normKey(p.url) === normKey(crawl?.startUrl)) || pages[0];
  const crawlOnly = (fn) => (total ? fn() : { status: "unknown", detail: NEEDS_CRAWL });

  const A = (id, text, fn, how, type = "Technical Fix", view) => ({ id, text, auto: true, fn, how, type, view });
  const M = (id, text, how, type = "Content Update", view) => ({ id, text, auto: false, how, type, view });

  const defs = {
    setup: [
      A("s_gsc", "Set up Google Search Console", () => (gsc?.totals || gsc?.queries?.length ? { status: "pass", detail: `Connected${gsc.property ? ` (${gsc.property})` : ""}.` } : { status: "todo", detail: "Not connected yet." }),
        "Open Search data and connect Google Search Console for this site. It's free and shows the real queries, clicks and positions Google reports.", "Technical Fix", "search"),
      M("s_bing", "Set up Bing Webmaster Tools", "Sign in at Bing Webmaster Tools, add your site (you can import it from Search Console) and submit your sitemap. Bing also feeds several AI assistants and other search tools.", "Technical Fix"),
      M("s_ga4", "Set up Google Analytics (GA4)", "Create a GA4 property, add the measurement tag to your site (directly or through Google Tag Manager) and confirm visits show in Realtime. Mark the actions that matter (calls, forms, purchases) as key events.", "Technical Fix"),
      M("s_plugin", "Install an SEO plugin (if your site uses a CMS)", "On WordPress or a similar CMS, install one reputable SEO plugin (for example Yoast SEO or Rank Math) to manage titles, meta descriptions, sitemaps and schema. Mark this N/A for custom-coded sites.", "Technical Fix"),
      M("s_submit", "Submit your sitemap in Search Console and Bing", "In Search Console open Sitemaps, add your sitemap URL and check for errors a few days later. Do the same in Bing Webmaster Tools.", "Technical Fix"),
      M("s_manual", "Check manual actions", "In Search Console open Security & Manual actions and read both reports. \"No issues\" is the goal. If there is a manual action, follow Google's steps and send a reconsideration request.", "Technical Fix"),
      A("s_index", "Ensure indexability", () => crawlOnly(() => {
        const hard = issueById("tech_home_noindex", "tech_robots_blocks_search");
        if (hard.length) return { status: "fail", detail: hard[0].title, urls: urlsOf(hard[0].urls) };
        const soft = issueById("tech_noindex_pages", "tech_sitemap_noindex");
        if (soft.length) return { status: "warn", detail: soft[0].title, urls: urlsOf(soft[0].urls) };
        return { status: "pass", detail: "No noindex or robots.txt blocks found on the pages crawled." };
      }), "Remove noindex from pages you want in Google and make sure robots.txt doesn't block them. Confirm each fix with the URL Inspection tool in Search Console.", "Technical Fix", "audit"),
    ],
    technical: [
      A("t_https", "Enable HTTPS", () => crawlOnly(() => {
        const site = issues.find((i) => i.id === "play_https_site"), pg = issues.find((i) => i.id === "play_https_pages"), mixed = pagesWith(/Insecure \(http/);
        if (site) return { status: "fail", detail: "The site was reached over http, not https." };
        if (pg || mixed.length) return { status: "warn", detail: pg ? pg.title : `${mixed.length} ${plural(mixed.length, "page loads", "pages load")} insecure (http) resources.`, urls: urlsOf(pg ? pg.urls : mixed) };
        return { status: "pass", detail: "Crawled pages are served over https with no mixed content found." };
      }), "Install an SSL certificate (most hosts include a free one), 301-redirect every http:// URL to https://, and update internal links, canonicals and the sitemap to https. Fix mixed content by changing http:// images, scripts and styles to https://."),
      A("t_cwv", "Improve Core Web Vitals", () => {
        if (!speedAll.length) return { status: "unknown", detail: "Run the page speed test in SEO Audit." };
        const weak = speedAll.flatMap((r) => weakVitals(r));
        const poor = weak.some((w) => w.rating === "poor");
        return { status: weak.length === 0 ? "pass" : poor ? "fail" : "warn", detail: `${speedAll.length} ${plural(speedAll.length, "page", "pages")} tested; ${weak.length === 0 ? "every vital is good" : `${weak.length} ${plural(weak.length, "vital needs", "vitals need")} work`}.`, urls: urlsOf(speedAll.filter((r) => weakVitals(r).length)) };
      }, "Compress and resize images (use WebP or AVIF), reserve space for images and embeds so the page doesn't jump, defer or remove unused JavaScript, and use caching or a CDN. Re-test in the page speed card after each change.", "Technical Fix", "audit"),
      A("t_links", "Fix broken links", () => crawlOnly(() => {
        const f = issuesLike(/broken internal/i);
        return f.length ? { status: "fail", detail: f[0].title, urls: urlsOf(f[0].urls) } : { status: "pass", detail: "No broken internal links found in the links checked." };
      }), "Update or remove each broken link, or 301-redirect the dead URL to its closest live page. Start with links in menus and the footer, since they appear on every page."),
      M("t_toxic", "Remove toxic backlinks", "VertexRank has no backlink index, so it can't see who links to you. Check Search Console's Links report for clearly spammy links. Only disavow if there is a manual action or a real spam pattern, since Google mostly ignores bad links on its own.", "Technical Fix"),
      A("t_mobile", "Optimize for mobile", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        if (!signal("viewport")) return { status: "unknown", detail: "Re-crawl your site to check the mobile viewport tag." };
        return share(pagesWith(/mobile viewport/i), total, "lack a mobile viewport tag");
      }, "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> inside the <head> of every page, then check key pages on a real phone."),
      A("t_sitemap", "Create an XML sitemap", () => {
        const sm = sw.technical?.coverage?.sitemap;
        if (!total || !sm) return { status: "unknown", detail: NEEDS_CRAWL };
        if (!sm.found) return { status: "fail", detail: "No XML sitemap was found." };
        const bad = issuesLike(/sitemap/i).filter((i) => !/No XML sitemap/i.test(i.title));
        return bad.length ? { status: "warn", detail: bad[0].title, urls: urlsOf(bad[0].urls) } : { status: "pass", detail: `Sitemap found with ${sm.listed} URLs.` };
      }, "Generate an XML sitemap (your CMS or SEO plugin can), list only indexable pages that return 200, and reference it in robots.txt."),
      A("t_robots", "Create a robots.txt file", () => {
        const r = sw.technical?.coverage?.robots;
        if (!total || !r) return { status: "unknown", detail: NEEDS_CRAWL };
        const blocks = issuesLike(/blocks Googlebot/i), missing = issuesLike(/No robots\.txt/i);
        if (blocks.length) return { status: "fail", detail: blocks[0].title };
        if (missing.length) return { status: "warn", detail: "No robots.txt file found." };
        return { status: "pass", detail: "robots.txt is present and doesn't block the whole site." };
      }, "Create a robots.txt at the site root that allows crawling of public pages and points to your sitemap (Sitemap: https://yoursite.com/sitemap.xml). Never leave Disallow: / on a live site."),
      A("t_canonical", "Add canonical tags", () => crawlOnly(() => share(pagesWith(/Missing canonical/i), total, "lack a canonical tag")),
        "Add <link rel=\"canonical\" href=\"https://yoursite.com/this-page/\"> to every page, pointing at that page's own preferred URL (full https address).", "Meta Fix"),
      A("t_schema", "Implement schema markup", () => crawlOnly(() => {
        const without = pages.filter((p) => !(p.schemaTypes || []).length);
        return without.length === total ? { status: "fail", detail: "No page has structured data.", urls: urlsOf(without) } : share(without, total, "have no structured data");
      }), "Add JSON-LD structured data that matches each page: Organization on the homepage, Article on posts, LocalBusiness if you serve a local area, FAQPage only for real on-page FAQs. Validate with Google's Rich Results Test.", "Schema Markup"),
      A("t_crawl", "Fix crawl errors", () => crawlOnly(() => {
        const f = issuesLike(/loop|server error|unreachable|restricted|blocks Googlebot|homepage is set to noindex/i);
        return f.length ? { status: "fail", detail: f[0].title, urls: urlsOf(f[0].urls) } : { status: "pass", detail: "No redirect loops, server errors or blocked pages found." };
      }), "Fix server errors (5xx) first, then redirect loops and blocked pages. Search Console's Pages report lists the exact URLs Google had trouble with."),
      M("t_dupver", "Fix duplicate site versions", "Only one version of your site should answer. http, https, www and non-www should all 301-redirect to a single preferred version. Test each in a browser, and use that same version in canonicals and the sitemap.", "Technical Fix"),
      A("t_clean_urls", "Use a clean URL structure", () => crawlOnly(() => {
        const messy = pages.filter((p) => { try { const u = new URL(p.url); return u.pathname !== "/" && (/[A-Z]/.test(u.pathname) || /_/.test(u.pathname) || u.search.length > 0); } catch { return false; } });
        return share(messy, total, "have URLs with capitals, underscores or query strings");
      }), "Use short, lowercase URLs with hyphens (like /blog/grade-9-checklist). Avoid session IDs and needless parameters, and 301-redirect the old URL whenever you change one."),
      A("t_redirects", "Fix redirects", () => crawlOnly(() => {
        const loops = issueById("tech_redirect_loops", "tech_https_downgrade");
        if (loops.length) return { status: "fail", detail: loops[0].title, urls: urlsOf(loops[0].urls) };
        const chains = issueById("tech_redirect_chains", "tech_redirecting_links");
        if (chains.length) return { status: "warn", detail: chains[0].title, urls: urlsOf(chains[0].urls) };
        return { status: "pass", detail: "No redirect loops, long chains or redirecting internal links found." };
      }), "Point internal links straight at the final URL, collapse multi-step redirects into a single 301, and remove any loops or https-to-http redirects."),
      A("t_302", "Check temporary (302) redirects", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        if (!signal("redirectChain")) return { status: "unknown", detail: "Re-crawl your site to check redirect types." };
        const temp = pages.filter((p) => (p.redirectChain || []).some((r) => [302, 303, 307].includes(r.status)));
        return share(temp, total, "were reached through a temporary (302/307) redirect");
      }, "A temporary redirect tells Google the old URL will come back. If the move is permanent, change it to a 301 (or 308) so ranking signals pass to the new URL."),
      A("t_http_links", "Fix HTTP links", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        if (home && /^http:/i.test(home.url)) return { status: "unknown", detail: "The site itself is on http. Enable HTTPS first." };
        const bad = pages.filter((p) => (p.internalLinkUrls || []).some((l) => /^http:\/\//i.test(l)));
        return share(bad, total, "link to an internal http:// URL");
      }, "Change internal links from http:// to https:// (a database search-and-replace usually does it on a CMS) so visitors skip an extra redirect."),
      A("t_depth", "Optimize crawl depth", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        const depths = clickDepths(pages, crawl?.startUrl);
        if (depths.size < 3) return { status: "unknown", detail: "Not enough linked pages in the crawl to measure click depth." };
        const deep = pages.filter((p) => (depths.get(p.url) ?? 0) > 3);
        return share(deep, depths.size, "are more than 3 clicks from the homepage");
      }, "Important pages should be reachable within 3 clicks of the homepage. Link to them from the menu, hub pages and related posts, and add category or hub pages for deep content."),
    ],
    onpage: [
      A("o_title", "Optimize title tags", () => crawlOnly(() => share(urlsOf([...pagesWith(/Missing page title|Title tag is/i), ...(sw.duplicateTitles || []).flatMap((g) => g.urls || [])]), total, "have a missing, long or duplicate title")),
        "Give every page a unique title under about 60 characters, with the main keyword near the front and a reason to click.", "Meta Fix"),
      A("o_meta", "Write meta descriptions", () => crawlOnly(() => share(urlsOf([...pagesWith(/Missing meta description|Meta description is/i), ...(sw.duplicateMetaDescriptions || []).flatMap((g) => g.urls || [])]), total, "have a missing, long or duplicate meta description")),
        "Write a unique 120-155 character description for each page that says what the visitor gets and invites the click.", "Meta Fix"),
      A("o_h1", "Use one H1", () => crawlOnly(() => share(pagesWith(/Missing H1|H1 tags/i), total, "don't have exactly one H1")),
        "Each page should have exactly one H1 that states the page's topic. Turn extra H1s into H2s.", "Meta Fix"),
      A("o_headings", "Structure with H2-H6", () => (!total ? { status: "unknown", detail: NEEDS_CRAWL } : !signal("headingSkip") ? { status: "unknown", detail: "Re-crawl your site to check heading levels." } : share(pagesWith(/Heading levels are skipped/i), total, "skip heading levels")),
        "Use H2 for main sections and H3 for sub-points, without skipping levels, so the outline reads logically."),
      A("o_early", "Place keywords early", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        if (!gsc?.queryPages?.length) return { status: "unknown", detail: "Connect Search Console to compare pages with the queries they rank for." };
        const considered = topQueryByPage(gsc, crawl).size;
        if (!considered) return { status: "unknown", detail: "Not enough Search Console data per page yet." };
        const findings = keywordPlacementFindings(crawl, gsc);
        const bad = urlsOf(findings.flatMap((f) => f.urls));
        const r = share(bad, considered, "");
        return { status: r.status, detail: bad.length === 0 ? `All ${considered} pages with Search Console data use their top query early.` : `${bad.length} of ${considered} pages with Search Console data miss their top query in the title, H1 or opening words.`, urls: bad };
      }, "For each listed page, work its top Search Console query naturally into the title, the H1 and the first paragraph. Don't force it.", "Meta Fix"),
      A("o_url", "Keep URLs short", () => crawlOnly(() => share(pagesWith(/URL is longer/i), total, "have a URL over 100 characters")),
        "Shorten long URLs to a readable slug with the main keyword, and 301-redirect the old URL."),
      A("o_links", "Improve internal linking", () => crawlOnly(() => share(urlsOf(sw.weakLinkedPages || []), total, "are barely linked to from other pages")),
        "Link to each of these pages from at least 2-3 relevant pages, using descriptive anchor text, and add them to hub or category pages.", "Internal Link"),
      A("o_orphan", "Fix orphan pages", () => crawlOnly(() => share(urlsOf(sw.orphanPages || []), total, "are orphaned (no internal links point to them)")),
        "Orphan pages can't be discovered by clicking. Link to each one from a relevant page and the sitemap, or delete or merge it if it's no longer needed.", "Internal Link"),
      A("o_alt", "Add image alt text", () => crawlOnly(() => share(pagesWith(/missing alt/i), total, "have images without alt text")),
        "Describe each meaningful image in a short, natural phrase. Leave alt empty (alt=\"\") only for purely decorative images.", "Meta Fix"),
      A("o_anchors", "Use descriptive anchors", () => (!total ? { status: "unknown", detail: NEEDS_CRAWL } : !signal("weakAnchors") ? { status: "unknown", detail: "Re-crawl your site to check link anchor text." } : share(pagesWith(/vague anchor/i), total, "use vague link text like \"click here\"")),
        "Rewrite links like \"click here\" or \"read more\" so the link text describes the destination.", "Internal Link"),
      M("o_stuffing", "Avoid keyword stuffing", "Read your key pages aloud. If a phrase sounds forced or repeated, rewrite it naturally, using synonyms and related terms. VertexRank can't judge this reliably.", "Content Update"),
    ],
    local: [
      A("l_gbp", "Optimize Google Business Profile", () => progress(ticks, "gbp", "Google Business Profile items"), "Work through the Google Business Profile checklist in Local SEO: claim and verify, choose the best categories, keep name, address, phone and hours identical to your website, and add real photos.", "Content Update", "local"),
      A("l_citations", "Build local citations", () => progress(ticks, "citations", "citation items"), "List your business on the main map platforms and directories that real customers in your country use, with exactly the same name, address and phone each time.", "Content Update", "local"),
      A("l_nap", "Keep NAP consistent", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        if (local.needsProfile) return { status: "unknown", detail: "Enter your business details in Local SEO." };
        const nap = local.checks.filter((c) => /^nap_(name|address|phone|other_phones)$/.test(c.id));
        const fail = nap.find((c) => c.status === "fail"), warn = nap.find((c) => c.status === "warn");
        return fail ? { status: "fail", detail: fail.title } : warn ? { status: "warn", detail: warn.title } : { status: "pass", detail: "Name, address and phone match your pages." };
      }, "Show your business name, address and phone in the same form on the homepage, contact page and footer, matching your Google Business Profile exactly.", "Content Update", "local"),
      M("l_nearme", "Target \"near me\" searches", "Make sure your service areas and neighbourhoods appear naturally in titles, headings and page text, and that your Business Profile lists the same areas.", "Content Update"),
      A("l_reviews", "Get customer reviews", () => progress(ticks, "reviews", "review items"), "Ask every happy customer for a review with your direct Google review link, and reply to every review. Only genuine reviews: never pay for or fake them.", "Content Update", "local"),
      A("l_schema", "Add local schema", () => { const c = localCheck("schema_local"); return c ? { status: c.status === "info" ? "unknown" : c.status, detail: c.title } : { status: "unknown", detail: NEEDS_CRAWL }; }, "Use the LocalBusiness schema generator in Local SEO, paste the code into your homepage or contact page, then re-crawl.", "Schema Markup", "local"),
      A("l_pages", "Optimize location pages", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        if (!local.areas.length) return { status: "unknown", detail: "Add the areas you serve in Local SEO." };
        const withPage = local.areas.filter((a) => a.status === "page").length;
        return { status: withPage === local.areas.length ? "pass" : withPage > 0 ? "warn" : "fail", detail: `${withPage} of ${local.areas.length} areas have their own page.` };
      }, "Give each area you serve its own page with genuinely local content (areas covered, local examples, prices, address or map). Never copy another city's page and swap the name.", "Content Update", "local"),
      M("l_geoimages", "Use geo-tagged images", "Use real photos of your work or premises with descriptive file names and alt text. Google largely ignores embedded geotags, so don't expect a ranking effect.", "Content Update"),
    ],
    content: [
      M("c_intent", "Match search intent", "Search each page's main keyword and check that your page is the same kind of result (guide, list, product, local page) as what ranks. If not, reshape the page or target a different keyword.", "Content Update"),
      A("c_depth", "Create in-depth content", () => crawlOnly(() => share(pagesWith(/Thin content/i), total, "are thin (very few words)")), "Expand each thin page with what a reader actually needs: concrete steps, examples, prices, comparisons and answers to follow-up questions. Merge or remove pages that can't be made useful.", "Content Update", "content"),
      A("c_related", "Target related keywords", () => {
        const n = (b?.siteKeywordClusters?.keywords || []).length + (b?.keywords || []).length;
        return n >= 10 ? { status: "pass", detail: `${n} keywords tracked or analysed.` } : n > 0 ? { status: "warn", detail: `Only ${n} keywords so far. Run Keyword Intelligence.` } : { status: "todo", detail: "Run Keyword Intelligence to find related keywords." };
      }, "Run Keyword Intelligence, then work each page's related terms and questions into its headings and body.", "Content Update", "keywords"),
      A("c_comp_kw", "Identify competitor keywords", () => {
        const comps = b?.competitors || [];
        if (!comps.length) return { status: "todo", detail: "No competitors added yet." };
        const analysed = comps.filter((c) => c.crawlSummary).length;
        return analysed ? { status: "pass", detail: `${analysed} of ${comps.length} competitors analysed.` } : { status: "warn", detail: "Competitors added but not analysed yet." };
      }, "Add 3-5 real competitors and run their analysis, then look for topics they cover that you don't.", "Content Update", "competitors"),
      A("c_paa", "Find questions people ask (People Also Ask, forums)", () => {
        const n = (b?.aeoQuestions || []).length;
        return n >= 5 ? { status: "pass", detail: `${n} questions collected.` } : n > 0 ? { status: "warn", detail: `Only ${n} questions collected so far.` } : { status: "todo", detail: "No questions collected yet." };
      }, "Run the AEO analysis to collect real questions, and check Google's People Also Ask boxes and forums (Reddit, Quora) for your topic. Answer each question clearly on a relevant page.", "FAQ Addition", "aeo"),
      M("c_snippets", "Optimize featured snippets", "Answer the question in 40-60 words right under a clear heading, then expand. Use the AEO page to find questions to target.", "FAQ Addition"),
      A("c_refresh", "Refresh old content", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        if (!gsc?.pages?.length) return { status: "unknown", detail: "Connect Search Console to find declining pages." };
        const rows = refreshCandidates(gsc, crawl, { limit: 50 });
        return rows.length === 0 ? { status: "pass", detail: "No pages are clearly declining or thin." } : { status: rows.length > 3 ? "fail" : "warn", detail: `${rows.length} ${plural(rows.length, "page", "pages")} worth refreshing (see Content Planner).`, urls: urlsOf(rows.map((r) => r.page)) };
      }, "Update the listed pages rather than replacing them: check every fact and date, answer their top queries directly, add what competitors now cover, and improve the title and intro.", "Content Update", "content"),
      A("c_clusters", "Build topic clusters", () => {
        const n = (b?.siteKeywordClusters?.clusters || []).length;
        return n >= 3 ? { status: "pass", detail: `${n} topic clusters found.` } : n > 0 ? { status: "warn", detail: `${n} ${plural(n, "cluster", "clusters")} so far.` } : { status: "todo", detail: "Run Keyword Intelligence to map topic clusters." };
      }, "For each main topic, write one pillar page and 4-8 supporting pages that link to it and to each other.", "Internal Link", "keywords"),
      A("c_cannibal", "Fix keyword cannibalization", () => {
        const cl = b?.siteKeywordClusters;
        if (!cl?.clusters) return { status: "unknown", detail: "Run Keyword Intelligence to check for competing pages." };
        const n = (cl.cannibalization || []).length;
        return n === 0 ? { status: "pass", detail: "No topics found where several of your pages compete." } : { status: n > 2 ? "fail" : "warn", detail: `${n} ${plural(n, "topic has", "topics have")} several pages competing.`, urls: urlsOf((cl.cannibalization || []).flatMap((c) => (c.pages || []).map((p) => p.url))) };
      }, "For each topic with competing pages, merge them into one stronger page (301-redirect the others) or give each page a clearly different purpose and keyword.", "Content Update", "keywords"),
      A("c_faq", "Answer common FAQs", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        const n = pages.filter((p) => (p.faqQuestions || []).length > 0).length;
        return n >= 3 ? { status: "pass", detail: `${n} pages have FAQ markup.` } : n > 0 ? { status: "warn", detail: `Only ${n} ${plural(n, "page has", "pages have")} FAQ markup.` } : { status: "fail", detail: "No page has FAQ markup." };
      }, "Add a short FAQ section to your key pages answering real customer questions (from Search Console and the AEO page), and mark it up as FAQPage only if the questions and answers are visible on the page.", "FAQ Addition", "aeo"),
      M("c_audit", "Audit your content", "Once a quarter, list every page and decide: keep, update, merge or remove. Check it's accurate, still wanted, and still earning clicks in Search Console.", "Content Update"),
      M("c_lists", "Use lists & bullets", "Break long steps and comparisons into short lists and tables so readers (and answer engines) can scan them.", "Content Update"),
      M("c_readability", "Improve readability", "Use short paragraphs, plain words and descriptive subheadings. Read each page on your phone.", "Content Update"),
      A("c_visuals", "Add engaging visuals", () => crawlOnly(() => {
        const without = pages.filter((p) => !(p.imagesTotal > 0));
        return without.length === 0 ? { status: "pass", detail: "Every crawled page has images." } : { status: without.length / total <= 0.2 ? "warn" : "fail", detail: `${without.length} of ${total} crawled pages have no images.`, urls: urlsOf(without) };
      }), "Add original, useful images (photos of your work, diagrams, screenshots) with descriptive alt text. Skip generic stock filler.", "Content Update"),
    ],
    offpage: [
      A("f_links", "Earn quality backlinks", () => { const n = submitted(); return n >= 3 ? { status: "pass", detail: `${n} Backlink Radar opportunities submitted. Submitted isn't the same as earned: confirm the links went live.` } : n > 0 ? { status: "warn", detail: `${n} submitted so far in Backlink Radar.` } : { status: "todo", detail: "Nothing submitted yet in Backlink Radar." }; }, "Work through Backlink Radar: pick the most relevant opportunities, send a short personal pitch offering something genuinely useful, and mark each as submitted.", "Content Update", "backlinks"),
      A("f_find", "Find new link opportunities", () => { const n = (b?.backlinks || []).length; return n >= 5 ? { status: "pass", detail: `${n} opportunities found in Backlink Radar.` } : n > 0 ? { status: "warn", detail: `${n} opportunities so far.` } : { status: "todo", detail: "Run Backlink Radar to find opportunities." }; }, "Run Backlink Radar for your site and your competitors, and shortlist places that link to similar businesses.", "Content Update", "backlinks"),
      M("f_analyze", "Analyze your backlinks", "VertexRank has no backlink index. Open Search Console's Links report monthly to see your top linking sites and pages, and note which links bring real visitors.", "Content Update"),
      M("f_gap", "Do a backlink gap analysis", "List sites that link to your competitors but not to you (a backlink tool does this). Those are your warmest outreach targets. Backlink Radar's competitor-based suggestions are a free starting point.", "Content Update"),
      A("f_guest", "Use guest posting", () => { const n = submitted(/guest/i); return n > 0 ? { status: "pass", detail: `${n} guest-post ${plural(n, "opportunity", "opportunities")} submitted.` } : { status: "todo", detail: "No guest posts submitted in Backlink Radar." }; }, "Offer a genuinely useful article to a respected site in your field. Pitch a specific topic, not just \"can I write for you\".", "Content Update", "backlinks"),
      A("f_directory", "Build directory links", () => { const n = submitted(/director/i); return n > 0 ? { status: "pass", detail: `${n} directory ${plural(n, "link", "links")} submitted.` } : { status: "todo", detail: "No directory links submitted in Backlink Radar." }; }, "Submit your business to a few relevant, reputable directories (industry and local). Skip bulk or paid directories.", "Content Update", "backlinks"),
      M("f_pr", "Leverage digital PR", "Pitch journalists something genuinely newsworthy: local data, a study, an event. Press links come from stories, not from asking.", "Content Update"),
      M("f_mentions", "Turn brand mentions into backlinks", "Search your brand name now and then. Where you're mentioned without a link, politely ask for one.", "Content Update"),
      M("f_social", "Promote content socially", "Share each new page where your audience already is. Social links don't pass ranking value, but they bring readers who may link.", "Content Update"),
      M("f_haro", "Use HARO opportunities", "Reply to journalist requests in your field with short, useful answers. Only genuine expertise.", "Content Update"),
      M("f_ugc", "Encourage UGC", "Reviews, questions and testimonials from real customers. Never fake or pay for them.", "Content Update"),
      M("f_influencer", "Build influencer links", "Offer something useful to people your audience trusts. Disclose any paid arrangement.", "Content Update"),
      M("f_monitor", "Monitor backlinks", "VertexRank can't see who links to you. Check Search Console's Links report monthly for new and lost links.", "Content Update"),
    ],
    advanced: [
      M("a_voice", "Optimize voice search", "Voice queries are conversational questions. Answer them directly in short sentences (the AEO page lists questions to target).", "FAQ Addition"),
      M("a_ai", "Use AI for SEO", "Use AI to speed up research and drafts, but check every claim and add your own experience.", "Content Update"),
      A("a_competitors", "Track competitors", () => { const n = (b?.competitors || []).length; return n >= 3 ? { status: "pass", detail: `${n} competitors tracked.` } : n > 0 ? { status: "warn", detail: `${n} ${plural(n, "competitor", "competitors")} tracked. Three or more gives a better picture.` } : { status: "todo", detail: "No competitors tracked yet." }; }, "Add 3-5 real competitors (the sites that show up when you search your main keywords) in Competitors.", "Content Update", "competitors"),
      M("a_eeat", "Strengthen E-E-A-T", "Show who writes your content, their real experience, your address and contact details, and cite sources. The GEO page lists trust gaps found on your site.", "Content Update"),
      M("a_trends", "Analyze SEO trends", "Skim Search Console's performance report monthly for rising and falling queries.", "Content Update"),
      M("a_zeroclick", "Target zero-click results", "Some searches are answered on the results page. Aim to be the source Google quotes, and make sure your brand still earns the click.", "Content Update"),
      M("a_programmatic", "Use programmatic SEO", "Only worth it if you have real structured data worth a page each. Mark it not applicable otherwise.", "Content Update"),
      A("a_shifts", "Track keyword shifts", () => (gsc?.queries?.length ? { status: "pass", detail: "Search Console is connected, so query and position changes are tracked." } : (b?.serpChecks || []).length ? { status: "warn", detail: "Live searches saved, but Search Console isn't connected." } : { status: "todo", detail: "Connect Search Console in Search data." }), "Connect Search Console and compare periods in Search data. Save live searches for your key terms to see how results change.", "Technical Fix", "search"),
      M("a_youtube", "Optimize YouTube SEO", "Only if you publish video. Use the main keyword in the title and first line of the description, and add chapters. Otherwise mark not applicable.", "Content Update"),
    ],
    ai: [
      A("ai_visibility", "Audit AI visibility", () => (b?.siteGeoAnalysis || b?.aiVisibility || b?.siteAiVisibility ? { status: "pass", detail: "An AI visibility check has been run." } : { status: "todo", detail: "No AI visibility check run yet." }), "Open the GEO page and run the AI visibility check to see whether and how AI assistants mention your business.", "Content Update", "geo"),
      A("ai_structure", "Structure content for AI", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        const faq = pages.filter((p) => (p.faqQuestions || []).length > 0).length;
        const q = pages.filter((p) => (p.questionHeadings || []).length > 0).length;
        return faq >= 3 && q >= 3 ? { status: "pass", detail: `${faq} pages have FAQ markup and ${q} use question-style headings.` } : faq + q > 0 ? { status: "warn", detail: `${faq} pages have FAQ markup and ${q} use question-style headings.` } : { status: "fail", detail: "No pages use FAQ markup or question-style headings." };
      }, "Lead each page with a direct answer, use clear question-style headings, short paragraphs, lists and tables, and add FAQ markup for real questions. Use the AEO page for ideas.", "FAQ Addition", "aeo"),
      M("ai_crawlers", "Allow the AI crawlers you want", "Check your robots.txt doesn't block the AI crawlers you want citations from (such as GPTBot, ClaudeBot, PerplexityBot and Google-Extended). Blocking is a business choice, so decide on purpose.", "Technical Fix"),
      M("ai_llms", "Consider an llms.txt file", "An llms.txt file (a plain-text summary of your site for AI tools) is optional. No major search engine has confirmed that it affects rankings or citations, so treat it as a low-cost experiment, not a requirement. Mark N/A if you skip it.", "Technical Fix"),
    ],
  };

  const groups = PLAYBOOK_GROUPS.map((g) => {
    const items = defs[g.id].map((d) => {
      const mark = marks[d.id];
      let status, detail, urls = [];
      if (mark === "na") { status = "na"; detail = "Marked not applicable."; }
      else if (d.auto) { const r = d.fn() || { status: "unknown", detail: "" }; status = r.status; detail = r.detail; urls = r.urls || []; }
      else if (mark === "done") { status = "pass"; detail = "You marked this done."; }
      else { status = "todo"; detail = d.how; }
      const view = d.view || g.view;
      const rec = status === "pass" || status === "na" ? null : {
        title: d.text, evidence: `${detail}${d.auto ? "" : " (Not yet done.)"}`, recommendedAction: d.how, module: `Playbook: ${g.title}`,
        source: d.auto ? "VertexRank checks (observed)" : "SEO playbook (guidance)", actionType: d.type, priority: status === "fail" ? "High" : status === "warn" ? "Medium" : "Low", urls,
      };
      return { id: d.id, text: d.text, status, detail, auto: d.auto, how: d.how, view, urls, rec };
    });
    return { id: g.id, title: g.title, view: g.view, items, ...score(items) };
  });
  return { groups, overall: score(groups.flatMap((g) => g.items)), hasCrawl: total > 0 };
}

function score(items) {
  const measured = items.filter((i) => i.status in POINTS);
  const pts = measured.reduce((s, i) => s + POINTS[i.status], 0);
  return { score: measured.length ? Math.round((pts / measured.length) * 100) : null, measured: measured.length, total: items.length, unknown: items.filter((i) => i.status === "unknown").length };
}
