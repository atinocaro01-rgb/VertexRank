import { callOpenRouterJson } from "../../../lib/openrouter";
import { clusterSiteKeywords, aggregateSiteKeywords, aggregateSiteEntities } from "../../../lib/keywordClustering";

// Site-wide Keyword Intelligence. Everything factual is computed
// deterministically, always returned even if the AI step below fails:
// - clusterSiteKeywords: topic clusters + cannibalization (which pages
//   compete for the same cluster)
// - aggregateSiteKeywords: one ranked keyword table across every crawled
//   page (type/intent/usage counts/relative relevance)
// - aggregateSiteEntities: proper-noun phrases found across the site
// The AI layer only adds judgment on top of those facts: a human-readable
// label per cluster, cannibalization guidance, a difficulty estimate and
// recommendation per keyword, and a handful of strategic opportunities.
// The overall Keyword Opportunity score is then computed deterministically
// from the AI's own opportunity list (see scoreFromOpportunities below), not
// asked of the model directly, so it can't drift from the opportunities shown.

export const runtime = "nodejs";
export const maxDuration = 60;

const OPPORTUNITY_PENALTY = { Critical: 20, High: 12, Medium: 6, Low: 2 };

function scoreFromOpportunities(opportunities) {
  if (!opportunities) return null;
  const penalty = opportunities.reduce((sum, o) => sum + (OPPORTUNITY_PENALTY[o.priority] ?? 6), 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const { crawl } = body || {};
  if (!crawl?.pages?.length) {
    return Response.json({ error: "Site crawl data is required. Run a full-site crawl first." }, { status: 400 });
  }

  const { clusters, cannibalization } = clusterSiteKeywords(crawl.pages);
  // Kept deliberately smaller than this function's own defaults (24): this
  // is already the single largest AI request in the app (cluster insights +
  // cannibalization guidance + per-keyword insights + opportunities all in
  // one JSON reply), and a big keyword table was the direct cause of
  // responses being cut off before the model finished writing valid JSON
  // (see the maxTokens/timeout comment below). Trimming the ask keeps the
  // reply achievable within that budget on every provider in the chain,
  // not just the fastest one.
  const keywordCandidates = aggregateSiteKeywords(crawl.pages, 18);
  const entities = aggregateSiteEntities(crawl.pages, 20);

  const observed = {
    domain: crawl.domain,
    pagesCrawled: crawl.pages.length,
    clusterCount: clusters.length,
    cannibalizationCount: cannibalization.length,
    clusters,
    cannibalization,
    entities,
  };

  if (clusters.length === 0 && keywordCandidates.length === 0) {
    return Response.json({
      result: { ...observed, keywords: [], cannibalizationGuidance: [], opportunities: [], keywordScore: null, generatedAt: new Date().toISOString() },
    });
  }

  const topClusters = clusters.slice(0, 14);
  const clusterBlock = topClusters.length
    ? topClusters
        .map((c, i) => `${i + 1}. [id=${c.id}] Keywords: ${c.keywords.slice(0, 6).join(", ")}. Used on ${c.pages.length} page(s): ${c.pages.map((p) => `"${p.title}" (${p.url})${p.strong ? " [strongly targeted]" : ""}`).join("; ")}`)
        .join("\n")
    : "(no multi-keyword clusters found)";
  const cannibalBlock = cannibalization.length
    ? cannibalization.map((c, i) => `${i + 1}. [id=${c.clusterId}] Keywords: ${c.keywords.join(", ")}. Pages competing for this: ${c.competingPages.map((p) => `"${p.title}" (${p.url})`).join(" vs ")}`).join("\n")
    : "(none detected)";
  const keywordBlock = keywordCandidates.length
    ? keywordCandidates
        .map((k, i) => {
          const where = [k.usage.title ? "title" : null, k.usage.h1 ? "H1" : null, k.usage.h2h3 ? "H2/H3" : null, k.usage.metaDescription ? "meta description" : null, k.usage.alt ? "ALT text" : null, k.usage.schema ? "schema" : null, k.usage.body ? `body (${k.usage.body}x across the site)` : null].filter(Boolean).join(", ") || "not clearly used anywhere";
          return `${i + 1}. [id=kw_${i}] "${k.keyword}" — type: ${k.type}, intent: ${k.intent}, relevance: ${k.relevance}/100, used on ${k.pagesUsedOn} of ${crawl.pages.length} page(s), appears in: ${where}`;
        })
        .join("\n")
    : "(no strong keyword candidates found in the crawled text)";

  const system = `You are VertexRank AI, a site-wide keyword strategist. You are given real keyword clusters, a real ranked keyword table, and real entity mentions computed deterministically from a full crawl of every page on a site — all of that is FACT, not your invention. Your job is to add judgment on top: name each cluster, explain cannibalization risk, estimate ranking difficulty for the given keywords (there is no real search-volume/difficulty data source connected — say so implicitly by giving a confidence level, never invent a precise number you present as certain), and recommend concrete next steps grounded only in the real usage data given. You never invent search volume, ranking positions, or traffic figures.`;

  const prompt = `Website: ${crawl.domain}
Pages crawled: ${crawl.pages.length}

Top keyword clusters (real, computed from the crawl):
${clusterBlock}

Keyword cannibalization detected (2+ different pages strongly targeting the same cluster):
${cannibalBlock}

Ranked keyword table (real usage counts, aggregated across every crawled page):
${keywordBlock}

For each numbered cluster above, provide:
- id (must match the [id=...] shown)
- label: a clear, human-readable topic name (2-5 words)
- insight: one sentence on what this cluster represents and how well it's currently covered

For each numbered cannibalization case above, provide:
- clusterId (must match the [id=...] shown)
- explanation: plain-language explanation of the risk, grounded in the real competing pages listed
- recommendedAction: one of "Consolidate" (merge into one page), "Differentiate" (keep both but make each target a clearly different angle/intent), or "Redirect" (one page should redirect to the other)
- primaryPageUrl: which of the competing page URLs should be the primary/surviving page (must be one of the URLs listed for that case)
- reasoning: one sentence grounded in the real data (e.g. word count, which page is more complete) for why that page should be primary

For each numbered keyword in the ranked keyword table above, provide:
- id (must match the [id=kw_...] shown)
- difficultyEstimate: your best-guess ranking difficulty 0-100 (0=trivial, 100=extremely competitive) — this is an estimate, not real SERP data
- difficultyConfidence: "Low", "Medium", or "High" — how confident you are in that estimate given only on-page data
- recommendedUsage: one sentence on how this keyword should be used across the site, grounded in where it currently appears (or doesn't)
- opportunity: one sentence naming the specific optimization opportunity for this keyword (a gap, an underused placement, a missing page, etc.)

Then list up to 8 site-wide keyword strategy opportunities, each a real problem visible in the data above (e.g. a high-relevance keyword barely used anywhere, a whole cluster with no page strongly targeting it, a valuable term buried only in body text). For each, provide:
- problem: the specific problem (1 sentence)
- evidence: what in the crawl/keyword data shows this (1 sentence)
- recommendedAction: a concrete next step (1 sentence)
- priority: "Critical", "High", "Medium", or "Low"
- confidence: "Low", "Medium", or "High"

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "clusterInsights": [ { "id": "string", "label": "string", "insight": "string" } ],
  "cannibalizationGuidance": [ { "clusterId": "string", "explanation": "string", "recommendedAction": "string", "primaryPageUrl": "string", "reasoning": "string" } ],
  "keywordInsights": [ { "id": "string", "difficultyEstimate": 0, "difficultyConfidence": "Low|Medium|High", "recommendedUsage": "string", "opportunity": "string" } ],
  "opportunities": [ { "problem": "string", "evidence": "string", "recommendedAction": "string", "priority": "Critical|High|Medium|Low", "confidence": "Low|Medium|High" } ]
}`;

  try {
    // This route asks for by far the largest JSON reply in the app (cluster
    // insights + cannibalization guidance + up to 18 keyword insights + up
    // to 8 opportunities, each multi-sentence) — every other route here
    // tops out at maxTokens 2600. At the old maxTokens: 3600 with the
    // shared default timeouts (12s/model, 42s total), a model that spends
    // part of its budget "thinking" before answering would either get cut
    // off mid-reasoning (surfaced as a JSON-parse failure showing raw
    // reasoning text) or hit the per-model timeout ("took too long"),
    // depending on which one ran out first. Both symptoms were the same
    // root cause: not enough token/time headroom for how much output this
    // specific request requires. maxDuration on this route is 60s, so
    // overallBudgetMs leaves ~10s of slack below that ceiling for request
    // overhead and the deterministic post-processing below.
    const parsed = await callOpenRouterJson({
      system,
      prompt,
      maxTokens: 6500,
      temperature: 0.5,
      perModelTimeoutMs: 20000,
      overallBudgetMs: 50000,
    });

    const insightById = new Map((parsed.clusterInsights || []).map((c) => [c.id, c]));
    const clustersWithLabels = clusters.map((c) => {
      const ai = insightById.get(c.id);
      return { ...c, label: ai?.label || c.label, insight: ai?.insight || "", source: ai ? "Crawled Data + VertexRank AI Analysis" : "Crawled Data" };
    });

    const validCannibalIds = new Set(cannibalization.map((c) => c.clusterId));
    const cannibalizationGuidance = (parsed.cannibalizationGuidance || [])
      .filter((g) => validCannibalIds.has(g.clusterId))
      .map((g, idx) => {
        const original = cannibalization.find((c) => c.clusterId === g.clusterId);
        const validUrls = new Set((original?.competingPages || []).map((p) => p.url));
        return {
          id: `cnb_${idx}`,
          clusterId: g.clusterId,
          explanation: g.explanation || "",
          recommendedAction: ["Consolidate", "Differentiate", "Redirect"].includes(g.recommendedAction) ? g.recommendedAction : "Differentiate",
          primaryPageUrl: validUrls.has(g.primaryPageUrl) ? g.primaryPageUrl : null,
          reasoning: g.reasoning || "",
          source: "VertexRank AI Analysis",
        };
      });

    const insightByKwId = new Map((parsed.keywordInsights || []).map((k) => [k.id, k]));
    const keywords = keywordCandidates.map((k, i) => {
      const ai = insightByKwId.get(`kw_${i}`);
      return {
        ...k,
        difficultyEstimate: typeof ai?.difficultyEstimate === "number" ? Math.max(0, Math.min(100, Math.round(ai.difficultyEstimate))) : null,
        difficultyConfidence: ai?.difficultyConfidence || null,
        recommendedUsage: ai?.recommendedUsage || "",
        opportunity: ai?.opportunity || "",
        source: ai ? "Crawled Data + VertexRank AI Analysis" : "Crawled Data",
      };
    });

    const opportunities = (parsed.opportunities || []).map((o, idx) => ({
      id: `kwop_${idx}`,
      problem: o.problem || "",
      evidence: o.evidence || "",
      recommendedAction: o.recommendedAction || "",
      priority: ["Critical", "High", "Medium", "Low"].includes(o.priority) ? o.priority : "Medium",
      confidence: ["Low", "Medium", "High"].includes(o.confidence) ? o.confidence : "Medium",
      source: "VertexRank AI Analysis",
    }));

    return Response.json({
      result: {
        ...observed,
        clusters: clustersWithLabels,
        cannibalizationGuidance,
        keywords,
        opportunities,
        keywordScore: scoreFromOpportunities(opportunities),
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return Response.json({
      result: { ...observed, keywords: keywordCandidates, cannibalizationGuidance: [], opportunities: [], keywordScore: null, generatedAt: new Date().toISOString() },
      warning: err.message || "VertexRank AI couldn't generate keyword narratives, but the clusters, keyword table, and entities above are real, computed from the crawl.",
    });
  }
}
