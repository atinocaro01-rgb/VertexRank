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
  { id: "technical", title: "Technical SEO", view: "audit" },
  { id: "onpage", title: "On-Page SEO", view: "audit" },
  { id: "local", title: "Local SEO", view: "local" },
  { id: "content", title: "Content SEO", view: "content" },
  { id: "offpage", title: "Off-Page SEO", view: "backlinks" },
  { id: "advanced", title: "Advanced SEO", view: "competitors" },
];

const POINTS = { pass: 1, warn: 0.5, fail: 0, todo: 0 };
const plural = (n, a, b) => (n === 1 ? a : b);
const NEEDS_CRAWL = "Run a site crawl first.";

/** Share-based status: none bad = pass, up to 20% of pages = warn, more = fail. */
function share(bad, total, what) {
  if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
  if (bad === 0) return { status: "pass", detail: `None of the ${total} crawled pages ${what}.` };
  return { status: bad / total <= 0.2 ? "warn" : "fail", detail: `${bad} of ${total} crawled ${plural(total, "page", "pages")} ${what}.` };
}

function progress(state, groupId, label) {
  const p = checklistProgress(state, groupId);
  return { status: p.done === p.total ? "pass" : p.done > 0 ? "warn" : "todo", detail: `${p.done} of ${p.total} ${label} ticked in Local SEO.` };
}

/** Builds every playbook item's status from one website's saved data. `marks` = { [itemId]: "done" | "na" } set by the owner. */
export function evaluatePlaybook(b, { country = "Worldwide" } = {}) {
  const crawl = b?.siteCrawl || null;
  const pages = Array.isArray(crawl?.pages) ? crawl.pages : [];
  const total = pages.length;
  const sw = crawl?.siteWide || {};
  const gsc = b?.gscReport || null;
  const issues = total ? computeAuditIssuesForMarket(crawl, country, { gscReport: gsc }) : [];
  const issuesLike = (re) => issues.filter((i) => re.test(i.title) || re.test(i.id || ""));
  const pagesWith = (re) => pages.filter((p) => (p.issues || []).some((i) => re.test(i.title)));
  const signal = (key) => pages.some((p) => p[key] !== undefined);
  const marks = b?.playbookMarks || {};
  const ticks = b?.localChecklist || {};
  const local = total ? runLocalChecks(crawl, b?.localProfile) : { checks: [], areas: [], needsProfile: false };
  const localCheck = (id) => local.checks.find((c) => c.id === id);
  const speed = (b?.pageSpeed || []).filter((r) => r.strategy === "mobile");
  const speedAll = speed.length ? speed : (b?.pageSpeed || []);
  const submitted = (re) => (b?.backlinks || []).filter((x) => x.status === "Submitted" && (!re || re.test(x.type || ""))).length;

  const A = (id, text, fn, hint = "") => ({ id, text, auto: true, fn, hint });
  const M = (id, text, hint) => ({ id, text, auto: false, hint });

  const defs = {
    technical: [
      A("t_https", "Enable HTTPS", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        const site = issues.find((i) => i.id === "play_https_site"), pg = issues.find((i) => i.id === "play_https_pages"), mixed = pagesWith(/Insecure \(http/);
        if (site) return { status: "fail", detail: "The site was reached over http, not https." };
        if (pg || mixed.length) return { status: "warn", detail: pg ? pg.title : `${mixed.length} ${plural(mixed.length, "page loads", "pages load")} insecure (http) resources.` };
        return { status: "pass", detail: "Crawled pages are served over https with no mixed content found." };
      }),
      A("t_cwv", "Improve Core Web Vitals", () => {
        if (!speedAll.length) return { status: "unknown", detail: "Run the page speed test in SEO Audit." };
        const weak = speedAll.flatMap((r) => weakVitals(r));
        const poor = weak.some((w) => w.rating === "poor");
        return { status: weak.length === 0 ? "pass" : poor ? "fail" : "warn", detail: `${speedAll.length} ${plural(speedAll.length, "page", "pages")} tested; ${weak.length === 0 ? "every vital is good" : `${weak.length} ${plural(weak.length, "vital needs", "vitals need")} work`}.` };
      }),
      A("t_links", "Fix broken links", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        const f = issuesLike(/broken internal/i);
        return f.length ? { status: "fail", detail: f[0].title } : { status: "pass", detail: "No broken internal links found in the links checked." };
      }),
      M("t_toxic", "Remove toxic backlinks", "VertexRank has no backlink index, so it can't see which links point at you. Check Google Search Console's Links report and disavow only clearly spammy ones."),
      A("t_mobile", "Optimize for mobile", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        if (!signal("viewport")) return { status: "unknown", detail: "Re-crawl your site to check the mobile viewport tag." };
        return share(pagesWith(/mobile viewport/i).length, total, "lack a mobile viewport tag");
      }),
      A("t_sitemap", "Submit XML sitemap", () => {
        const sm = sw.technical?.coverage?.sitemap;
        if (!total || !sm) return { status: "unknown", detail: NEEDS_CRAWL };
        if (!sm.found) return { status: "fail", detail: "No XML sitemap was found." };
        const bad = issuesLike(/sitemap/i).filter((i) => !/No XML sitemap/i.test(i.title));
        return bad.length ? { status: "warn", detail: bad[0].title } : { status: "pass", detail: `Sitemap found with ${sm.listed} URLs. Submitting it in Search Console is still up to you.` };
      }),
      A("t_robots", "Optimize robots.txt", () => {
        const r = sw.technical?.coverage?.robots;
        if (!total || !r) return { status: "unknown", detail: NEEDS_CRAWL };
        const blocks = issuesLike(/blocks Googlebot/i), missing = issuesLike(/No robots\.txt/i);
        if (blocks.length) return { status: "fail", detail: blocks[0].title };
        if (missing.length) return { status: "warn", detail: "No robots.txt file found." };
        return { status: "pass", detail: "robots.txt is present and doesn't block the whole site." };
      }),
      A("t_canonical", "Add canonical tags", () => (total ? share(pagesWith(/Missing canonical/i).length, total, "lack a canonical tag") : { status: "unknown", detail: NEEDS_CRAWL })),
      A("t_schema", "Implement schema markup", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        const without = pages.filter((p) => !(p.schemaTypes || []).length).length;
        return without === total ? { status: "fail", detail: "No page has structured data." } : share(without, total, "have no structured data");
      }),
      A("t_crawl", "Fix crawl errors", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        const f = issuesLike(/loop|server error|unreachable|restricted|blocks Googlebot|homepage is set to noindex/i);
        return f.length ? { status: "fail", detail: f[0].title } : { status: "pass", detail: "No redirect loops, server errors or blocked pages found." };
      }),
    ],
    onpage: [
      A("o_title", "Optimize title tags", () => (total ? share(new Set([...pagesWith(/Missing page title|Title tag is/i).map((p) => p.url), ...(sw.duplicateTitles || []).flatMap((g) => g.urls || [])]).size, total, "have a missing, long or duplicate title") : { status: "unknown", detail: NEEDS_CRAWL })),
      A("o_meta", "Write meta descriptions", () => (total ? share(new Set([...pagesWith(/Missing meta description|Meta description is/i).map((p) => p.url), ...(sw.duplicateMetaDescriptions || []).flatMap((g) => g.urls || [])]).size, total, "have a missing, long or duplicate meta description") : { status: "unknown", detail: NEEDS_CRAWL })),
      A("o_h1", "Use one H1", () => (total ? share(pagesWith(/Missing H1|H1 tags/i).length, total, "don't have exactly one H1") : { status: "unknown", detail: NEEDS_CRAWL })),
      A("o_headings", "Structure with H2-H6", () => (!total ? { status: "unknown", detail: NEEDS_CRAWL } : !signal("headingSkip") ? { status: "unknown", detail: "Re-crawl your site to check heading levels." } : share(pagesWith(/Heading levels are skipped/i).length, total, "skip heading levels"))),
      A("o_early", "Place keywords early", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        if (!gsc?.queryPages?.length) return { status: "unknown", detail: "Connect Search Console to compare pages with the queries they rank for." };
        const considered = topQueryByPage(gsc, crawl).size;
        if (!considered) return { status: "unknown", detail: "Not enough Search Console data per page yet." };
        const bad = new Set(keywordPlacementFindings(crawl, gsc).flatMap((f) => f.urls)).size;
        const r = share(bad, considered, "");
        return { status: r.status, detail: bad === 0 ? `All ${considered} pages with Search Console data use their top query early.` : `${bad} of ${considered} pages with Search Console data miss their top query in the title, H1 or opening words.` };
      }),
      A("o_url", "Keep URLs short", () => (total ? share(pagesWith(/URL is longer/i).length, total, "have a URL over 100 characters") : { status: "unknown", detail: NEEDS_CRAWL })),
      A("o_links", "Improve internal links", () => (total ? share((sw.orphanPages || []).length + (sw.weakLinkedPages || []).length, total, "are orphaned or barely linked to") : { status: "unknown", detail: NEEDS_CRAWL })),
      A("o_alt", "Add image alt text", () => (total ? share(pagesWith(/missing alt/i).length, total, "have images without alt text") : { status: "unknown", detail: NEEDS_CRAWL })),
      A("o_anchors", "Use descriptive anchors", () => (!total ? { status: "unknown", detail: NEEDS_CRAWL } : !signal("weakAnchors") ? { status: "unknown", detail: "Re-crawl your site to check link anchor text." } : share(pagesWith(/vague anchor/i).length, total, "use vague link text like \"click here\""))),
      M("o_stuffing", "Avoid keyword stuffing", "Read your key pages aloud. If a phrase sounds forced or repeated, rewrite it naturally. VertexRank can't judge this reliably."),
    ],
    local: [
      A("l_gbp", "Optimize Google Business Profile", () => progress(ticks, "gbp", "Google Business Profile items")),
      A("l_citations", "Build local citations", () => progress(ticks, "citations", "citation items")),
      A("l_nap", "Keep NAP consistent", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        if (local.needsProfile) return { status: "unknown", detail: "Enter your business details in Local SEO." };
        const nap = local.checks.filter((c) => /^nap_(name|address|phone|other_phones)$/.test(c.id));
        const fail = nap.find((c) => c.status === "fail"), warn = nap.find((c) => c.status === "warn");
        return fail ? { status: "fail", detail: fail.title } : warn ? { status: "warn", detail: warn.title } : { status: "pass", detail: "Name, address and phone match your pages." };
      }),
      M("l_nearme", "Target \"near me\" searches", "Make sure your service areas and neighbourhoods appear in titles, headings and page text, and that your Business Profile lists the same areas."),
      A("l_reviews", "Get customer reviews", () => progress(ticks, "reviews", "review items")),
      A("l_schema", "Add local schema", () => { const c = localCheck("schema_local"); return c ? { status: c.status === "info" ? "unknown" : c.status, detail: c.title } : { status: "unknown", detail: NEEDS_CRAWL }; }),
      A("l_pages", "Optimize location pages", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        if (!local.areas.length) return { status: "unknown", detail: "Add the areas you serve in Local SEO." };
        const withPage = local.areas.filter((a) => a.status === "page").length;
        return { status: withPage === local.areas.length ? "pass" : withPage > 0 ? "warn" : "fail", detail: `${withPage} of ${local.areas.length} areas have their own page.` };
      }),
      M("l_geoimages", "Use geo-tagged images", "Use real photos of your work or premises with descriptive file names and alt text. Google largely ignores embedded geotags, so don't expect a ranking effect."),
    ],
    content: [
      M("c_intent", "Match search intent", "For each page, search its main keyword and check that your page is the same kind of result (guide, list, product, local) as what ranks."),
      A("c_depth", "Create in-depth content", () => (total ? share(pagesWith(/Thin content/i).length, total, "are thin (very few words)") : { status: "unknown", detail: NEEDS_CRAWL })),
      A("c_related", "Target related keywords", () => {
        const n = (b?.siteKeywordClusters?.keywords || []).length + (b?.keywords || []).length;
        return n >= 10 ? { status: "pass", detail: `${n} keywords tracked or analysed.` } : n > 0 ? { status: "warn", detail: `Only ${n} keywords so far. Run Keyword Intelligence.` } : { status: "todo", detail: "Run Keyword Intelligence to find related keywords." };
      }),
      M("c_snippets", "Optimize featured snippets", "Answer the question in 40-60 words right under a clear heading, then expand. Use the AEO page to find questions to target."),
      A("c_refresh", "Refresh old content", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        if (!gsc?.pages?.length) return { status: "unknown", detail: "Connect Search Console to find declining pages." };
        const n = refreshCandidates(gsc, crawl, { limit: 50 }).length;
        return n === 0 ? { status: "pass", detail: "No pages are clearly declining or thin." } : { status: n > 3 ? "fail" : "warn", detail: `${n} ${plural(n, "page", "pages")} worth refreshing (see Content Planner).` };
      }),
      A("c_clusters", "Build topic clusters", () => {
        const n = (b?.siteKeywordClusters?.clusters || []).length;
        return n >= 3 ? { status: "pass", detail: `${n} topic clusters found.` } : n > 0 ? { status: "warn", detail: `${n} ${plural(n, "cluster", "clusters")} so far.` } : { status: "todo", detail: "Run Keyword Intelligence to map topic clusters." };
      }),
      A("c_faq", "Answer common FAQs", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        const n = pages.filter((p) => (p.faqQuestions || []).length > 0).length;
        return n >= 3 ? { status: "pass", detail: `${n} pages have FAQ markup.` } : n > 0 ? { status: "warn", detail: `Only ${n} ${plural(n, "page has", "pages have")} FAQ markup.` } : { status: "fail", detail: "No page has FAQ markup." };
      }),
      M("c_lists", "Use lists & bullets", "Break long steps and comparisons into short lists and tables so readers (and answer engines) can scan them."),
      M("c_readability", "Improve readability", "Short paragraphs, plain words, descriptive subheadings. Read each page on your phone."),
      A("c_visuals", "Add engaging visuals", () => {
        if (!total) return { status: "unknown", detail: NEEDS_CRAWL };
        const without = pages.filter((p) => !(p.imagesTotal > 0)).length;
        return without === 0 ? { status: "pass", detail: "Every crawled page has images." } : { status: without / total <= 0.2 ? "warn" : "fail", detail: `${without} of ${total} crawled pages have no images.` };
      }),
    ],
    offpage: [
      A("f_links", "Earn quality backlinks", () => { const n = submitted(); return n >= 3 ? { status: "pass", detail: `${n} Backlink Radar opportunities submitted. Submitted isn't the same as earned: confirm the links went live.` } : n > 0 ? { status: "warn", detail: `${n} submitted so far in Backlink Radar.` } : { status: "todo", detail: "Nothing submitted yet in Backlink Radar." }; }),
      A("f_guest", "Use guest posting", () => { const n = submitted(/guest/i); return n > 0 ? { status: "pass", detail: `${n} guest-post ${plural(n, "opportunity", "opportunities")} submitted.` } : { status: "todo", detail: "No guest posts submitted in Backlink Radar." }; }),
      A("f_directory", "Build directory links", () => { const n = submitted(/director/i); return n > 0 ? { status: "pass", detail: `${n} directory ${plural(n, "link", "links")} submitted.` } : { status: "todo", detail: "No directory links submitted in Backlink Radar." }; }),
      M("f_pr", "Leverage digital PR", "Pitch journalists with something genuinely newsworthy: local data, a study, an event. Press links come from stories, not from asking."),
      M("f_mentions", "Grow brand mentions", "Search your brand name now and then. Where you're mentioned without a link, politely ask for one."),
      M("f_social", "Promote content socially", "Share each new page where your audience already is. Social links don't pass ranking value, but they bring readers who may link."),
      M("f_haro", "Use HARO opportunities", "Reply to journalist requests in your field with short, useful answers. Only genuine expertise."),
      M("f_ugc", "Encourage UGC", "Reviews, questions and testimonials from real customers. Never fake or pay for them."),
      M("f_influencer", "Build influencer links", "Offer something useful to people your audience trusts. Disclose any paid arrangement."),
      M("f_monitor", "Monitor backlinks", "VertexRank can't see who links to you. Check Search Console's Links report monthly for new and lost links."),
    ],
    advanced: [
      M("a_voice", "Optimize voice search", "Voice queries are conversational questions. Answer them directly in short sentences (the AEO page lists questions to target)."),
      M("a_ai", "Use AI for SEO", "Use AI to speed up research and drafts, but check every claim and add your own experience."),
      A("a_competitors", "Track competitors", () => { const n = (b?.competitors || []).length; return n >= 3 ? { status: "pass", detail: `${n} competitors tracked.` } : n > 0 ? { status: "warn", detail: `${n} ${plural(n, "competitor", "competitors")} tracked. Three or more gives a better picture.` } : { status: "todo", detail: "No competitors tracked yet." }; }),
      M("a_eeat", "Strengthen E-E-A-T", "Show who writes your content, their real experience, your address and contact details, and cite sources. The GEO page lists trust gaps found on your site."),
      M("a_trends", "Analyze SEO trends", "Skim Search Console's performance report monthly for rising and falling queries."),
      M("a_zeroclick", "Target zero-click results", "Some searches are answered on the results page. Aim to be the source Google quotes, and make sure your brand still earns the click."),
      M("a_programmatic", "Use programmatic SEO", "Only worth it if you have real structured data worth a page each. Mark it not applicable otherwise."),
      A("a_shifts", "Track keyword shifts", () => (gsc?.queries?.length ? { status: "pass", detail: "Search Console is connected, so query and position changes are tracked." } : (b?.serpChecks || []).length ? { status: "warn", detail: "Live searches saved, but Search Console isn't connected." } : { status: "todo", detail: "Connect Search Console in Search data." })),
      M("a_youtube", "Optimize YouTube SEO", "Only if you publish video. Use the main keyword in the title and first line of the description, and add chapters. Otherwise mark not applicable."),
    ],
  };

  const groups = PLAYBOOK_GROUPS.map((g) => {
    const items = defs[g.id].map((d) => {
      const mark = marks[d.id];
      let status, detail;
      if (mark === "na") { status = "na"; detail = "Marked not applicable."; }
      else if (d.auto) { const r = d.fn() || { status: "unknown", detail: "" }; status = r.status; detail = r.detail; }
      else if (mark === "done") { status = "pass"; detail = "You marked this done."; }
      else { status = "todo"; detail = d.hint; }
      return { id: d.id, text: d.text, status, detail, auto: d.auto, hint: d.hint, view: g.view };
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
