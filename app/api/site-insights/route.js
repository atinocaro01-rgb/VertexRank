import { callOpenRouterJson } from "../../../lib/openrouter";
import { truncate } from "../../../lib/textIntelligence";

// Site-wide AI Insights: reads the full-site crawl (every page's real
// technical/on-page issues, already computed deterministically by
// lib/siteCrawler.js) plus whichever other site-wide modules (AEO, GEO,
// keyword clustering, internal linking) have already been run, and writes
// ONE executive summary across all of it. It's a roll-up of real,
// already-computed findings — never a fresh guess at facts the crawl and
// other modules didn't produce.

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const { crawl, siteAeoAnalysis, siteGeoAnalysis, siteKeywordClusters, internalLinkRecs } = body || {};
  if (!crawl?.domain || !Array.isArray(crawl.pages)) {
    return Response.json({ error: "A full-site crawl is required. Run one from Websites first." }, { status: 400 });
  }

  const sw = crawl.siteWide || {};
  const homepage = crawl.pages.find((p) => p.url === crawl.startUrl) || crawl.pages[0] || {};

  const recurringIssuesList = (sw.recurringIssues || [])
    .slice(0, 8)
    .map((i) => `- [${i.severity}] ${i.title} — affects ${i.count} pages — ${i.why}`)
    .join("\n") || "(none found)";

  const siteLevelFacts = [
    sw.orphanPages?.length ? `${sw.orphanPages.length} orphan page(s) with no internal links pointing to them` : null,
    sw.weakLinkedPages?.length ? `${sw.weakLinkedPages.length} page(s) with only one internal link pointing to them` : null,
    sw.duplicateTitles?.length ? `${sw.duplicateTitles.length} group(s) of pages sharing a duplicate title` : null,
    sw.duplicateMetaDescriptions?.length ? `${sw.duplicateMetaDescriptions.length} group(s) of pages sharing a duplicate meta description` : null,
    sw.nearDuplicateContentPairs?.length ? `${sw.nearDuplicateContentPairs.length} pair(s) of near-duplicate content pages` : null,
  ].filter(Boolean).join("; ") || "none detected";

  const modulesSummary = [
    siteAeoAnalysis ? `AEO readiness score: ${siteAeoAnalysis.readinessScore}/100. Top content gap: ${siteAeoAnalysis.contentRecommendations?.[0]?.recommendation || "none flagged"}.` : "Site-wide AEO analysis not run yet.",
    siteGeoAnalysis ? `GEO visibility score: ${siteGeoAnalysis.visibilityScore}/100. Top opportunity: ${siteGeoAnalysis.opportunities?.[0]?.title || "none flagged"}.` : "Site-wide GEO analysis not run yet.",
    siteKeywordClusters ? `${siteKeywordClusters.clusterCount} keyword clusters found, ${siteKeywordClusters.cannibalizationCount} with cannibalization risk.` : "Site-wide keyword clustering not run yet.",
    internalLinkRecs ? `${internalLinkRecs.orphanPageCount} orphan / ${internalLinkRecs.weakLinkedPageCount} weakly-linked pages with recommended internal links generated.` : "Internal-link recommendations not run yet.",
  ].join("\n");

  const system = `You are VertexRank AI, a precise, detail-oriented SEO analyst reasoning about an ENTIRE crawled website, not one page. You never invent facts, page counts, traffic numbers, or search volumes beyond what's given. If a module below says it hasn't been run yet, don't pretend to know its results — you can note that running it would help, but don't guess its outcome. Your tone is direct and specific, like a consultant who actually read the crawl.`;

  const prompt = `Website: ${crawl.domain}
Pages crawled: ${crawl.pagesCrawled} of ${crawl.pagesDiscovered} discovered (${crawl.truncated ? "crawl was truncated by the page/time limit" : "complete"})
Site technical score: ${crawl.siteScores?.technical ?? "n/a"}/100 · Site content score: ${crawl.siteScores?.content ?? "n/a"}/100
Homepage title: "${homepage.title || "(missing)"}"
Homepage meta description: "${homepage.metaDescription || "(missing)"}"
Homepage text (truncated): "${truncate(homepage.fullText, 1200)}"

Recurring technical/on-page issues across the site:
${recurringIssuesList}

Site-structure findings: ${siteLevelFacts}

Other site-wide modules:
${modulesSummary}

Do three things:

1. SUMMARY: In 2-4 sentences, describe what this website/business does and who it's for, based only on the homepage content above. If there isn't enough here to say something specific, say so honestly.

2. QUICK WINS: Pick the 2-4 most impactful findings from the recurring issues and site-structure findings above (not the "other site-wide modules" section, since those aren't detailed here) and write a concrete fix for each. Use "before"/"after" only when you can ground "before" in real text given above (e.g. the homepage title/description) — otherwise describe the real absence (e.g. "no canonical tag found on these pages") rather than inventing a "before".

3. STRATEGIC INSIGHT: One paragraph, 120-180 words, direct and opinionated, weighing the technical/on-page findings against whichever of the other site-wide modules have actually been run (mention plainly if a relevant module hasn't been run yet and would sharpen this). No invented numbers beyond what's given above.

Respond with ONLY a JSON object, no markdown code fences, no commentary, in exactly this shape:
{
  "summary": "string",
  "quickWins": [
    { "title": "string", "category": "string", "severity": "string", "why": "string", "before": "string", "after": "string" }
  ],
  "strategicInsight": "string"
}`;

  try {
    const insights = await callOpenRouterJson({ system, prompt, maxTokens: 2200, temperature: 0.55 });
    if (!insights.summary || !Array.isArray(insights.quickWins) || !insights.strategicInsight) {
      throw new Error("VertexRank AI's response was missing required fields.");
    }
    return Response.json({ insights });
  } catch (err) {
    return Response.json({ error: err.message || "VertexRank AI couldn't generate site-wide insights. Try again." }, { status: 502 });
  }
}
