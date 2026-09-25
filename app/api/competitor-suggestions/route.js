import { callOpenRouterJson } from "../../../lib/openrouter";
import { truncate } from "../../../lib/textIntelligence";

// Suggests plausible real-world competitors from VertexRank AI's general
// knowledge of this site's industry/location — NOT a live web search, and
// NOT verified fact. This is the missing route the Competitors tab's
// "Suggest with AI" button already called (see components/VertexRank.jsx,
// suggestCompetitors()); every suggestion is labeled with a confidence
// level and the UI requires a click to accept before it's tracked, since
// the name/URL here are the model's best guess, not a crawled result.

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const { scanMeta } = body || {};
  if (!scanMeta?.domain) {
    return Response.json({ error: "Scan data is required. Run a scan on this website first." }, { status: 400 });
  }

  const system = `You are VertexRank AI. You are given real crawled data describing a business's own website. From your general training knowledge of this industry and any location signals present, suggest plausible real-world competitors — companies that likely compete for the same customers or search intent. You are NOT performing a live web search, so you never claim certainty: every suggestion must be labeled with an honest confidence level, and you never invent a company that you are not reasonably confident actually exists. If you are not confident a real competitor exists for this niche, return fewer suggestions rather than fabricating ones.`;

  const prompt = `Website: ${scanMeta.domain}
Page title: "${scanMeta.title || "(missing)"}"
Meta description: "${scanMeta.metaDescription || "(missing)"}"
H1: "${scanMeta.h1Text || "(missing)"}"
Visible body text (truncated): "${truncate(scanMeta.fullText || scanMeta.bodySnippet, 1800)}"

Suggest up to 5 real, plausible competitors for this business. For each, give your best-guess domain (not a guarantee — the user must verify it) and a one-sentence reason grounded in what the business above appears to do.

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "suggestions": [
    { "name": "string (company name)", "url": "string (best-guess domain, no protocol, e.g. example.com)", "reason": "string", "confidence": "High|Medium|Low" }
  ]
}`;

  try {
    const parsed = await callOpenRouterJson({ system, prompt, maxTokens: 1200, temperature: 0.6 });
    if (!Array.isArray(parsed.suggestions)) throw new Error("VertexRank AI's response was missing suggestion data.");

    const suggestions = parsed.suggestions
      .filter((s) => s?.name)
      .slice(0, 5)
      .map((s, idx) => ({
        id: `csug_${idx}`,
        name: String(s.name).trim(),
        url: s.url ? String(s.url).trim().replace(/^https?:\/\//, "").replace(/\/$/, "") : "",
        reason: s.reason || "",
        confidence: ["High", "Medium", "Low"].includes(s.confidence) ? s.confidence : "Medium",
        source: "VertexRank AI Suggestion",
      }));

    return Response.json({ result: { suggestions, generatedAt: new Date().toISOString() } });
  } catch (err) {
    return Response.json({ error: err.message || "VertexRank AI couldn't suggest competitors right now. Try again." }, { status: 502 });
  }
}
