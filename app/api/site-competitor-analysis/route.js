import { callOpenRouterJson } from "../../../lib/openrouter";
import { crawlSite } from "../../../lib/siteCrawler";
import { extractKeywordCandidates, computeAeoSignals, computeGeoSignals, scoreFromFlags } from "../../../lib/textIntelligence";
import { aggregateSiteFlags } from "../../../lib/siteSignals";

// Site-wide competitor analysis: crawls the COMPETITOR's whole site (the
// client's own site should already have been crawled via /api/site-scan and
// is passed in as `ourCrawl`) and compares them — content gaps, topic
// overlap, AEO/GEO differences, and opportunities.
//
// Time budget: this route does its OWN crawl (of the competitor) inside an
// already-60s-limited function, so the competitor crawl gets a tighter
// internal budget than /api/site-scan's default, leaving real headroom for
// the AI comparison call afterward.

export const runtime = "nodejs";
export const maxDuration = 60;

const AEO_WEIGHTS = { hasFaqSchema: 18, hasHowToSchema: 6, hasQaSchema: 6, hasAnySchema: 8, hasListMarkup: 10, hasTableMarkup: 6, hasMultipleHeadings: 12, hasQuestionHeading: 12, hasDirectAnswerParagraph: 10, hasExistingQuestionsInBody: 6, contentDepthOk: 6 };
const GEO_WEIGHTS = { hasOrganizationSchema: 16, hasProductOrServiceSchema: 10, hasArticleOrAuthorSchema: 6, hasContactSignal: 12, hasAboutSignal: 12, hasLocationSignal: 10, hasAudienceSignal: 10, hasCredentialSignal: 8, hasSocialProofSignal: 10, hasPolicySignal: 4, hasClearProductNaming: 2 };

function topicSet(pages, limit) {
  const scores = new Map();
  for (const page of pages) {
    for (const c of extractKeywordCandidates(page, 30)) {
      scores.set(c.keyword, (scores.get(c.keyword) || 0) + (c.score || 0));
    }
  }
  return new Map([...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit));
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const { competitorUrl, ourCrawl } = body || {};
  if (!competitorUrl?.trim()) return Response.json({ error: "A competitor URL is required." }, { status: 400 });
  if (!ourCrawl?.pages?.length) return Response.json({ error: "Crawl your own site first before comparing competitors." }, { status: 400 });

  const competitorCrawl = await crawlSite(competitorUrl, { maxPages: 25, timeBudgetMs: 35000 });
  if (competitorCrawl.error) return Response.json({ error: competitorCrawl.error }, { status: 400 });
  if (competitorCrawl.pagesCrawled === 0) {
    return Response.json({ error: "Couldn't reach any pages on the competitor's site. Check the URL and try again." }, { status: 502 });
  }

  // ---- deterministic, site-wide comparison (no AI) ----
  const ourTopics = topicSet(ourCrawl.pages, 60);
  const competitorTopics = topicSet(competitorCrawl.pages, 60);
  const sharedTopics = [...competitorTopics.keys()].filter((k) => ourTopics.has(k));
  const competitorOnlyTopics = [...competitorTopics.keys()].filter((k) => !ourTopics.has(k));
  const ourOnlyTopics = [...ourTopics.keys()].filter((k) => !competitorTopics.has(k));

  const ourAeo = aggregateSiteFlags(ourCrawl.pages, computeAeoSignals);
  const compAeo = aggregateSiteFlags(competitorCrawl.pages, computeAeoSignals);
  const ourGeo = aggregateSiteFlags(ourCrawl.pages, computeGeoSignals);
  const compGeo = aggregateSiteFlags(competitorCrawl.pages, computeGeoSignals);

  const ourSchema = [...new Set(ourCrawl.pages.flatMap((p) => p.schemaTypes || []))];
  const compSchema = [...new Set(competitorCrawl.pages.flatMap((p) => p.schemaTypes || []))];

  const avgWords = (pages) => (pages.length ? Math.round(pages.reduce((s, p) => s + (p.wordCount || 0), 0) / pages.length) : 0);
  const orphanRatio = (crawl) => (crawl.pagesCrawled ? Math.round(((crawl.siteWide?.orphanPages?.length || 0) / crawl.pagesCrawled) * 100) : 0);

  const observed = {
    ourDomain: ourCrawl.domain,
    competitorDomain: competitorCrawl.domain,
    ourPagesCrawled: ourCrawl.pages.length,
    competitorPagesCrawled: competitorCrawl.pages.length,
    sharedTopics: sharedTopics.slice(0, 25),
    competitorOnlyTopics: competitorOnlyTopics.slice(0, 25),
    ourOnlyTopics: ourOnlyTopics.slice(0, 25),
    comparison: {
      avgWordCount: { ours: avgWords(ourCrawl.pages), competitor: avgWords(competitorCrawl.pages) },
      schemaTypes: { ours: ourSchema, competitor: compSchema },
      orphanPageRatioPct: { ours: orphanRatio(ourCrawl), competitor: orphanRatio(competitorCrawl) },
      aeoReadiness: { ours: scoreFromFlags(ourAeo.siteFlags, AEO_WEIGHTS).score, competitor: scoreFromFlags(compAeo.siteFlags, AEO_WEIGHTS).score },
      geoVisibility: { ours: scoreFromFlags(ourGeo.siteFlags, GEO_WEIGHTS).score, competitor: scoreFromFlags(compGeo.siteFlags, GEO_WEIGHTS).score },
    },
  };

  // ---- AI layer ----
  const system = `You are VertexRank AI comparing two real, freshly crawled websites at the site level. Everything you say must be grounded in the real observed comparison data given — topic lists, schema types, scores. You never claim to know search rankings, traffic, or backlink counts for either site, and you never invent topics not in the lists given.`;

  const prompt = `Our site: ${ourCrawl.domain} (${ourCrawl.pages.length} pages crawled)
Competitor: ${competitorCrawl.domain} (${competitorCrawl.pages.length} pages crawled)

Shared topics (both sites appear to cover): ${sharedTopics.slice(0, 20).join(", ") || "(none detected)"}
Topics only the competitor covers: ${competitorOnlyTopics.slice(0, 20).join(", ") || "(none detected)"}
Topics only we cover: ${ourOnlyTopics.slice(0, 20).join(", ") || "(none detected)"}

Average word count per page — ours: ${observed.comparison.avgWordCount.ours}, competitor: ${observed.comparison.avgWordCount.competitor}
Schema types used — ours: ${ourSchema.join(", ") || "none"}; competitor: ${compSchema.join(", ") || "none"}
Orphan page rate — ours: ${observed.comparison.orphanPageRatioPct.ours}%, competitor: ${observed.comparison.orphanPageRatioPct.competitor}%
Site-wide AEO readiness score (0-100) — ours: ${observed.comparison.aeoReadiness.ours}, competitor: ${observed.comparison.aeoReadiness.competitor}
Site-wide GEO visibility score (0-100) — ours: ${observed.comparison.geoVisibility.ours}, competitor: ${observed.comparison.geoVisibility.competitor}

Write:
1. A 3-4 sentence factual comparison summary grounded in the data above.
2. Up to 8 content-gap recommendations for our site — prioritize topics the competitor covers that we don't, each with: gap, evidence (cite the real data above), recommendedAction, priority (Critical|High|Medium|Low).
3. Up to 4 AEO/GEO-specific differences worth acting on, grounded in the score/schema comparison above.

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "summary": "string",
  "gaps": [ { "gap": "string", "evidence": "string", "recommendedAction": "string", "priority": "string" } ],
  "aeoGeoDifferences": [ { "difference": "string", "recommendedAction": "string", "priority": "string" } ]
}`;

  // The full competitor crawl (not just the derived `observed` summary) is
  // returned alongside the comparison so the client can feed it straight
  // into /api/backlink-opportunities to auto-discover backlink prospects
  // from THIS competitor without a second crawl and without the user
  // manually entering a URL anywhere — see the "Discover from this
  // competitor" flow in the Competitors tab.
  try {
    const interpretation = await callOpenRouterJson({ system, prompt, maxTokens: 2000, temperature: 0.5 });
    return Response.json({
      result: {
        observed,
        interpretation: {
          summary: interpretation.summary || "",
          gaps: (interpretation.gaps || []).map((g, idx) => ({ id: `scgap_${idx}`, ...g, source: "VertexRank AI Interpretation" })),
          aeoGeoDifferences: (interpretation.aeoGeoDifferences || []).map((d, idx) => ({ id: `scaeo_${idx}`, ...d, source: "VertexRank AI Interpretation" })),
        },
        generatedAt: new Date().toISOString(),
      },
      competitorCrawl,
    });
  } catch (err) {
    // The real crawl comparison never depended on the AI step, so it's
    // still returned even if the interpretation call fails.
    return Response.json({
      result: { observed, interpretation: null, generatedAt: new Date().toISOString() },
      warning: err.message || "VertexRank AI couldn't generate an interpretation, but the observed comparison above is real crawl data.",
      competitorCrawl,
    });
  }
}
