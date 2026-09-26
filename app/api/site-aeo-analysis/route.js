import { callOpenRouterJson } from "../../../lib/openrouter";
import { computeAeoSignals, extractExistingQuestions, scoreFromFlags, truncate } from "../../../lib/textIntelligence";
import { aggregateSiteFlags, rankPagesByScore, samplePagesForPrompt } from "../../../lib/siteSignals";

// Site-wide AEO analysis: judges whether the SITE AS A WHOLE answers buyer
// questions — the same buyer question might be answered by a different page
// than whichever one a naive check would look at. See lib/siteSignals.js for
// why "does the site have X" is defined as "does ANY page have X", not an
// average.

export const runtime = "nodejs";
export const maxDuration = 60;

const AEO_WEIGHTS = {
  hasFaqSchema: 18, hasHowToSchema: 6, hasQaSchema: 6, hasAnySchema: 8,
  hasListMarkup: 10, hasTableMarkup: 6, hasMultipleHeadings: 12, hasQuestionHeading: 12,
  hasDirectAnswerParagraph: 10, hasExistingQuestionsInBody: 6, contentDepthOk: 6,
};

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const { crawl, keywords } = body || {};
  if (!crawl?.pages?.length) {
    return Response.json({ error: "Site crawl data is required. Run a full-site crawl first." }, { status: 400 });
  }
  const pages = crawl.pages;

  // ---- deterministic, site-wide evidence layer (no AI) ----
  const { siteFlags, evidence } = aggregateSiteFlags(pages, computeAeoSignals);
  const { score: readinessScore, breakdown } = scoreFromFlags(siteFlags, AEO_WEIGHTS);
  const weakestPages = rankPagesByScore(pages, computeAeoSignals, AEO_WEIGHTS).slice(0, 8);

  const existingQuestions = [...new Set(pages.flatMap((p) => extractExistingQuestions(p)))].slice(0, 20);

  const observed = {
    domain: crawl.domain,
    pagesCrawled: pages.length,
    readinessScore,
    signalBreakdown: breakdown,
    flags: siteFlags,
    evidence,
    weakestPages,
    existingQuestions,
  };

  // ---- AI layer: reasons over a compact sample, never the whole crawl ----
  const sample = samplePagesForPrompt(pages, crawl.startUrl, 15);
  const pageSummaries = sample
    .map((p) => `- "${p.title || "(untitled)"}" (${p.url}) — ${p.wordCount || 0} words. Headings: ${[...(p.h2Texts || []), ...(p.h3Texts || [])].slice(0, 4).join(" | ") || "(none)"}. Schema: ${(p.schemaTypes || []).join(", ") || "none"}`)
    .join("\n");
  const keywordList = (keywords || []).slice(0, 15).map((k) => k.keyword || k).join(", ") || "(none supplied)";

  const system = `You are VertexRank AI, an Answer Engine Optimization analyst reasoning about an ENTIRE website, not a single page. You are given real crawled data from multiple real pages of the same site. You generate realistic questions a buyer would ask about this business as a whole, and for each you judge — using ONLY the page summaries given — whether some page on the site already appears to answer it, and if so which one. If you can't tell from the summaries, say the coverage is unclear rather than guessing. You never claim your scores are official Google or AI-platform data.`;

  const prompt = `Website: ${crawl.domain}
Pages crawled: ${pages.length}${crawl.truncated ? " (crawl was time/page-limited, so this may not be every page on the site)" : ""}
Known target keywords: ${keywordList}
Questions the site's own text already appears to ask/answer verbatim (aggregated across pages): ${existingQuestions.slice(0, 8).join(" | ") || "(none found)"}

Sample of ${sample.length} pages from the crawl (title, URL, word count, headings, schema):
${pageSummaries}

Generate realistic questions a real potential customer would ask about this business as a whole — grounded in what the pages above actually describe, not generic industry questions.

For each of up to 12 questions, judge — using ONLY the page summaries above — whether some page on the site already appears to answer it (coverage: "Answered", "Partial", or "Missing"), and if Answered or Partial, which page's URL from the list above looks most responsible for that coverage (answeringUrl — must be one of the URLs listed above, or null if Missing/unclear).

Then suggest up to 6 concrete SITE-LEVEL content additions (e.g. "add a dedicated FAQ page", "add a comparison page for X vs Y", "add a pricing page with clear tiers") — each grounded in something specific missing across the pages shown, not per-page tweaks.

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "questions": [
    { "question": "string", "intent": "Informational|Commercial|Transactional|Navigational", "relatedKeyword": "string", "coverage": "Answered|Partial|Missing", "coverageScore": 0, "answeringUrl": "string or null", "missingInfo": "string", "recommendedAnswer": "string", "priority": "Critical|High|Medium|Low" }
  ],
  "contentRecommendations": [
    { "recommendation": "string", "why": "string", "priority": "Critical|High|Medium|Low" }
  ]
}`;

  try {
    const parsed = await callOpenRouterJson({ system, prompt, maxTokens: 2600, temperature: 0.5 });
    if (!Array.isArray(parsed.questions)) throw new Error("VertexRank AI's response was missing question data.");

    const validUrls = new Set(sample.map((p) => p.url));
    const questions = parsed.questions.map((q, idx) => ({
      id: `saeoq_${idx}`,
      question: q.question || "",
      intent: q.intent || "Informational",
      relatedKeyword: q.relatedKeyword || "",
      coverage: q.coverage || "Missing",
      coverageScore: clampInt(q.coverageScore, 0, 100, q.coverage === "Answered" ? 80 : q.coverage === "Partial" ? 45 : 10),
      answeringUrl: validUrls.has(q.answeringUrl) ? q.answeringUrl : null,
      missingInfo: q.missingInfo || "",
      recommendedAnswer: q.recommendedAnswer || "",
      priority: q.priority || "Medium",
      source: "VertexRank AI Analysis",
    }));

    const contentRecommendations = (parsed.contentRecommendations || []).map((r, idx) => ({
      id: `saeor_${idx}`,
      recommendation: r.recommendation || "",
      why: r.why || "",
      priority: r.priority || "Medium",
      source: "VertexRank AI Analysis",
    }));

    return Response.json({
      result: { ...observed, questions, contentRecommendations, generatedAt: new Date().toISOString() },
    });
  } catch (err) {
    // The deterministic site-wide evidence above never depended on the AI
    // call, so it's still returned even if the AI step fails.
    return Response.json({
      result: { ...observed, questions: [], contentRecommendations: [], generatedAt: new Date().toISOString() },
      warning: err.message || "VertexRank AI couldn't generate site-wide questions, but the observed signal data above is real crawl data.",
    });
  }
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
