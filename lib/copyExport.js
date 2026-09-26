// Turns everything VertexRank has produced for a website — AI insights,
// recommendations, analyses, audit issues, plans — into clean, paste-ready
// Markdown, so it can be dropped into a doc, a ticket, a chat with a
// developer, or another AI tool.
//
// Everything in here is a pure function of the saved workspace data (no React,
// no DOM, except copyTextToClipboard at the bottom), which keeps it easy to
// test and means the copied text can never drift from what's on screen: the
// Unified Recommendations list and the label maps below are the SAME ones the
// UI renders from.
//
// Every formatter is defensive about missing fields: workspaces are restored
// from localStorage and may have been saved by an older version of the app.

/* ============================== shared reference data ============================== */
// Used by both the UI and the exporters, so the labels in the copied text always
// match the labels on screen.

export const GEO_FACTORS = [
  { key: "entityClarity", label: "Entity Clarity", blurb: "How clearly your brand, products, and offerings are defined in machine-readable terms." },
  { key: "authority", label: "Authority", blurb: "External signals — mentions, citations, and links — that establish trust with AI systems." },
  { key: "contentStructure", label: "Content Structure", blurb: "How cleanly content is organized into scannable, extractable sections." },
  { key: "evidence", label: "Evidence", blurb: "Presence of data, sources, and specifics that AI systems prefer to cite." },
  { key: "brandConsistency", label: "Brand Consistency", blurb: "Consistency of naming and facts about your brand across the web." },
  { key: "extractability", label: "Extractability", blurb: "How easily an answer engine can lift a direct answer from your page." },
  { key: "structuredData", label: "Structured Data", blurb: "Coverage of schema markup describing your content and entities." },
  { key: "topicCoverage", label: "Topic Coverage", blurb: "Breadth and depth of coverage across your core subject matter." },
];

export const AEO_SIGNAL_LABELS = {
  hasFaqSchema: "FAQ schema", hasHowToSchema: "HowTo schema", hasQaSchema: "Q&A schema", hasAnySchema: "Any structured data",
  hasListMarkup: "List markup", hasTableMarkup: "Comparison table", hasMultipleHeadings: "Multiple headings",
  hasQuestionHeading: "A heading phrased as a question", hasDirectAnswerParagraph: "A direct-answer style paragraph",
  hasExistingQuestionsInBody: "Existing Q&A text in body", contentDepthOk: "At least 300 words of content",
};

export const GEO_AUTHORITY_LABELS = {
  hasOrganizationSchema: "Organization/LocalBusiness schema", hasProductOrServiceSchema: "Product/Service schema",
  hasArticleOrAuthorSchema: "Article/Author schema", hasContactSignal: "Contact information", hasAboutSignal: "About / who-we-are content",
  hasLocationSignal: "Location clarity", hasAudienceSignal: "Target-audience clarity", hasCredentialSignal: "Credentials / experience",
  hasSocialProofSignal: "Testimonials / case studies", hasPolicySignal: "Policy pages", hasClearProductNaming: "Consistent title + H1 naming",
};

const KEYWORD_USAGE_LABELS = [["title", "Title"], ["metaDescription", "Meta"], ["h1", "H1"], ["h2h3", "H2/H3"], ["alt", "ALT"], ["schema", "Schema"]];

const PRIORITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

/* ============================== tiny text helpers ============================== */

/** Trimmed string; null/undefined become "". */
const s = (v) => (v === undefined || v === null ? "" : String(v).replace(/\r\n?/g, "\n").trim());
const has = (v) => s(v) !== "";
/** Array or [] — and drops null/undefined entries, since a workspace restored from localStorage can contain them. */
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : []);
const byRank = (list, key) => [...arr(list)].sort((a, c) => (PRIORITY_RANK[a?.[key]] ?? 4) - (PRIORITY_RANK[c?.[key]] ?? 4));

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "- **Label:** value" — or null when the value is empty, so gaps just vanish.
 *  Continuation lines are indented so multi-line values stay inside the bullet. */
function bullet(label, value) {
  if (!has(value)) return null;
  return `- **${label}:** ${s(value).replace(/\n/g, "\n  ")}`;
}

/** Several short facts on one bullet: "- **Priority:** High · **Confidence:** Medium" */
function inline(pairs) {
  const parts = pairs.filter(([, v]) => has(v)).map(([k, v]) => `**${k}:** ${s(v)}`);
  return parts.length ? `- ${parts.join(" · ")}` : null;
}

/** Fenced code block that survives content containing backticks. */
function codeBlock(text) {
  const t = s(text);
  const longest = (t.match(/`+/g) || []).reduce((m, run) => Math.max(m, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${t}\n${fence}`;
}

/** Join lines, skipping null/false entries. */
const lines = (...items) => items.flat().filter((x) => x !== null && x !== undefined && x !== false && x !== "").join("\n");
/** Join blocks with a blank line between, skipping empty ones. */
const blocks = (...items) => items.flat().filter((x) => x !== null && x !== undefined && x !== false && s(x) !== "").join("\n\n");

const plural = (n, word) => `${n} ${n === 1 ? word : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`}`;

/* ============================== recommendations ============================== */

/** One grounded recommendation. Fields mirror what RecommendationCard shows
 *  on screen. `heading` is the Markdown heading prefix ("###" inside a list,
 *  "##" when a single card is copied on its own). */
export function formatRecommendation(rec, { heading = "###", index } = {}) {
  const title = s(rec?.title) || "Recommendation";
  return lines(
    `${heading} ${index != null ? `${index}. ` : ""}${title}`,
    inline([["Priority", rec?.priority], ["Confidence", rec?.confidence]]),
    bullet("Module", rec?.module),
    bullet("Why", rec?.why),
    bullet("Evidence from crawl", rec?.evidence),
    bullet("Recommended action", rec?.recommendedAction),
    bullet("Source", rec?.source),
  );
}

function recommendationList(recs) {
  return arr(recs).map((r, i) => formatRecommendation(r, { index: i + 1 })).join("\n\n");
}

/** Merges the grounded opportunities from Keyword Intelligence, AEO, and GEO
 *  into one priority-ranked list. The Dashboard renders the top 8 of this; the
 *  copy button exports all of it. */
export function buildUnifiedRecs(b, limit = Infinity) {
  const list = [];
  arr(b?.siteKeywordClusters?.opportunities).forEach((o) => list.push({
    id: `uni_kw_${o.id}`, module: "Site-wide Keyword Clustering",
    title: o.opportunity, evidence: o.evidence,
    recommendedAction: o.opportunity, priority: o.priority, confidence: "Medium", source: o.source, actionType: "Content Update",
  }));
  arr(b?.siteAeoAnalysis?.contentRecommendations).forEach((r) => list.push({
    id: `uni_aeo_${r.id}`, module: "Site-wide AEO", title: r.recommendation, evidence: r.why,
    recommendedAction: r.recommendation, priority: r.priority, confidence: "Medium", source: r.source, actionType: "FAQ Addition",
  }));
  arr(b?.siteGeoAnalysis?.opportunities).forEach((o) => list.push({
    id: `uni_geo_${o.id}`, module: "Site-wide GEO", title: o.title, evidence: o.why,
    recommendedAction: o.title, priority: o.priority, confidence: "Medium", source: o.source, actionType: "Schema Markup",
  }));
  return byRank(list, "priority").slice(0, limit);
}

/* ============================== sections (each starts with a "##" heading) ============================== */

export function sectionScores(site, b) {
  const sc = { ...(b?.scores || {}), ...(site?.scores || {}) };
  const rows = [
    ["Overall SEO", sc.overall, "from Technical + Content"], ["Technical", sc.technical, "site-wide crawl average"], ["Content", sc.content, "site-wide crawl average"],
    ["AEO", sc.aeo, "VertexRank AI estimate"], ["GEO / AI Visibility", sc.geo, "VertexRank AI estimate"], ["Keyword", sc.keyword, "VertexRank AI estimate"],
  ].filter(([, v]) => v !== null && v !== undefined);
  if (rows.length === 0) return "";
  return lines("## Scores", ...rows.map(([label, v, note]) => `- **${label}:** ${v}/100 (${note})`));
}

export function sectionAiInsights(ai) {
  if (!ai) return "";
  const wins = arr(ai.quickWins).map((qw, i) => blocks(
    lines(
      `#### ${i + 1}. ${s(qw?.title) || "Quick win"}`,
      bullet("Severity", qw?.severity),
      bullet("Why it matters", qw?.why),
    ),
    has(qw?.before) ? `**Before:**\n${codeBlock(qw.before)}` : null,
    has(qw?.after) ? `**After:**\n${codeBlock(qw.after)}` : null,
  ));
  return blocks(
    lines("## VertexRank AI Insights", ai.generatedAt ? `_Generated by VertexRank AI · ${fmtDate(ai.generatedAt)}_` : null),
    has(ai.summary) ? `### What this site is\n${s(ai.summary)}` : null,
    wins.length ? `### Grounded quick wins\n\n${wins.join("\n\n")}` : null,
    has(ai.strategicInsight) ? `### Strategic insight\n${s(ai.strategicInsight)}` : null,
  );
}

export function sectionUnifiedRecs(recs) {
  const list = arr(recs);
  if (list.length === 0) return "";
  return blocks(
    lines("## Unified AI Recommendations", `_${plural(list.length, "recommendation")} from Keyword Intelligence, AEO, and GEO — ranked by priority._`),
    recommendationList(list),
  );
}

export function sectionEntities(entities, heading = "Entities detected on the page") {
  const list = arr(entities).filter((e) => has(e?.entity));
  if (list.length === 0) return "";
  return lines(
    `## ${heading}`,
    "_Crawled data · proper-noun phrases found directly in the page text._",
    ...list.map((e) => `- ${s(e.entity)}${e.occurrences != null ? ` (×${e.occurrences})` : ""}`),
  );
}

export function sectionKeywordOpportunities(intel) {
  const opps = arr(intel?.opportunities);
  if (opps.length === 0) return "";
  const recs = byRank(opps, "priority").map((o) => ({
    title: o.problem, evidence: o.evidence, recommendedAction: o.recommendedAction, priority: o.priority, confidence: o.confidence, source: o.source,
  }));
  return blocks("## Keyword Opportunity Analysis", recommendationList(recs));
}

export function sectionKeywordTable(keywords, heading = "Keywords") {
  const list = arr(keywords);
  if (list.length === 0) return "";
  const items = list.map((k, i) => {
    const where = KEYWORD_USAGE_LABELS.filter(([key]) => k?.usage?.[key]).map(([, label]) => label);
    const body = k?.usage?.body ? `body ×${k.usage.body}` : "";
    const appears = [...where, body].filter(Boolean).join(", ") || "Not found on page";
    const difficulty = k?.difficultyEstimate != null ? `${k.difficultyEstimate}${has(k.difficultyConfidence) ? ` (${s(k.difficultyConfidence)} confidence)` : ""}` : "";
    return lines(
      `### ${i + 1}. ${s(k?.keyword)}`,
      inline([["Type", k?.type], ["Intent", k?.intent], ["Relevance", k?.relevance], ["Difficulty (AI estimate)", difficulty]]),
      bullet("Appears in", appears),
      bullet("Recommended usage", k?.recommendedUsage),
      bullet("Optimization opportunity", k?.opportunity),
      bullet("Source", k?.source),
    );
  });
  return blocks(`## ${heading} (${list.length})`, items.join("\n\n"));
}

export function sectionManualKeywords(keywords) {
  const list = arr(keywords);
  if (list.length === 0) return "";
  return lines(
    `## Manually tracked keywords (${list.length})`,
    ...list.map((k) => {
      const bits = [
        has(k?.intent) ? `Intent: ${s(k.intent)}` : "",
        k?.ranking ? `Rank: #${k.ranking}` : "",
        arr(k?.usage).length ? `Appears in: ${arr(k.usage).join(", ")}` : "",
      ].filter(Boolean);
      return `- **${s(k?.keyword)}**${bits.length ? ` — ${bits.join(" · ")}` : ""}`;
    }),
  );
}

export function sectionAeoOverview(aeo, score) {
  if (!aeo) return "";
  const shown = score ?? aeo.readinessScore;
  const flags = aeo.flags || {};
  return blocks(
    lines(
      "## AEO Readiness",
      shown != null ? `- **Score:** ${shown}/100 — half from the real signal checklist below, half from the average answer-coverage of the generated questions.` : null,
      aeo.generatedAt ? `- **Generated:** ${fmtDate(aeo.generatedAt)}` : null,
    ),
    lines("**Signal checklist**", ...Object.entries(AEO_SIGNAL_LABELS).map(([key, label]) => (flags[key] ? `- ✓ ${label}` : `- ✗ ${label} (missing)`))),
    arr(aeo.existingQuestions).length
      ? lines("**Questions the page already asks in its own text**", ...arr(aeo.existingQuestions).map((q) => `- ${s(q)}`))
      : null,
  );
}

export function sectionAeoRecommendations(aeo) {
  const recs = arr(aeo?.contentRecommendations);
  if (recs.length === 0) return "";
  const list = byRank(recs, "priority").map((r) => ({ title: r.recommendation, evidence: r.why, priority: r.priority, source: r.source }));
  return blocks("## AEO Content Recommendations", recommendationList(list));
}

export function sectionAeoQuestions(questions, heading = "Question & Answer Coverage") {
  const list = arr(questions);
  if (list.length === 0) return "";
  const items = list.map((q, i) => lines(
    `### ${i + 1}. ${s(q?.question)}`,
    inline([["Coverage", q?.coverage], ["Coverage score", q?.coverageScore != null ? `${q.coverageScore}/100` : ""], ["Priority", q?.priority]]),
    inline([["Intent", q?.intent], ["Related keyword", q?.relatedKeyword]]),
    bullet("Missing information", q?.missingInfo),
    bullet("Recommended answer", q?.recommendedAnswer),
    bullet("Source", q?.source),
  ));
  return blocks(`## ${heading} (${list.length})`, items.join("\n\n"));
}

export function sectionManualAeo(questions) {
  const list = arr(questions);
  if (list.length === 0) return "";
  const missing = list.filter((q) => !q?.hasAnswer);
  const answered = list.filter((q) => q?.hasAnswer);
  return blocks(
    "## Manually tracked AEO questions",
    missing.length ? lines("**Needs a direct answer**", ...missing.map((q) => `- ${s(q.question)}`)) : null,
    answered.length ? lines("**Already answered on-site**", ...answered.map((q) => `- ${s(q.question)}`)) : null,
  );
}

export function sectionGeoOverview(geo, score) {
  if (!geo) return "";
  const shown = score ?? geo.visibilityScore;
  const flags = geo.flags || {};
  const factors = GEO_FACTORS.map((f) => {
    const fx = geo.factors?.[f.key];
    if (!fx) return null;
    return lines(`- **${f.label}:** ${fx.score}/100`, has(fx.note) ? `  - ${s(fx.note).replace(/\n/g, "\n    ")}` : null);
  });
  return blocks(
    lines(
      "## GEO / AI Visibility score & factors",
      shown != null ? `- **Score:** ${shown}/100 — 60% from the real signal checklist, 40% from VertexRank AI's judgment of the eight factors below.` : null,
      geo.generatedAt ? `- **Generated:** ${fmtDate(geo.generatedAt)}` : null,
    ),
    lines("**Factors**", ...factors),
    lines("**Authority & Trust Signals** (crawled data)", ...Object.entries(GEO_AUTHORITY_LABELS).map(([key, label]) => (flags[key] ? `- ✓ ${label}` : `- ✗ ${label} (missing)`))),
  );
}

export function sectionGeoOpportunities(geo) {
  const opps = arr(geo?.opportunities);
  if (opps.length === 0) return "";
  const list = byRank(opps, "priority").map((o) => ({ title: o.title, evidence: o.why, priority: o.priority, source: o.source }));
  return blocks("## AI Visibility Opportunities", recommendationList(list));
}

export function sectionSimulator(sim) {
  const list = arr(sim?.queries);
  if (list.length === 0) return "";
  const items = list.map((q, i) => lines(
    `### ${i + 1}. "${s(q?.query)}"`,
    inline([["Answer readiness", q?.answerReadiness], ["Coverage score", q?.coverageScore != null ? `${q.coverageScore}/100` : ""], ["Entity", q?.relevantEntity]]),
    bullet("Missing information", q?.missingInfo),
    bullet("Recommended improvement", q?.recommendedImprovement),
  ));
  return blocks(
    lines("## AI Visibility Simulator", "_VertexRank AI Visibility Simulation — not actual AI search results. This does not call or reflect ChatGPT, Gemini, Perplexity, or Google AI Overviews._", sim?.generatedAt ? `_Generated ${fmtDate(sim.generatedAt)}_` : null),
    items.join("\n\n"),
  );
}

/** One tracked competitor, with its site-wide crawl comparison and AI
 *  interpretation if it has been analyzed. `heading` is "##" when copied on
 *  its own. */
export function formatCompetitor(c, heading = "###", index) {
  const a = c?.siteAnalysis;
  const obs = a?.observed;
  const cmp = obs?.comparison;
  const gaps = arr(a?.interpretation?.gaps);
  const diffs = arr(a?.interpretation?.aeoGeoDifferences);
  return blocks(
    lines(
      `${heading} ${index != null ? `${index}. ` : ""}${s(c?.name) || "Competitor"}`,
      bullet("Website", c?.url),
      a?.generatedAt ? bullet("Analyzed", fmtDate(a.generatedAt)) : null,
    ),
    obs ? lines(
      `**Site-wide observed data** (${obs.ourPagesCrawled} of our pages vs ${obs.competitorPagesCrawled} of theirs)`,
      cmp ? inline([["Avg. word count", `${cmp.avgWordCount?.ours} vs ${cmp.avgWordCount?.competitor}`], ["Orphan page rate", `${cmp.orphanPageRatioPct?.ours}% vs ${cmp.orphanPageRatioPct?.competitor}%`], ["AEO readiness", `${cmp.aeoReadiness?.ours} vs ${cmp.aeoReadiness?.competitor}`], ["GEO visibility", `${cmp.geoVisibility?.ours} vs ${cmp.geoVisibility?.competitor}`]]) : null,
      arr(obs.competitorOnlyTopics).length ? bullet("Topics they cover across their site that we don't", arr(obs.competitorOnlyTopics).join(", ")) : null,
    ) : null,
    a?.interpretation ? blocks(
      `**VertexRank AI interpretation**\n${s(a.interpretation.summary)}`,
      gaps.length ? gaps.map((g, i) => lines(
        `${i + 1}. **${s(g.gap)}**${has(g.priority) ? ` (Priority: ${s(g.priority)})` : ""}`,
        has(g.evidence) ? `   - Evidence: ${s(g.evidence).replace(/\n/g, " ")}` : null,
        has(g.recommendedAction) ? `   - Recommended action: ${s(g.recommendedAction).replace(/\n/g, " ")}` : null,
      )).join("\n") : null,
      diffs.length ? blocks(
        "**AEO/GEO differences**",
        diffs.map((d, i) => lines(
          `${i + 1}. **${s(d.difference)}**${has(d.priority) ? ` (Priority: ${s(d.priority)})` : ""}`,
          has(d.recommendedAction) ? `   - Recommended action: ${s(d.recommendedAction).replace(/\n/g, " ")}` : null,
        )).join("\n"),
      ) : null,
    ) : null,
  );
}

export function sectionCompetitorSuggestions(list) {
  const items = arr(list);
  if (items.length === 0) return "";
  return lines(
    "## AI-suggested competitors",
    "_VertexRank AI's best guess from general knowledge of this industry — not a live search. Verify the name and URL before relying on it._",
    ...items.map((x) => `- **${s(x?.name)}**${has(x?.url) ? ` (${s(x.url)})` : ""}${has(x?.confidence) ? ` — ${s(x.confidence)} confidence` : ""}${has(x?.reason) ? `: ${s(x.reason).replace(/\n/g, " ")}` : ""}`),
  );
}

export function sectionCompetitors(competitors) {
  const list = arr(competitors);
  if (list.length === 0) return "";
  return blocks(`## Competitors (${list.length})`, list.map((c, i) => formatCompetitor(c, "###", i + 1)));
}

/** One content idea. `heading` is "##" when copied on its own. */
export function formatContentIdea(c, heading = "###", index) {
  return lines(
    `${heading} ${index != null ? `${index}. ` : ""}${s(c?.title) || "Content idea"}`,
    inline([["Status", c?.status], ["Intent", c?.intent]]),
    bullet("Primary keyword", c?.primaryKeyword),
    arr(c?.secondaryKeywords).length ? bullet("Secondary keywords", arr(c.secondaryKeywords).join(", ")) : null,
    bullet("Rationale", c?.rationale),
    arr(c?.questions).length ? lines("- **Questions to answer:**", ...arr(c.questions).map((q) => `  - ${s(q)}`)) : null,
    arr(c?.outline).length ? lines("- **Outline:**", ...arr(c.outline).map((o, i) => `  ${i + 1}. ${s(o)}`)) : null,
    bullet("AEO notes", c?.aeoRecs),
    bullet("GEO notes", c?.geoRecs),
    bullet("Source", c?.source),
  );
}

export function sectionContentIdeas(ideas) {
  const list = arr(ideas);
  if (list.length === 0) return "";
  return blocks(`## Content ideas (${list.length})`, list.map((c, i) => formatContentIdea(c, "###", i + 1)));
}

export function sectionInternalLinks(links) {
  const list = arr(links);
  if (list.length === 0) return "";
  const items = list.map((l, i) => lines(
    `### ${i + 1}. ${s(l?.source)} → ${s(l?.target)}`,
    bullet("Suggested anchor text", l?.anchor),
    bullet("Reason", l?.reason),
    bullet("Status", l?.status === "Applied" ? "Applied" : "Suggested"),
  ));
  return blocks(`## Internal link opportunities (${list.length})`, items.join("\n\n"));
}

export function sectionBacklinks(list) {
  const items = arr(list);
  if (items.length === 0) return "";
  const rows = items.map((o, i) => lines(
    `### ${i + 1}. ${s(o?.name)}`,
    inline([["Type", o?.type], ["Difficulty", o?.difficulty], ["Status", o?.status]]),
    bullet("Notes", o?.description),
  ));
  return blocks(`## Backlink opportunities (${items.length})`, rows.join("\n\n"));
}

/** One audit issue. `heading` is "##" when copied on its own. */
export function formatIssue(i, heading = "###", index) {
  const fix = i?.aiFix;
  return blocks(
    lines(
      `${heading} ${index != null ? `${index}. ` : ""}[${s(i?.severity) || "—"}] ${s(i?.title)}`,
      inline([["Category", i?.category], ["Status", i?.status], ["Affected URLs", i?.affectedUrls], ["Source", i?.source === "live" ? "Live scan" : i?.source ? "Simulated" : ""]]),
      bullet("Why it matters", i?.why),
      bullet("Recommended fix", i?.fix),
    ),
    has(i?.before) ? `**Current content:**\n${codeBlock(i.before)}` : null,
    fix ? blocks(
      "**AI fix (applied)**",
      has(fix.before) ? `Before:\n${codeBlock(fix.before)}` : null,
      has(fix.after) ? `After:\n${codeBlock(fix.after)}` : null,
      has(fix.explanation) ? s(fix.explanation) : null,
    ) : null,
  );
}

export function sectionAuditIssues(issues) {
  const list = byRank(issues, "severity");
  if (list.length === 0) return "";
  const counts = ["Critical", "High", "Medium", "Low"].map((sev) => [sev, list.filter((i) => i.severity === sev).length]).filter(([, n]) => n > 0);
  return blocks(
    lines(`## SEO Audit issues (${list.length})`, counts.length ? `_${counts.map(([sev, n]) => `${n} ${sev}`).join(" · ")} — most severe first._` : null),
    list.map((i, idx) => formatIssue(i, "###", idx + 1)),
  );
}

const AUDIT_SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

/** The full list of site-wide SEO Audit issues (orphan pages, duplicate
 *  titles/meta, near-duplicate content, plus every recurring per-page issue)
 *  for a full-site crawl — sorted the same way the Site-wide Audit screen
 *  sorts them. Pure function of `crawl` (lib/siteCrawler.js output) so the
 *  UI and the copy-export can share this and never drift. */
export function computeSiteAuditIssues(crawl) {
  if (!crawl) return [];
  const sw = crawl.siteWide;
  const siteLevel = [];
  if (sw.orphanPages.length > 0) siteLevel.push({
    id: "site_orphan", category: "Internal Linking", severity: "Medium",
    title: `${sw.orphanPages.length} orphan page${sw.orphanPages.length === 1 ? "" : "s"} — no internal links point to them`,
    why: "A page nothing else on the site links to is hard for search engines (and visitors) to find, even if it's in the sitemap.",
    fix: "Add at least one contextual internal link to each orphan page from a related page.", urls: sw.orphanPages,
  });
  if (sw.weakLinkedPages.length > 0) siteLevel.push({
    id: "site_weak", category: "Internal Linking", severity: "Low",
    title: `${sw.weakLinkedPages.length} page${sw.weakLinkedPages.length === 1 ? "" : "s"} with only one internal link pointing to them`,
    why: "A page with only one inbound internal link passes very little authority and is easy to lose track of.",
    fix: "Add a second contextual internal link from another related page.", urls: sw.weakLinkedPages,
  });
  sw.duplicateTitles.forEach((g, idx) => siteLevel.push({
    id: `site_duptitle_${idx}`, category: "On-Page", severity: "High",
    title: `Duplicate page title used on ${g.urls.length} pages: "${g.value}"`,
    why: "Identical titles make it hard for search engines to tell these pages apart, and one may simply be ignored.",
    fix: "Write a unique, specific title for each of these pages.", urls: g.urls,
  }));
  sw.duplicateMetaDescriptions.forEach((g, idx) => siteLevel.push({
    id: `site_dupmeta_${idx}`, category: "On-Page", severity: "Medium",
    title: `Duplicate meta description used on ${g.urls.length} pages`,
    why: "A duplicated description wastes the chance to differentiate each page in search results.",
    fix: "Write a unique meta description for each page summarizing what's actually on it.", urls: g.urls,
  }));
  sw.nearDuplicateContentPairs.forEach((p, idx) => siteLevel.push({
    id: `site_dupcontent_${idx}`, category: "Content", severity: "Medium",
    title: `Near-duplicate content (${p.similarity}% similar)`,
    why: "Two pages that say almost the same thing compete with each other in search instead of ranking together for more.",
    fix: "Differentiate the two pages' angle and content, or merge them and redirect one to the other.", urls: [p.urlA, p.urlB],
  }));
  const recurring = sw.recurringIssues.map((e, idx) => ({ ...e, id: `rec_${idx}` }));
  return [...siteLevel, ...recurring].sort((a, c) => (AUDIT_SEVERITY_RANK[a.severity] ?? 9) - (AUDIT_SEVERITY_RANK[c.severity] ?? 9) || c.urls.length - a.urls.length);
}

/** One site-wide SEO Audit issue (real crawl finding, urls-based — not the
 *  old single-page affectedUrls/status/aiFix shape). `heading` is "##" when
 *  copied on its own. */
export function formatSiteAuditIssue(i, heading = "###", index) {
  return lines(
    `${heading} ${index != null ? `${index}. ` : ""}[${s(i?.severity) || "—"}] ${s(i?.title)}`,
    inline([["Category", i?.category], ["Affected URLs", arr(i?.urls).length]]),
    bullet("Why it matters", i?.why),
    bullet("Recommended fix", i?.fix),
    arr(i?.urls).length ? bullet("URLs", arr(i.urls).slice(0, 10).join(", ") + (arr(i.urls).length > 10 ? ", …" : "")) : null,
  );
}

export function sectionSiteAuditIssues(issues) {
  const list = arr(issues);
  if (list.length === 0) return "";
  const counts = ["Critical", "High", "Medium", "Low"].map((sev) => [sev, list.filter((i) => i.severity === sev).length]).filter(([, n]) => n > 0);
  return blocks(
    lines(`## SEO Audit issues (${list.length})`, counts.length ? `_${counts.map(([sev, n]) => `${n} ${sev}`).join(" · ")} — most severe first._` : null),
    list.map((i, idx) => formatSiteAuditIssue(i, "###", idx + 1)),
  );
}

export function sectionPositives(positives) {
  const list = arr(positives);
  if (list.length === 0) return "";
  return lines("## What's working well", ...list.map((p) => `- **${s(p?.title)}**${has(p?.detail) ? ` — ${s(p.detail).replace(/\n/g, " ")}` : ""}`));
}

/** One Action Center item. `heading` is "##" when copied on its own. */
export function formatAction(a, heading = "###", index) {
  const d = a?.detail || {};
  return lines(
    `${heading} ${index != null ? `${index}. ` : ""}${s(a?.title) || "Action"}`,
    inline([["Status", a?.status], ["Type", a?.type], ["Created", fmtDate(a?.createdAt)]]),
    inline([["Priority", d.priority], ["Confidence", d.confidence]]),
    bullet("Module", d.module),
    bullet("Evidence from crawl", d.evidence),
    bullet("Recommended action", d.recommendedAction),
    bullet("Source", d.source),
  );
}

export function sectionActions(actions) {
  const list = arr(actions);
  if (list.length === 0) return "";
  const byStatus = {};
  list.forEach((a) => { byStatus[a?.status || "New"] = (byStatus[a?.status || "New"] || 0) + 1; });
  const summary = Object.entries(byStatus).map(([st, n]) => `${n} ${st}`).join(" · ");
  return blocks(
    lines(`## Actions (${list.length})`, `_${summary}_`),
    list.map((a, i) => formatAction(a, "###", i + 1)),
  );
}

/* ============================== page-level exports ============================== */

function pageHeader(title, site, b) {
  const crawled = b?.siteCrawl ? `**Last crawl:** ${plural(b.siteCrawl.pagesCrawled, "page")}${b.siteCrawl.truncated ? " (partial)" : ""}` : "";
  const where = [site?.url, site?.country].filter(Boolean).join(" · ");
  return lines(
    `# VertexRank — ${title}`,
    where ? `**Website:** ${where}` : null,
    [`**Copied:** ${fmtDate(new Date())}`, crawled].filter(Boolean).join(" · "),
  );
}

function wrapPage(title, site, b, sections) {
  const body = blocks(sections);
  return body ? `${pageHeader(title, site, b)}\n\n${body}\n` : "";
}

export const PAGE_TITLES = {
  dashboard: "Dashboard", audit: "SEO Audit", actions: "Action Center", keywords: "Keyword Intelligence", aeo: "AEO",
  geo: "GEO / AI Visibility", competitors: "Competitors", content: "Content Planner", links: "Internal Links", backlinks: "Backlink Radar",
};

/** Site-wide keyword clusters (clusters, cannibalization guidance, strategy
 *  opportunities) — the sole Keyword Intelligence output now that keyword
 *  analysis is site-wide only. */
export function sectionKeywordClusters(data) {
  if (!data) return "";
  const overview = lines(
    "## Site-wide Keyword Intelligence overview",
    `- **Site:** ${s(data.domain)} · ${plural(data.pagesCrawled, "page")} crawled`,
    `- **Totals:** ${plural(arr(data.clusters).length, "cluster")} · ${plural(arr(data.opportunities).length, "opportunity")} · ${plural(arr(data.cannibalizationGuidance).length, "cannibalization risk")}`,
  );
  const cannibal = arr(data.cannibalizationGuidance).length ? blocks(
    "## Keyword cannibalization",
    arr(data.cannibalizationGuidance).map((g, i) => {
      const c = arr(data.cannibalization).find((x) => x.clusterId === g.clusterId);
      return lines(
        `### ${i + 1}. ${arr(c?.keywords).slice(0, 4).join(", ") || "Competing pages"}`,
        inline([["Recommended action", g.recommendedAction]]),
        bullet("Explanation", g.explanation),
        bullet("Reasoning", g.reasoning),
        arr(c?.competingPages).length ? bullet("Competing pages", arr(c.competingPages).map((p) => p.title || p.url).join(", ")) : null,
      );
    }).join("\n\n"),
  ) : "";
  const opps = arr(data.opportunities).length ? blocks(
    "## Keyword strategy opportunities",
    byRank(data.opportunities, "priority").map((o, i) => lines(
      `### ${i + 1}. ${s(o.opportunity)}`,
      inline([["Priority", o.priority]]),
      bullet("Evidence", o.evidence),
      bullet("Source", o.source),
    )).join("\n\n"),
  ) : "";
  const clusters = arr(data.clusters).length ? lines(
    `## Clusters (${arr(data.clusters).length})`,
    ...arr(data.clusters).map((c) => `- **${s(c.label)}** — ${arr(c.keywords).join(", ")}${has(c.insight) ? ` — ${s(c.insight)}` : ""}`),
  ) : "";
  return blocks(overview, cannibal, opps, clusters);
}

/* Each page's sections, split out so the full report can reuse them. */
const PAGE_SECTIONS = {
  dashboard: (site, b) => {
    const issues = arr(b?.siteCrawl?.siteWide?.recurringIssues);
    const crit = issues.filter((i) => i.severity === "Critical" || i.severity === "High");
    const quick = issues.filter((i) => i.severity === "Low" || i.severity === "Medium");
    const issueList = (title, list) => (list.length ? lines(`## ${title} (${list.length})`, ...byRank(list, "severity").map((i) => `- [${s(i.severity)}] ${s(i.title)}`)) : "");
    return [
      sectionScores(site, b), sectionAiInsights(b?.siteInsights), sectionUnifiedRecs(buildUnifiedRecs(b)),
      issueList("Critical issues", crit), issueList("Quick wins", quick),
    ];
  },
  audit: (site, b) => [sectionSiteAuditIssues(computeSiteAuditIssues(b?.siteCrawl))],
  actions: (site, b) => [sectionActions(b?.actions)],
  keywords: (site, b) => [sectionKeywordClusters(b?.siteKeywordClusters), sectionManualKeywords(b?.keywords)],
  aeo: (site, b) => [
    sectionAeoOverview(b?.siteAeoAnalysis, b?.scores?.aeo), sectionAeoRecommendations(b?.siteAeoAnalysis), sectionAeoQuestions(b?.siteAeoAnalysis?.questions),
    sectionManualAeo(b?.aeoQuestions),
  ],
  geo: (site, b) => [sectionGeoOverview(b?.siteGeoAnalysis, b?.scores?.geo), sectionGeoOpportunities(b?.siteGeoAnalysis), sectionSimulator(b?.aiVisibility)],
  competitors: (site, b) => [sectionCompetitorSuggestions(b?.competitorSuggestions), sectionCompetitors(b?.competitors)],
  content: (site, b) => [sectionContentIdeas(b?.contentIdeas)],
  links: (site, b) => [sectionInternalLinks(b?.internalLinks)],
  backlinks: (site, b) => [sectionBacklinks(b?.backlinks)],
};

const pageExporter = (id) => (site, b) => wrapPage(PAGE_TITLES[id], site, b, PAGE_SECTIONS[id](site, b));

export const exportDashboard = pageExporter("dashboard");
export const exportAudit = pageExporter("audit");
export const exportActions = pageExporter("actions");
export const exportKeywords = pageExporter("keywords");
export const exportAeo = pageExporter("aeo");
export const exportGeo = pageExporter("geo");
export const exportCompetitors = pageExporter("competitors");
export const exportContent = pageExporter("content");
export const exportInternalLinks = pageExporter("links");
export const exportBacklinks = pageExporter("backlinks");

/** view id → "copy everything on this page" exporter. */
export const PAGE_EXPORTERS = {
  dashboard: exportDashboard, audit: exportAudit, actions: exportActions, keywords: exportKeywords, aeo: exportAeo,
  geo: exportGeo, competitors: exportCompetitors, content: exportContent, links: exportInternalLinks, backlinks: exportBacklinks,
};

/** Every page, one document. Pages with nothing yet are listed at the end
 *  rather than silently missing, so it's clear what hasn't been run. */
export function exportFullReport(site, b) {
  const order = ["dashboard", "audit", "actions", "keywords", "aeo", "geo", "competitors", "content", "links", "backlinks"];
  const parts = [];
  const empty = [];
  order.forEach((id) => {
    // The dashboard's issue lists would just repeat the SEO Audit section below.
    const sections = blocks(PAGE_SECTIONS[id](site, b).filter((sec) => !(id === "dashboard" && /^## (Critical issues|Quick wins|What's working well)/.test(sec))));
    if (sections) parts.push(`# ${PAGE_TITLES[id]}\n\n${sections}`);
    else empty.push(PAGE_TITLES[id]);
  });
  if (parts.length === 0) return "";
  const tail = empty.length ? `\n\n---\n_No data yet for: ${empty.join(", ")}._` : "";
  return `${pageHeader("Full report", site, b)}\n\n${parts.join("\n\n---\n\n")}${tail}\n`;
}

/* ============================== browser helper ============================== */

/** Copies text to the clipboard. Uses the async Clipboard API where allowed
 *  (secure context), and falls back to a hidden textarea + execCommand for
 *  http:// previews and older browsers. Resolves true on success. */
export async function copyTextToClipboard(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof window !== "undefined" && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* permission denied or unsupported — try the legacy path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
