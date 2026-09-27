import { callOpenRouterJson } from "../../../lib/openrouter";
import { clusterSiteKeywords, aggregateSiteKeywords, aggregateSiteEntities, auditKeywordUsage, scoreKeywordUsage } from "../../../lib/keywordClustering";

// Site-wide Keyword Intelligence. Everything factual is computed
// deterministically, always returned even if the AI step below fails:
// - aggregateSiteKeywords + auditKeywordUsage: one ranked keyword table
//   across every crawled page, with a real Strong/Weak/Poor usage verdict
//   and concrete flags per keyword (e.g. "not in any title") — zero AI
//   involved in the verdict itself.
// - scoreKeywordUsage: the site's Keyword Usage Score, a relevance-weighted
//   average of real placement data. Computed BEFORE the AI call and never
//   overwritten by it, so the score on the Dashboard is stable and always
//   present, even on a total AI outage.
// - clusterSiteKeywords: still used internally to detect cannibalization
//   (2+ different pages strongly targeting the same topic) — clusters
//   themselves are no longer a user-facing concept here.
// - aggregateSiteEntities: proper-noun phrases found across the site, used
//   as grounding context for the AI's new-keyword suggestions.
// The AI layer's job: (1) a one-sentence fix for each keyword the audit
// above already flagged, (2) a short list of new keywords this site isn't
// targeting yet but plausibly should — classified into the SAME Type
// taxonomy as real keywords (Primary/Secondary/Long-tail/Local/Commercial/
// Transactional/Navigational, from lib/textIntelligence.js) so the two sets
// display in one unified table, (3) a difficulty estimate (0-100) + a
// confidence level for every tracked keyword, real or suggested, and (4)
// plain-language cannibalization guidance. It never re-derives the score
// and never invents the usage verdict — those stay deterministic.

export const runtime = "nodejs";
export const maxDuration = 60;

const STATUS_RANK = { Poor: 0, Weak: 1, Strong: 2 };
const KEYWORD_TYPES = ["Primary", "Secondary", "Long-tail", "Local", "Commercial", "Transactional", "Navigational"];

function describeUsage(k) {
  return [
    k.usage.title ? "title" : null,
    k.usage.h1 ? "H1" : null,
    k.usage.h2h3 ? "H2/H3" : null,
    k.usage.metaDescription ? "meta description" : null,
    k.usage.alt ? "ALT text" : null,
    k.usage.schema ? "schema" : null,
    k.usage.body ? `body (${k.usage.body}x across the site)` : null,
  ].filter(Boolean).join(", ") || "not clearly used anywhere";
}

/** Grounded priority for a flagged keyword — deterministic, not asked of
 * the AI, so it can't drift between runs: how urgent this is depends on
 * real relevance + how badly it's placed, both already known facts. */
function priorityForKeyword(k) {
  if (k.status === "Poor" && k.relevance >= 70) return "Critical";
  if (k.status === "Poor" || (k.status === "Weak" && k.relevance >= 70)) return "High";
  if (k.status === "Weak") return "Medium";
  return "Low";
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

  const { cannibalization } = clusterSiteKeywords(crawl.pages);
  // Kept smaller than this function's own default (24): this is still the
  // largest AI request in the app, and a big table was the direct cause of
  // replies being cut off before the model finished writing valid JSON.
  const keywordCandidates = aggregateSiteKeywords(crawl.pages, 18);
  const entities = aggregateSiteEntities(crawl.pages, 20);
  const audited = auditKeywordUsage(keywordCandidates, crawl.pages.length).map((k, i) => ({ ...k, id: `kw_${i}` }));
  const keywordScore = scoreKeywordUsage(audited, cannibalization.length);

  const observed = {
    domain: crawl.domain,
    pagesCrawled: crawl.pages.length,
    cannibalizationCount: cannibalization.length,
    cannibalization,
    entities,
    keywordScore,
  };

  if (audited.length === 0) {
    return Response.json({
      result: { ...observed, keywords: [], suggestedKeywords: [], cannibalizationGuidance: [], opportunities: [], generatedAt: new Date().toISOString() },
    });
  }

  // Only keywords the deterministic audit already flagged need an AI fix
  // suggestion — usually well under the full keyword table, which keeps
  // the AI's reply small and fast regardless of site size. Difficulty is
  // asked for every keyword, but it's just two short fields each (a number
  // + a confidence word), not prose, so it stays cheap even at full scale.
  const flagged = audited.filter((k) => k.flags.length > 0);

  const keywordBlock = audited.length
    ? audited.map((k) => `[id=${k.id}] "${k.keyword}" — relevance ${k.relevance}/100, status: ${k.status}, used on ${k.pagesUsedOn} of ${crawl.pages.length} page(s), appears in: ${describeUsage(k)}${k.flags.length ? `. Flags: ${k.flags.join("; ")}` : ""}`).join("\n")
    : "(no keyword candidates found in the crawled text)";
  const flaggedBlock = flagged.length
    ? flagged.map((k) => `[id=${k.id}] "${k.keyword}" (${k.status}, relevance ${k.relevance}/100). Currently: ${describeUsage(k)}. Problem(s): ${k.flags.join("; ")}`).join("\n")
    : "(no flagged keywords — every tracked keyword already has strong placement)";
  const entityBlock = entities.length ? entities.slice(0, 15).map((e) => `${e.entity} (×${e.occurrences})`).join(", ") : "(none detected)";
  const existingKeywordSet = new Set(audited.map((k) => k.keyword.toLowerCase()));
  const cannibalBlock = cannibalization.length
    ? cannibalization.map((c, i) => `${i + 1}. [id=${c.clusterId}] Keywords: ${c.keywords.join(", ")}. Pages competing for this: ${c.competingPages.map((p) => `"${p.title}" (${p.url})`).join(" vs ")}`).join("\n")
    : "(none detected)";

  const system = `You are VertexRank AI, a practical on-page keyword strategist. You are given a real, deterministically-computed keyword usage audit from a full crawl of every page on a site — the relevance scores, placement facts, and flagged problems are FACT, not your invention; you never re-score or contradict them. Your job is narrow: (1) write one concrete, one-sentence fix for each flagged keyword, grounded only in where it's currently used/not used, (2) propose a short list of genuinely new, specific keyword phrases this site should target but currently doesn't (never repeat a keyword already in the audited table), grounded in the real entities/topics found on the site, (3) estimate ranking difficulty (0-100, 0=trivial 100=extremely competitive) with a confidence level for every keyword listed, real or newly suggested, and (4) explain cannibalization risk in plain language. Difficulty is a professional estimate based on keyword specificity/competitiveness, not a claim of real search data. You never invent search volume, ranking positions, or traffic figures.`;

  const prompt = `Website: ${crawl.domain}
Pages crawled: ${crawl.pages.length}

Full ranked keyword table (real usage data from the crawl):
${keywordBlock}

Keywords flagged as needing a fix (subset of the table above):
${flaggedBlock}

Proper-noun entities/topics found across the site (real, from the crawl):
${entityBlock}

Keyword cannibalization detected (2+ different pages strongly targeting the same topic):
${cannibalBlock}

For EVERY keyword in the full table above (not just flagged ones), provide a difficulty estimate:
- id (must match the [id=kw_...] shown)
- difficulty: integer 0-100
- confidence: "Low", "Medium", or "High"

For each flagged keyword above, additionally provide:
- id (must match the [id=kw_...] shown)
- fixSuggestion: one concrete sentence on exactly how to fix its placement (e.g. "Add this to the H1 of the Services page — it's currently buried in body text only")
- recommendedPlacement: one short phrase naming where it should go (e.g. "Page title + H1 of /services")

Then propose 6-10 NEW keyword phrases this site should consider targeting that are NOT already in the keyword table above. Ground each in the real entities/topics/business shown, not generic SEO filler. For each, provide:
- keyword: the specific phrase
- type: one of ${KEYWORD_TYPES.map((t) => `"${t}"`).join(", ")} — classify it the same way an SEO tool would classify a real keyword of that shape (e.g. a phrase with a place name is "Local", a single generic word is "Primary", a 2-word phrase is "Secondary", 4+ specific words is "Long-tail")
- intent: "Informational", "Commercial", "Transactional", or "Navigational"
- relevance: integer 0-100, how strategically relevant this phrase is to the business shown above (this sits in the SAME ranked table as the real keywords above, so judge it on the same 0-100 scale they use)
- whyRelevant: one sentence on why this fits the business shown above
- recommendedPlacement: one short phrase naming where/how to introduce it (e.g. "New H2 section on the homepage" or "New blog post targeting this")
- priority: "Critical", "High", "Medium", or "Low"
- difficulty: integer 0-100
- confidence: "Low", "Medium", or "High"

Then for each numbered cannibalization case above, provide:
- clusterId (must match the [id=...] shown)
- explanation: plain-language explanation of the risk, grounded in the real competing pages listed
- recommendedAction: one of "Consolidate" (merge into one page), "Differentiate" (keep both but make each target a clearly different angle/intent), or "Redirect" (one page should redirect to the other)
- primaryPageUrl: which of the competing page URLs should be the primary/surviving page (must be one of the URLs listed for that case)
- reasoning: one sentence grounded in the real data for why that page should be primary

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "keywordDifficulty": [ { "id": "string", "difficulty": 0, "confidence": "Low|Medium|High" } ],
  "keywordFixes": [ { "id": "string", "fixSuggestion": "string", "recommendedPlacement": "string" } ],
  "suggestedKeywords": [ { "keyword": "string", "type": "string", "intent": "string", "relevance": 0, "whyRelevant": "string", "recommendedPlacement": "string", "priority": "Critical|High|Medium|Low", "difficulty": 0, "confidence": "Low|Medium|High" } ],
  "cannibalizationGuidance": [ { "clusterId": "string", "explanation": "string", "recommendedAction": "string", "primaryPageUrl": "string", "reasoning": "string" } ]
}`;

  try {
    // This is still the largest AI request in the app, so it keeps a
    // larger token/time budget than the shared defaults (which are tuned
    // for much lighter routes). maxDuration on this route is 60s;
    // overallBudgetMs leaves ~10s of slack below that ceiling.
    const parsed = await callOpenRouterJson({
      system,
      prompt,
      maxTokens: 5500,
      temperature: 0.5,
      perModelTimeoutMs: 18000,
      overallBudgetMs: 48000,
    });

    const fixById = new Map((parsed.keywordFixes || []).map((f) => [f.id, f]));
    const difficultyById = new Map((parsed.keywordDifficulty || []).map((d) => [d.id, d]));
    const keywords = audited.map((k) => {
      const fix = fixById.get(k.id);
      const diff = difficultyById.get(k.id);
      return {
        ...k,
        fixSuggestion: k.flags.length ? (fix?.fixSuggestion || "") : "",
        recommendedPlacement: k.flags.length ? (fix?.recommendedPlacement || "") : "",
        priority: k.flags.length ? priorityForKeyword(k) : "Low",
        difficulty: typeof diff?.difficulty === "number" ? Math.max(0, Math.min(100, Math.round(diff.difficulty))) : null,
        difficultyConfidence: ["Low", "Medium", "High"].includes(diff?.confidence) ? diff.confidence : null,
        source: fix ? "Crawled Data + VertexRank AI Analysis" : "Crawled Data",
      };
    }).sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.relevance - a.relevance);

    const suggestedKeywords = (parsed.suggestedKeywords || [])
      .filter((s) => s.keyword && !existingKeywordSet.has(s.keyword.toLowerCase()))
      .slice(0, 10)
      .map((s, idx) => ({
        id: `sugg_${idx}`,
        keyword: s.keyword,
        type: KEYWORD_TYPES.includes(s.type) ? s.type : "Long-tail",
        intent: s.intent || "Informational",
        relevance: typeof s.relevance === "number" ? Math.max(0, Math.min(100, Math.round(s.relevance))) : 50,
        occurs: 0,
        pagesUsedOn: 0,
        usage: { title: 0, metaDescription: 0, h1: 0, h2h3: 0, body: 0, alt: 0, schema: 0 },
        whyRelevant: s.whyRelevant || "",
        recommendedPlacement: s.recommendedPlacement || "",
        priority: ["Critical", "High", "Medium", "Low"].includes(s.priority) ? s.priority : "Medium",
        difficulty: typeof s.difficulty === "number" ? Math.max(0, Math.min(100, Math.round(s.difficulty))) : null,
        difficultyConfidence: ["Low", "Medium", "High"].includes(s.confidence) ? s.confidence : null,
        source: "VertexRank AI Analysis",
      }));

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

    // "opportunities" keeps the exact shape the Dashboard's Unified AI
    // Recommendations / Action Center already expect from this module
    // (id/problem/evidence/recommendedAction/priority/confidence/source) —
    // just populated from the new, more concrete fix + new-keyword data
    // instead of a separate AI-invented list. "High" confidence on fixes
    // because they're grounded in directly observed placement facts;
    // "Medium" on new keywords since there's no real search-volume data.
    const opportunities = [
      ...keywords.filter((k) => k.flags.length > 0).map((k) => ({
        id: `kwop_${k.id}`,
        problem: `"${k.keyword}" — ${k.flags[0]}`,
        evidence: `Currently used in: ${describeUsage(k)}. Relevance ${k.relevance}/100, used on ${k.pagesUsedOn} of ${crawl.pages.length} page(s).`,
        recommendedAction: k.fixSuggestion || "Improve this keyword's placement in titles/headings.",
        priority: k.priority,
        confidence: "High",
        source: k.source,
      })),
      ...suggestedKeywords.map((s) => ({
        id: `kwop_${s.id}`,
        problem: `Not yet targeted: "${s.keyword}"`,
        evidence: s.whyRelevant,
        recommendedAction: s.recommendedPlacement || `Add "${s.keyword}" to relevant page content.`,
        priority: s.priority,
        confidence: "Medium",
        source: s.source,
      })),
    ];

    return Response.json({
      result: {
        ...observed,
        keywords,
        suggestedKeywords,
        cannibalizationGuidance,
        opportunities,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return Response.json({
      result: {
        ...observed,
        keywords: audited
          .map((k) => ({ ...k, fixSuggestion: "", recommendedPlacement: "", priority: k.flags.length ? priorityForKeyword(k) : "Low", difficulty: null, difficultyConfidence: null, source: "Crawled Data" }))
          .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.relevance - a.relevance),
        suggestedKeywords: [],
        cannibalizationGuidance: [],
        opportunities: [],
        generatedAt: new Date().toISOString(),
      },
      warning: err.message || "VertexRank AI couldn't generate fix suggestions, difficulty estimates, or new keyword ideas, but the usage audit and score above are real, computed from the crawl.",
    });
  }
}
