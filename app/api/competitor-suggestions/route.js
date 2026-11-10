import { normalizeCountry, marketPromptBlock } from "../../../lib/market";
import { guardJson } from "../../../lib/apiGuard";
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
  const guard = await guardJson(req, "aiLight");
  if (!guard.ok) return guard.response;
  const body = guard.body;
  // Validated against the fixed country list, so it can never carry free text into a prompt.
  const country = normalizeCountry(body?.country);

  const { scanMeta } = body || {};
  if (!scanMeta?.domain) {
    return Response.json({ error: "Scan data is required. Run a scan on this website first." }, { status: 400 });
  }

  // Competitors the owner deleted, dismissed or already tracks: never suggest them again (names or domains, plain text only).
  const avoid = (Array.isArray(body?.avoid) ? body.avoid : []).map((v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 80)).filter(Boolean).slice(0, 40);
  const avoidKeys = new Set(avoid.map((v) => v.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")));

  const system = `You are VertexRank AI. You are given real crawled data describing a business's own website. From your general training knowledge of this industry and any location signals present, suggest plausible real-world competitors — companies that likely compete for the same customers or search intent. You are NOT performing a live web search, so you never claim certainty: every suggestion must be labeled with an honest confidence level, and you never invent a company that you are not reasonably confident actually exists. If you are not confident a real competitor exists for this niche, return fewer suggestions rather than fabricating ones.` + marketPromptBlock(country);

  const prompt = `Website: ${scanMeta.domain}
Page title: "${scanMeta.title || "(missing)"}"
Meta description: "${scanMeta.metaDescription || "(missing)"}"
H1: "${scanMeta.h1Text || "(missing)"}"
Visible body text (truncated): "${truncate(scanMeta.fullText || scanMeta.bodySnippet, 1800)}"

${avoid.length ? `The owner does not want these (already tracked, deleted or dismissed). Do not suggest them or their domains again; suggest different companies:\n${avoid.map((v) => `- ${v}`).join("\n")}\n\n` : ""}Suggest up to 5 real, plausible competitors for this business. For each, give your best-guess domain (not a guarantee — the user must verify it) and a one-sentence reason grounded in what the business above appears to do.

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
      .filter((s) => {
        const name = String(s.name).trim().toLowerCase();
        const dom = String(s.url || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
        return !avoidKeys.has(name) && !(dom && avoidKeys.has(dom));
      })
      .slice(0, 5)
      .map((s, idx) => ({
        id: `csug_${Date.now().toString(36)}_${idx}`,
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
