import { callOpenRouterJson } from "../../../lib/openrouter";
import { clusterSiteKeywords } from "../../../lib/keywordClustering";

// Feature ②. Deterministic clustering (lib/keywordClustering.js) runs
// first and is always returned, even if the AI step below fails — the
// clusters and cannibalization list are real, computed facts about the
// crawled site, not AI output. The AI layer only adds: a human-readable
// label per cluster, plain-language explanations of cannibalization risk,
// and which page should be the "primary" one per contested cluster.

export const runtime = "nodejs";
export const maxDuration = 60;

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

  const observed = {
    domain: crawl.domain,
    pagesCrawled: crawl.pages.length,
    clusterCount: clusters.length,
    cannibalizationCount: cannibalization.length,
    clusters,
    cannibalization,
  };

  if (clusters.length === 0) {
    return Response.json({
      result: { ...observed, clusterInsights: [], cannibalizationGuidance: [], opportunities: [], generatedAt: new Date().toISOString() },
    });
  }

  // Only the top clusters (by score) and all cannibalization cases go to
  // the AI — not the full list, to keep the prompt bounded regardless of
  // site size.
  const topClusters = clusters.slice(0, 20);
  const clusterBlock = topClusters
    .map((c, i) => `${i + 1}. [id=${c.id}] Keywords: ${c.keywords.slice(0, 6).join(", ")}. Used on ${c.pages.length} page(s): ${c.pages.map((p) => `"${p.title}" (${p.url})${p.strong ? " [strongly targeted]" : ""}`).join("; ")}`)
    .join("\n");
  const cannibalBlock = cannibalization.length
    ? cannibalization.map((c, i) => `${i + 1}. [id=${c.clusterId}] Keywords: ${c.keywords.join(", ")}. Pages competing for this: ${c.competingPages.map((p) => `"${p.title}" (${p.url})`).join(" vs ")}`).join("\n")
    : "(none detected)";

  const system = `You are VertexRank AI, a site-wide keyword strategist. You are given real keyword clusters computed deterministically from a real crawl of every page on a site — the clusters and which pages use them are FACTS, not your invention. Your job is to name each cluster with a clear topic label, explain cannibalization risk in plain language grounded in the real competing pages given, and recommend concrete next steps. You never invent search volume, ranking data, or traffic figures.`;

  const prompt = `Website: ${crawl.domain}
Pages crawled: ${crawl.pages.length}

Top keyword clusters (real, computed from the crawl):
${clusterBlock}

Keyword cannibalization detected (2+ different pages strongly targeting the same cluster):
${cannibalBlock}

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

Then list up to 6 general keyword-strategy opportunities visible across the clusters as a whole (e.g. a high-scoring cluster with no page strongly targeting it yet = a content gap).

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "clusterInsights": [ { "id": "string", "label": "string", "insight": "string" } ],
  "cannibalizationGuidance": [ { "clusterId": "string", "explanation": "string", "recommendedAction": "string", "primaryPageUrl": "string", "reasoning": "string" } ],
  "opportunities": [ { "opportunity": "string", "evidence": "string", "priority": "Critical|High|Medium|Low" } ]
}`;

  try {
    const parsed = await callOpenRouterJson({ system, prompt, maxTokens: 2400, temperature: 0.5 });

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

    const opportunities = (parsed.opportunities || []).map((o, idx) => ({
      id: `kwop_${idx}`,
      opportunity: o.opportunity || "",
      evidence: o.evidence || "",
      priority: o.priority || "Medium",
      source: "VertexRank AI Analysis",
    }));

    return Response.json({
      result: {
        ...observed,
        clusters: clustersWithLabels,
        cannibalizationGuidance,
        opportunities,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return Response.json({
      result: { ...observed, cannibalizationGuidance: [], opportunities: [], generatedAt: new Date().toISOString() },
      warning: err.message || "VertexRank AI couldn't generate cluster narratives, but the clusters and cannibalization list above are real, computed from the crawl.",
    });
  }
}
