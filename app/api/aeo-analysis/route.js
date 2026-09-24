import { callOpenRouterJson } from "../../../lib/openrouter";
import { computeAeoSignals, extractExistingQuestions, scoreFromFlags, truncate } from "../../../lib/textIntelligence";

export const runtime = "nodejs";
export const maxDuration = 60;

const AEO_WEIGHTS = {
  hasFaqSchema: 18,
  hasHowToSchema: 6,
  hasQaSchema: 6,
  hasAnySchema: 8,
  hasListMarkup: 10,
  hasTableMarkup: 6,
  hasMultipleHeadings: 12,
  hasQuestionHeading: 12,
  hasDirectAnswerParagraph: 10,
  hasExistingQuestionsInBody: 6,
  contentDepthOk: 6,
};

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const { scanMeta, keywords } = body || {};
  if (!scanMeta?.domain) {
    return Response.json({ error: "Scan data is required. Run a scan on this website first." }, { status: 400 });
  }

  // Deterministic, explainable signal checklist computed straight from the crawl.
  const flags = computeAeoSignals(scanMeta);
  const { score: readinessScore, breakdown } = scoreFromFlags(flags, AEO_WEIGHTS);
  const existingQuestions = extractExistingQuestions(scanMeta);

  const keywordList = (keywords || []).slice(0, 15).map((k) => k.keyword).join(", ") || "(none supplied)";

  const system = `You are VertexRank AI, an Answer Engine Optimization analyst. You are given real crawled page content and a real checklist of what the page already has. You generate realistic questions a buyer would ask about THIS business, grounded only in the content given, and you judge answer coverage honestly — if the page doesn't answer something, say so plainly rather than guessing at content that isn't there. You never claim your coverage scores are official Google or AI-platform data.`;

  const prompt = `Website: ${scanMeta.domain}
Page title: "${scanMeta.title || "(missing)"}"
Meta description: "${scanMeta.metaDescription || "(missing)"}"
H1: "${scanMeta.h1Text || "(missing)"}"
Headings: ${[...(scanMeta.h2Texts || []), ...(scanMeta.h3Texts || [])].join(" | ") || "(none)"}
Visible body text (truncated): "${truncate(scanMeta.fullText || scanMeta.bodySnippet, 2800)}"
Schema types already on the page: ${(scanMeta.schemaTypes || []).join(", ") || "(none)"}
Known target keywords: ${keywordList}
Questions the page's own text already appears to ask/answer verbatim: ${existingQuestions.slice(0, 6).join(" | ") || "(none found)"}

Generate realistic questions a real potential customer might ask about this specific business/product/service — grounded in what the content above actually describes, not generic industry questions. Group naturally across patterns like "What is...", "How does...", "How much does...", "Where can I...", "Which is best...", "Why should I...", "What's the difference between...", "Is ... available in [place]...", "Who provides...", "How do I...". Only use patterns that genuinely fit this content.

For each of up to 12 questions, judge — based ONLY on the text given above — whether this exact page already answers it, partially answers it, or doesn't answer it at all. Do not assume an answer exists unless the text above actually contains it.

Then, for the page as a whole, suggest up to 6 concrete content additions the page needs to become more answer-engine-ready (e.g. add FAQ section, add a concise definition paragraph, add a comparison table, add a numbered process, add supporting evidence, improve heading structure, add relevant schema) — each grounded in something specific this page is missing.

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "questions": [
    { "question": "string", "intent": "Informational|Commercial|Transactional|Navigational", "relatedKeyword": "string", "coverage": "Answered|Partial|Missing", "coverageScore": 0, "missingInfo": "string", "recommendedAnswer": "string (a real, ready-to-use short answer grounded in the business described above)", "priority": "Critical|High|Medium|Low" }
  ],
  "contentRecommendations": [
    { "recommendation": "string", "why": "string", "priority": "Critical|High|Medium|Low" }
  ]
}`;

  try {
    const parsed = await callOpenRouterJson({ system, prompt, maxTokens: 2400, temperature: 0.5 });
    if (!Array.isArray(parsed.questions)) throw new Error("VertexRank AI's response was missing question data.");

    const questions = parsed.questions.map((q, idx) => ({
      id: `aeoq_${idx}`,
      question: q.question || "",
      intent: q.intent || "Informational",
      relatedKeyword: q.relatedKeyword || "",
      coverage: q.coverage || "Missing",
      coverageScore: clampInt(q.coverageScore, 0, 100, q.coverage === "Answered" ? 80 : q.coverage === "Partial" ? 45 : 10),
      missingInfo: q.missingInfo || "",
      recommendedAnswer: q.recommendedAnswer || "",
      priority: q.priority || "Medium",
      source: "VertexRank AI Analysis",
    }));

    const contentRecommendations = (parsed.contentRecommendations || []).map((r, idx) => ({
      id: `aeor_${idx}`,
      recommendation: r.recommendation || "",
      why: r.why || "",
      priority: r.priority || "Medium",
      source: "VertexRank AI Analysis",
    }));

    return Response.json({
      result: {
        readinessScore,
        signalBreakdown: breakdown,
        flags,
        existingQuestions,
        questions,
        contentRecommendations,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return Response.json({ error: err.message || "VertexRank AI couldn't complete AEO analysis. Try again." }, { status: 502 });
  }
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
