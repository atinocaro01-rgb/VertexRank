import { callOpenRouterJson } from "../../../lib/openrouter";
import { computeGeoSignals, extractEntityCandidates, scoreFromFlags, truncate } from "../../../lib/textIntelligence";

export const runtime = "nodejs";
export const maxDuration = 60;

const GEO_WEIGHTS = {
  hasOrganizationSchema: 16,
  hasProductOrServiceSchema: 10,
  hasArticleOrAuthorSchema: 6,
  hasContactSignal: 12,
  hasAboutSignal: 12,
  hasLocationSignal: 10,
  hasAudienceSignal: 10,
  hasCredentialSignal: 8,
  hasSocialProofSignal: 10,
  hasPolicySignal: 4,
  hasClearProductNaming: 2,
};

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

  const flags = computeGeoSignals(scanMeta);
  const { score: visibilityScore, breakdown } = scoreFromFlags(flags, GEO_WEIGHTS);
  const entities = extractEntityCandidates(scanMeta, 15);

  const system = `You are VertexRank AI, a GEO (Generative/AI-search visibility) analyst. You are given real crawled page content and a real checklist of entity/authority signals already detected. You judge how clearly an AI system reading only this content could understand who this business is, what it does, and why it should be trusted — grounded ONLY in the content given. You never claim inclusion in any AI system's answers is guaranteed, and you never invent facts not present in the text.`;

  const prompt = `Website: ${scanMeta.domain}
Page title: "${scanMeta.title || "(missing)"}"
Meta description: "${scanMeta.metaDescription || "(missing)"}"
H1: "${scanMeta.h1Text || "(missing)"}"
Headings: ${[...(scanMeta.h2Texts || []), ...(scanMeta.h3Texts || [])].join(" | ") || "(none)"}
Visible body text (truncated): "${truncate(scanMeta.fullText || scanMeta.bodySnippet, 2800)}"
Schema types already present: ${(scanMeta.schemaTypes || []).join(", ") || "(none)"}
Entities/proper nouns detected in the text: ${entities.slice(0, 12).map((e) => e.entity).join(", ") || "(none detected)"}
Detected signal checklist (from the real crawl): ${Object.entries(flags).map(([k, v]) => `${k}=${v}`).join(", ")}

Based only on the content above, assess these eight GEO factors. For each, give a 0-100 score (your qualitative judgment of how clearly this factor is established for an AI system reading only this content) and one grounded sentence of evidence or gap:
- entityClarity — is it clear who the organization is, what it does, who it's for?
- authority — visible trust signals: about/contact/credentials/testimonials/references
- contentStructure — how cleanly organized into scannable sections
- evidence — presence of specifics, data, sources an AI system would want to cite
- brandConsistency — does the page consistently name itself/its offerings the same way
- extractability — how easily a direct answer could be lifted from this page
- structuredData — coverage of schema.org markup
- topicCoverage — breadth/depth of coverage of the business's core subject matter

Then list up to 6 concrete "AI Visibility Opportunities" — specific, grounded actions that would make this page easier for AI/answer engines to understand and cite (e.g. add Organization schema, clarify target audience in the first paragraph, add a dedicated About/Team section, add case studies). Do NOT claim these guarantee inclusion in any AI answer — frame them as opportunities.

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "factors": {
    "entityClarity": { "score": 0, "note": "string" },
    "authority": { "score": 0, "note": "string" },
    "contentStructure": { "score": 0, "note": "string" },
    "evidence": { "score": 0, "note": "string" },
    "brandConsistency": { "score": 0, "note": "string" },
    "extractability": { "score": 0, "note": "string" },
    "structuredData": { "score": 0, "note": "string" },
    "topicCoverage": { "score": 0, "note": "string" }
  },
  "opportunities": [
    { "title": "string", "why": "string", "priority": "Critical|High|Medium|Low" }
  ]
}`;

  try {
    const parsed = await callOpenRouterJson({ system, prompt, maxTokens: 1800, temperature: 0.45 });
    if (!parsed.factors) throw new Error("VertexRank AI's response was missing factor data.");

    const factors = {};
    for (const key of ["entityClarity", "authority", "contentStructure", "evidence", "brandConsistency", "extractability", "structuredData", "topicCoverage"]) {
      const f = parsed.factors[key] || {};
      factors[key] = { score: clampInt(f.score, 0, 100, 40), note: f.note || "" };
    }

    const opportunities = (parsed.opportunities || []).map((o, idx) => ({
      id: `geoo_${idx}`,
      title: o.title || "",
      why: o.why || "",
      priority: o.priority || "Medium",
      source: "VertexRank AI Analysis",
    }));

    return Response.json({
      result: {
        visibilityScore,
        signalBreakdown: breakdown,
        flags,
        entities,
        factors,
        opportunities,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return Response.json({ error: err.message || "VertexRank AI couldn't complete GEO analysis. Try again." }, { status: 502 });
  }
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
