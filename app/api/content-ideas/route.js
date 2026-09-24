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

  const { scanMeta, keywordOpportunities, aeoQuestions, geoOpportunities, count } = body || {};
  if (!scanMeta?.domain) {
    return Response.json({ error: "Scan data is required. Run a scan on this website first." }, { status: 400 });
  }

  const howMany = Math.max(1, Math.min(8, Number(count) || 4));
  const kwGaps = (keywordOpportunities || []).slice(0, 6).map((o) => o.problem).join(" | ") || "(none supplied)";
  const missingQuestions = (aeoQuestions || []).filter((q) => q.coverage !== "Answered").slice(0, 8).map((q) => q.question).join(" | ") || "(none supplied)";
  const geoGaps = (geoOpportunities || []).slice(0, 6).map((o) => o.title).join(" | ") || "(none supplied)";

  const system = `You are VertexRank AI, a content strategist. You propose real, specific content ideas grounded in the actual crawled website and the actual gaps already found by other VertexRank modules — never generic "10 tips" filler unrelated to this business.`;

  const prompt = `Website: ${scanMeta.domain}
Page title: "${scanMeta.title || "(missing)"}"
Meta description: "${scanMeta.metaDescription || "(missing)"}"
H1: "${scanMeta.h1Text || "(missing)"}"
Visible body text (truncated): "${truncate(scanMeta.fullText || scanMeta.bodySnippet, 2000)}"

Known keyword/content gaps: ${kwGaps}
Questions this site doesn't yet answer well: ${missingQuestions}
GEO/AI-visibility gaps: ${geoGaps}

Propose ${howMany} specific, publishable content ideas that would close some of these real gaps. Each must be a genuinely useful, specific title (not generic) — grounded in the business described above.

For each idea return:
- title
- primaryKeyword
- secondaryKeywords: 3-5 short phrases
- intent: Informational, Commercial, Transactional, or Navigational
- questions: 3-5 real questions this piece should answer
- outline: 4-6 section headings in logical order
- aeoRecs: 1-2 sentences on making this page directly answerable by AI assistants
- geoRecs: 1-2 sentences on making this page well-cited by AI systems
- rationale: 1 sentence on which specific gap above this idea addresses

Respond with ONLY a JSON object, no markdown fences, no commentary:
{ "ideas": [ { "title": "string", "primaryKeyword": "string", "secondaryKeywords": ["string"], "intent": "string", "questions": ["string"], "outline": ["string"], "aeoRecs": "string", "geoRecs": "string", "rationale": "string" } ] }`;

  try {
    const parsed = await callOpenRouterJson({ system, prompt, maxTokens: 2200, temperature: 0.75 });
    if (!Array.isArray(parsed.ideas)) throw new Error("VertexRank AI's response was missing content ideas.");
    const ideas = parsed.ideas.map((idea, idx) => ({
      id: `idea_${idx}`,
      title: idea.title || "",
      primaryKeyword: idea.primaryKeyword || "",
      secondaryKeywords: idea.secondaryKeywords || [],
      intent: idea.intent || "Informational",
      questions: idea.questions || [],
      outline: idea.outline || [],
      aeoRecs: idea.aeoRecs || "",
      geoRecs: idea.geoRecs || "",
      rationale: idea.rationale || "",
      source: "VertexRank AI Analysis",
    }));
    return Response.json({ result: { ideas, generatedAt: new Date().toISOString() } });
  } catch (err) {
    return Response.json({ error: err.message || "VertexRank AI couldn't generate content ideas. Try again." }, { status: 502 });
  }
}
