import { callOpenRouterJson } from "../../../lib/openrouter";
import { crawlPage } from "../../../lib/crawler";
import { extractKeywordCandidates, computeAeoSignals, computeGeoSignals, truncate } from "../../../lib/textIntelligence";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const { competitorUrl, scanMeta, ourKeywords } = body || {};
  if (!competitorUrl?.trim()) return Response.json({ error: "A competitor URL is required." }, { status: 400 });
  if (!scanMeta?.domain) return Response.json({ error: "Scan your own site first before comparing competitors." }, { status: 400 });

  const competitor = await crawlPage(competitorUrl);
  if (competitor.error) return Response.json({ error: competitor.error }, { status: 502 });

  // Observed competitor data — computed directly from their real, publicly
  // crawlable page. No fabricated rankings or traffic figures.
  const competitorKeywords = extractKeywordCandidates(competitor, 40).map((k) => k.keyword);
  const ourKeywordSet = new Set((ourKeywords || []).map((k) => String(k).toLowerCase()));
  const sharedTopics = competitorKeywords.filter((k) => ourKeywordSet.has(k.toLowerCase())).slice(0, 20);
  const competitorOnlyTopics = competitorKeywords.filter((k) => !ourKeywordSet.has(k.toLowerCase())).slice(0, 20);

  const aeoFlags = computeAeoSignals(competitor);
  const geoFlags = computeGeoSignals(competitor);

  const observed = {
    domain: competitor.domain,
    title: competitor.title,
    wordCount: competitor.wordCount,
    schemaTypes: competitor.schemaTypes,
    headingCount: (competitor.h2Texts?.length || 0) + (competitor.h3Texts?.length || 0),
    sharedTopics,
    competitorOnlyTopics,
    aeoFlags,
    geoFlags,
  };

  const system = `You are VertexRank AI comparing two real, freshly crawled websites. Everything you say must be grounded in the two real pages of content given. You clearly distinguish facts observed directly in the crawl from your own interpretation, and you never claim to know search rankings, traffic, or backlink counts for either site.`;

  const prompt = `Our site: ${scanMeta.domain}
Our title: "${scanMeta.title || "(missing)"}"
Our content (truncated): "${truncate(scanMeta.fullText || scanMeta.bodySnippet, 1500)}"

Competitor site: ${competitor.domain}
Competitor title: "${competitor.title || "(missing)"}"
Competitor content (truncated): "${truncate(competitor.fullText || competitor.bodySnippet, 1500)}"

Observed comparison data (from the real crawls):
- Topics/keywords both sites appear to cover: ${sharedTopics.join(", ") || "(none detected)"}
- Topics the competitor covers that we don't appear to: ${competitorOnlyTopics.slice(0, 15).join(", ") || "(none detected)"}
- Competitor word count: ${competitor.wordCount}, ours: ${scanMeta.wordCount}
- Competitor schema types: ${competitor.schemaTypes.join(", ") || "none"}, ours: ${(scanMeta.schemaTypes || []).join(", ") || "none"}

Write:
1. A 2-3 sentence factual comparison summary grounded in the above.
2. Up to 5 content-gap recommendations for our site, each with: gap, evidence (from the real comparison data above), recommendedAction, priority (Critical|High|Medium|Low).

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "summary": "string",
  "gaps": [ { "gap": "string", "evidence": "string", "recommendedAction": "string", "priority": "string" } ]
}`;

  try {
    const interpretation = await callOpenRouterJson({ system, prompt, maxTokens: 1700, temperature: 0.5 });
    return Response.json({
      result: {
        observed,
        interpretation: {
          summary: interpretation.summary || "",
          gaps: (interpretation.gaps || []).map((g, idx) => ({ id: `cgap_${idx}`, ...g, source: "VertexRank AI Interpretation" })),
        },
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    // Even if the AI interpretation step fails, still return the real
    // observed crawl comparison — that part never depended on the model.
    return Response.json({
      result: { observed, interpretation: null, generatedAt: new Date().toISOString() },
      warning: err.message || "VertexRank AI couldn't generate an interpretation, but the observed comparison above is real crawl data.",
    });
  }
}
