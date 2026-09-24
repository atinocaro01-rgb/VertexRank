import { callOpenRouterJson } from "../../../lib/openrouter";
import { extractKeywordCandidates, extractEntityCandidates, truncate } from "../../../lib/textIntelligence";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const { scanMeta, targetKeyword, topic, country, language } = body || {};
  if (!scanMeta?.domain) {
    return Response.json({ error: "Scan data is required. Run a scan on this website first." }, { status: 400 });
  }

  // Step 1 — deterministic extraction directly from the crawled page. This
  // is the "Crawled Data" evidence layer: every candidate here is a real
  // phrase found in the real title/headings/alt text/body VertexRank fetched.
  const candidates = extractKeywordCandidates(scanMeta, 70);
  const entities = extractEntityCandidates(scanMeta, 20);

  if (candidates.length === 0) {
    return Response.json({
      result: {
        keywords: [],
        entities,
        opportunities: [],
        note: "The crawl didn't return enough visible text to extract keyword candidates from. Try rescanning the site.",
      },
    });
  }

  const candidateList = candidates
    .slice(0, 40)
    .map((k) => `- "${k.keyword}" (${k.type}, appears ${k.usage.body}x in body${k.usage.title ? ", in title" : ""}${k.usage.h1 ? ", in H1" : ""}${k.usage.h2h3 ? ", in a heading" : ""}${k.usage.alt ? ", in alt text" : ""})`)
    .join("\n");
  const entityList = entities.slice(0, 12).map((e) => `- ${e.entity} (${e.occurrences}x)`).join("\n") || "(none detected)";

  const system = `You are VertexRank AI, a precise keyword strategist. You are given real phrases already extracted from a real crawled webpage — you classify, expand, and reason about opportunity grounded in that real content. You never invent search volume, ranking positions, or CPC. Anything you can't verify from the given content, you label as an estimate rather than a fact. You never claim data comes from Google or any external provider.`;

  const prompt = `Website: ${scanMeta.domain}
Page title: "${scanMeta.title || "(missing)"}"
Meta description: "${scanMeta.metaDescription || "(missing)"}"
H1: "${scanMeta.h1Text || "(missing)"}"
Headings: ${[...(scanMeta.h2Texts || []), ...(scanMeta.h3Texts || [])].join(" | ") || "(none)"}
Visible body text (truncated): "${truncate(scanMeta.fullText || scanMeta.bodySnippet, 2500)}"
Word count: ${scanMeta.wordCount ?? "unknown"}
Target keyword the user cares about: ${targetKeyword?.trim() || "(not specified)"}
Topic the user cares about: ${topic?.trim() || "(not specified)"}
Target country: ${country || "(not specified)"}
Target language: ${language || "English"}

Real keyword candidates already extracted from this exact page's text (use these as your primary evidence — don't invent unrelated ones):
${candidateList}

Real entities/proper nouns detected on the page:
${entityList}

Do the following, grounded ONLY in the content above:

1. KEYWORDS: For up to 20 of the most relevant candidates above (plus, if truly justified by the content, a few closely related long-tail/question/semantic variants that are clearly implied by this specific content — never generic filler), return a structured row with:
   - keyword
   - type: one of Primary, Secondary, Long-tail, Related, Semantic, Entity, Question, Commercial, Informational, Transactional, Navigational, Local
   - intent: one of Informational, Commercial, Transactional, Navigational
   - relevance: 0-100 integer, how relevant this keyword is to the page's actual apparent purpose
   - difficultyEstimate: 0-100 integer, VertexRank AI's rough estimate of how competitive this phrase likely is based on its specificity/commercial intent (NOT real ranking data)
   - difficultyConfidence: "Low", "Medium", or "High" — how confident you are in that estimate
   - recommendedUsage: one short sentence on where/how it should be used on the page if it isn't already well-placed
   - opportunity: one short sentence — is this already well covered, weakly covered, or a real gap?

2. OPPORTUNITIES: 4-8 items identifying real opportunities visible in this content — weakly covered keywords, topics implied but not covered, long-tail or question-based opportunities, local-search opportunities (if the content mentions a place), or commercial-intent gaps. Each item:
   - problem: what's missing or weak
   - evidence: a specific, real detail from the content above that supports this (quote or closely paraphrase, don't invent)
   - recommendedAction: concrete next step
   - priority: "Critical", "High", "Medium", or "Low"
   - confidence: "Low", "Medium", or "High"

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "keywords": [ { "keyword": "string", "type": "string", "intent": "string", "relevance": 0, "difficultyEstimate": 0, "difficultyConfidence": "string", "recommendedUsage": "string", "opportunity": "string" } ],
  "opportunities": [ { "problem": "string", "evidence": "string", "recommendedAction": "string", "priority": "string", "confidence": "string" } ]
}`;

  try {
    const parsed = await callOpenRouterJson({ system, prompt, maxTokens: 2200, temperature: 0.45 });
    if (!Array.isArray(parsed.keywords)) throw new Error("VertexRank AI's response was missing keyword data.");

    // Re-attach real usage-location data computed deterministically from the
    // crawl (not from the AI) so the "where it appears" columns in the UI
    // are always ground-truth, even for keywords the AI expanded on.
    const byPhrase = new Map(candidates.map((c) => [c.keyword.toLowerCase(), c]));
    const keywords = parsed.keywords.map((k, idx) => {
      const match = byPhrase.get((k.keyword || "").toLowerCase());
      return {
        id: `kwi_${idx}`,
        keyword: k.keyword,
        type: k.type || "Related",
        intent: k.intent || "Informational",
        relevance: clampInt(k.relevance, 0, 100, 50),
        difficultyEstimate: clampInt(k.difficultyEstimate, 0, 100, null),
        difficultyConfidence: k.difficultyConfidence || "Low",
        recommendedUsage: k.recommendedUsage || "",
        opportunity: k.opportunity || "",
        usage: match ? match.usage : { title: false, metaDescription: false, h1: false, h2h3: false, body: 0, alt: false, schema: false },
        occurrences: match ? match.usage.body : 0,
        source: match ? "Crawled Data + VertexRank AI Analysis" : "VertexRank AI Estimate",
      };
    });

    const opportunities = (parsed.opportunities || []).map((o, idx) => ({
      id: `kwo_${idx}`,
      problem: o.problem || "",
      evidence: o.evidence || "",
      recommendedAction: o.recommendedAction || "",
      priority: o.priority || "Medium",
      confidence: o.confidence || "Medium",
      source: "VertexRank AI Analysis",
    }));

    return Response.json({
      result: {
        keywords,
        entities,
        opportunities,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return Response.json({ error: err.message || "VertexRank AI couldn't complete keyword analysis. Try again." }, { status: 502 });
  }
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
