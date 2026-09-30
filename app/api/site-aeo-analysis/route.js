import { callOpenRouterJson } from "../../../lib/openrouter";
import { computeAeoSignals, extractExistingQuestions, scoreFromFlags, truncate } from "../../../lib/textIntelligence";
import { aggregateSiteFlags, rankPagesByScore, samplePagesForPrompt } from "../../../lib/siteSignals";
import { buildPageRecommendations, UTILITY_TYPES } from "../../../lib/aeoPageRecommendations";
import { AEO_SIGNAL_LABELS } from "../../../lib/copyExport";

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
  const pageByUrl = new Map(pages.map((p) => [p.url, p]));
  // Each weak page gets its own concrete fix list (deterministic, from the
  // signals that failed on THAT page), not just a bare score.
  const weakestPages = rankPagesByScore(pages, computeAeoSignals, AEO_WEIGHTS).slice(0, 8).map((ranked) => {
    const page = pageByUrl.get(ranked.url) || {};
    const flags = computeAeoSignals(page);
    return { ...ranked, ...buildPageRecommendations(page, flags, AEO_WEIGHTS, ranked.score), aiSuggestions: null };
  });

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

  // Instant path: the client asks for this first so the Dashboard's AEO score
  // and weak-page fixes appear the moment the crawl finishes, while the slower
  // AI request below runs at the same time.
  if (body?.signalsOnly) {
    return Response.json({
      result: { ...observed, questions: [], contentRecommendations: [], generatedAt: new Date().toISOString(), signalsOnly: true },
    });
  }

  // ---- AI layer: reasons over a compact sample, never the whole crawl ----
  // The sample now includes the weakest pages (see samplePagesForPrompt), so
  // the AI's coverage judgments see the pages that most need attention.
  const sample = samplePagesForPrompt(pages, crawl.startUrl, 15, { scoreFn: computeAeoSignals, weights: AEO_WEIGHTS });
  const pageSummaries = sample
    .map((p) => `- "${p.title || "(untitled)"}" (${p.url}) — ${p.wordCount || 0} words. Headings: ${[...(p.h2Texts || []), ...(p.h3Texts || [])].slice(0, 4).join(" | ") || "(none)"}. Schema: ${(p.schemaTypes || []).join(", ") || "none"}`)
    .join("\n");
  const keywordList = (keywords || []).slice(0, 15).map((k) => k.keyword || k).join(", ") || "(none supplied)";

  // Weak pages worth AI wording help: content pages only (contact/legal pages
  // get the deterministic fixes and no AI spend), capped to keep the reply small.
  const aiTargets = weakestPages.filter((w) => !UTILITY_TYPES.has(w.pageType) && w.pageType !== "blog-index").slice(0, 5);
  const weakPageBlock = aiTargets
    .map((w) => {
      const p = pageByUrl.get(w.url) || {};
      const missingLabels = w.fixes.map((f) => AEO_SIGNAL_LABELS[f.key] || f.label).join(", ") || "(none)";
      return `- "${w.title}" (${w.url}) — score ${w.score}/100, ${w.wordCount} words. Headings: ${[...(p.h2Texts || []), ...(p.h3Texts || [])].slice(0, 5).join(" | ") || "(none)"}. Missing: ${missingLabels}. Opening text: ${truncate(String(p.fullText || p.bodySnippet || "").replace(/\s+/g, " "), 350)}`;
    })
    .join("\n");

  const system = `You are VertexRank AI, an Answer Engine Optimization analyst reasoning about an ENTIRE website, not a single page. You are given real crawled data from multiple real pages of the same site. You generate realistic questions a buyer would ask about this business as a whole, and for each you judge — using ONLY the page summaries given — whether some page on the site already appears to answer it, and if so which one. If you can't tell from the summaries, say the coverage is unclear rather than guessing. You never claim your scores are official Google or AI-platform data.`;

  const prompt = `Website: ${crawl.domain}
Pages crawled: ${pages.length}${crawl.truncated ? " (crawl was time/page-limited, so this may not be every page on the site)" : ""}
Known target keywords: ${keywordList}
Questions the site's own text already appears to ask/answer verbatim (aggregated across pages): ${existingQuestions.slice(0, 8).join(" | ") || "(none found)"}

Sample of ${sample.length} pages from the crawl (title, URL, word count, headings, schema):
${pageSummaries}

Generate realistic questions a real potential customer would ask about this business as a whole — grounded in what the pages above actually describe, not generic industry questions.

For each of up to 12 questions, judge — using ONLY the page summaries above — whether some page on the site already appears to answer it (coverage: "Answered", "Partial", or "Missing"), and if Answered or Partial, which page's URL from the list above looks most responsible for that coverage (answeringUrl — must be one of the URLs listed above, or null if Missing/unclear). Keep missingInfo and recommendedAnswer to ONE short sentence each.

Then suggest up to 6 concrete SITE-LEVEL content additions (e.g. "add a dedicated FAQ page", "add a comparison page for X vs Y", "add a pricing page with clear tiers") — each grounded in something specific missing across the pages shown, not per-page tweaks. One short sentence for each "why".

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "questions": [
    { "question": "string", "intent": "Informational|Commercial|Transactional|Navigational", "relatedKeyword": "string", "coverage": "Answered|Partial|Missing", "coverageScore": 0, "answeringUrl": "string or null", "missingInfo": "string", "recommendedAnswer": "string", "priority": "Critical|High|Medium|Low" }
  ],
  "contentRecommendations": [
    { "recommendation": "string", "why": "string", "priority": "Critical|High|Medium|Low" }
  ]
}`;

  // Page-level wording runs as its OWN request, in parallel with the question
  // analysis. One combined request would have to generate both answers one
  // after the other; two smaller ones finish in the time of the slower one,
  // and either can fail without taking the other down.
  const pagePrompt = `Website: ${crawl.domain}

Weakest content pages that need page-level help (with what the crawl found missing on each):
${weakPageBlock}

For EACH of those pages (use its exact URL), give up to 3 "suggestedQuestions" — questions a real reader of THAT page would ask that the page should answer, each with a short "answerOutline" (max 25 words) built only from what the page text above supports; where a fact isn't in the text write "[add your real figure/detail]" rather than inventing one — plus one "rewriteTip" sentence naming the single most valuable change for that page.

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "pageRecommendations": [
    { "url": "string (exact URL from the list above)", "suggestedQuestions": [ { "question": "string", "answerOutline": "string" } ], "rewriteTip": "string" }
  ]
}`;
  const pageSystem = `You are VertexRank AI, an Answer Engine Optimization editor. You are given real crawled excerpts of specific weak pages. You suggest what each page should answer and the single best edit, grounded ONLY in the text given — you never invent facts, figures, prices or claims about the business.`;

  const [qRes, pRes] = await Promise.allSettled([
    callOpenRouterJson({ system, prompt, maxTokens: 2400, temperature: 0.5 }),
    aiTargets.length ? callOpenRouterJson({ system: pageSystem, prompt: pagePrompt, maxTokens: 1500, temperature: 0.4 }) : Promise.resolve(null),
  ]);

  // Attach the AI's page-specific wording to the matching weak page. URLs
  // are validated against the real list, so nothing can attach to a page
  // that wasn't actually ranked. If this request failed, the deterministic
  // fixes are still there — only the extra wording is missing.
  const byUrl = new Map();
  if (pRes.status === "fulfilled" && pRes.value) {
    const targetUrls = new Set(aiTargets.map((w) => w.url));
    for (const r of Array.isArray(pRes.value.pageRecommendations) ? pRes.value.pageRecommendations : []) {
      if (!targetUrls.has(r?.url)) continue;
      byUrl.set(r.url, {
        rewriteTip: typeof r.rewriteTip === "string" ? r.rewriteTip : "",
        suggestedQuestions: (Array.isArray(r.suggestedQuestions) ? r.suggestedQuestions : [])
          .filter((q) => q && typeof q.question === "string" && q.question.trim())
          .slice(0, 3)
          .map((q) => ({ question: q.question.trim(), answerOutline: typeof q.answerOutline === "string" ? q.answerOutline : "" })),
      });
    }
  }
  const weakestWithAi = weakestPages.map((w) => ({ ...w, aiSuggestions: byUrl.get(w.url) || null }));

  // The deterministic site-wide evidence above never depended on the AI
  // calls, so it's still returned even if the question analysis fails.
  if (qRes.status === "rejected" || !Array.isArray(qRes.value?.questions)) {
    const msg = qRes.status === "rejected" ? qRes.reason?.message : "VertexRank AI's response was missing question data.";
    return Response.json({
      result: { ...observed, weakestPages: weakestWithAi, questions: [], contentRecommendations: [], generatedAt: new Date().toISOString() },
      warning: msg || "VertexRank AI couldn't generate site-wide questions, but the observed signal data above is real crawl data.",
    });
  }

  const parsed = qRes.value;
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
    result: { ...observed, weakestPages: weakestWithAi, questions, contentRecommendations, generatedAt: new Date().toISOString() },
  });
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
