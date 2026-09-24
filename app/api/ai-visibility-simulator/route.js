import { callOpenRouterJson } from "../../../lib/openrouter";
import { truncate } from "../../../lib/textIntelligence";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const { scanMeta, keywords, country } = body || {};
  if (!scanMeta?.domain) {
    return Response.json({ error: "Scan data is required. Run a scan on this website first." }, { status: 400 });
  }

  const keywordList = (keywords || []).slice(0, 12).map((k) => k.keyword).join(", ") || "(none supplied)";

  const system = `You are VertexRank AI's simulation engine. You generate realistic natural-language questions a person might type into an AI search assistant (like a chat-based answer engine), and then — using ONLY the real crawled content you're given for this one site — judge how well-positioned this specific page is to be part of a good answer. You are simulating, not actually calling any external AI search engine, and you must never claim the result reflects real ChatGPT, Gemini, Perplexity, or Google AI Overview behavior. If the content doesn't support a strong answer, say so honestly.`;

  const prompt = `Website: ${scanMeta.domain}
Page title: "${scanMeta.title || "(missing)"}"
Meta description: "${scanMeta.metaDescription || "(missing)"}"
H1: "${scanMeta.h1Text || "(missing)"}"
Headings: ${[...(scanMeta.h2Texts || []), ...(scanMeta.h3Texts || [])].join(" | ") || "(none)"}
Visible body text (truncated): "${truncate(scanMeta.fullText || scanMeta.bodySnippet, 2500)}"
Schema types present: ${(scanMeta.schemaTypes || []).join(", ") || "(none)"}
Known target keywords: ${keywordList}
Target country/market: ${country || "(not specified)"}

Generate 6 realistic questions a person might ask an AI search assistant that this business could plausibly be a relevant answer for — grounded in what this content actually describes (its real products/services/location/audience), not generic industry questions. Vary specificity: include at least one broad "who are the best..." style comparison question and at least one narrow, specific question.

For each, judge based only on the real content above:
- coverageScore (0-100): how well this exact page's real content could support a good answer
- answerReadiness: "Strong", "Partial", or "Weak"
- missingInfo: what real information this page would need to add to answer this well
- recommendedImprovement: one concrete, specific action

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "queries": [
    { "query": "string", "relevantEntity": "string", "coverageScore": 0, "answerReadiness": "Strong|Partial|Weak", "missingInfo": "string", "recommendedImprovement": "string" }
  ]
}`;

  try {
    const parsed = await callOpenRouterJson({ system, prompt, maxTokens: 1600, temperature: 0.6 });
    if (!Array.isArray(parsed.queries)) throw new Error("VertexRank AI's response was missing simulation data.");

    const queries = parsed.queries.map((q, idx) => ({
      id: `sim_${idx}`,
      query: q.query || "",
      relevantEntity: q.relevantEntity || "",
      coverageScore: clampInt(q.coverageScore, 0, 100, 30),
      answerReadiness: q.answerReadiness || "Weak",
      missingInfo: q.missingInfo || "",
      recommendedImprovement: q.recommendedImprovement || "",
    }));

    return Response.json({
      result: {
        queries,
        page: scanMeta.domain,
        label: "VertexRank AI Visibility Simulation — not actual AI search results.",
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return Response.json({ error: err.message || "VertexRank AI couldn't run the visibility simulation. Try again." }, { status: 502 });
  }
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
