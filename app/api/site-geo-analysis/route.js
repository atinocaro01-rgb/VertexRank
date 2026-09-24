import { callOpenRouterJson } from "../../../lib/openrouter";
import { computeGeoSignals, extractEntityCandidates, scoreFromFlags, truncate } from "../../../lib/textIntelligence";
import { aggregateSiteFlags, samplePagesForPrompt } from "../../../lib/siteSignals";

// Site-wide counterpart to /api/geo-analysis. GEO signals (Organization
// schema, About/Contact info, credentials, testimonials...) are naturally
// SITE-level facts even though each is only literally present on one URL —
// a business either has a clear About page somewhere or it doesn't. See
// lib/siteSignals.js for how "does the site have X" is defined.

export const runtime = "nodejs";
export const maxDuration = 60;

const GEO_WEIGHTS = {
  hasOrganizationSchema: 16, hasProductOrServiceSchema: 10, hasArticleOrAuthorSchema: 6,
  hasContactSignal: 12, hasAboutSignal: 12, hasLocationSignal: 10, hasAudienceSignal: 10,
  hasCredentialSignal: 8, hasSocialProofSignal: 10, hasPolicySignal: 4, hasClearProductNaming: 2,
};

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
  const pages = crawl.pages;

  // ---- deterministic, site-wide evidence layer (no AI) ----
  const { siteFlags, evidence } = aggregateSiteFlags(pages, computeGeoSignals);
  const { score: visibilityScore, breakdown } = scoreFromFlags(siteFlags, GEO_WEIGHTS);

  const entityCounts = new Map();
  for (const p of pages) {
    for (const e of extractEntityCandidates(p, 15)) {
      entityCounts.set(e.entity, (entityCounts.get(e.entity) || 0) + e.occurrences);
    }
  }
  const entities = [...entityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([entity, occurrences]) => ({ entity, occurrences }));

  const observed = {
    domain: crawl.domain,
    pagesCrawled: pages.length,
    visibilityScore,
    signalBreakdown: breakdown,
    flags: siteFlags,
    evidence,
    entities,
  };

  // ---- AI layer ----
  const sample = samplePagesForPrompt(pages, crawl.startUrl, 15);
  const pageSummaries = sample
    .map((p) => `- "${p.title || "(untitled)"}" (${p.url}) — ${truncate(p.fullText, 220)}`)
    .join("\n");

  const system = `You are VertexRank AI, a GEO (Generative/AI-search visibility) analyst reasoning about an ENTIRE website, not a single page. You are given real crawled data from multiple real pages of the same site and a real checklist of entity/authority signals already detected anywhere on the site. You judge how clearly an AI system reading these pages could understand who this business is, what it does, and why it should be trusted — grounded ONLY in the content given. You never claim inclusion in any AI system's answers is guaranteed, and you never invent facts not present in the text.`;

  const prompt = `Website: ${crawl.domain}
Pages crawled: ${pages.length}${crawl.truncated ? " (crawl was time/page-limited, may not cover the whole site)" : ""}
Entities/proper nouns detected across the site: ${entities.slice(0, 15).map((e) => e.entity).join(", ") || "(none detected)"}
Site-wide signal checklist (true if ANY crawled page establishes it): ${Object.entries(siteFlags).map(([k, v]) => `${k}=${v}`).join(", ")}

Sample of ${sample.length} pages from the crawl (title, URL, and an excerpt):
${pageSummaries}

Based only on the content above, assess these eight GEO factors for the SITE AS A WHOLE. For each, give a 0-100 score and one grounded sentence of evidence or gap:
- entityClarity — is it clear who the organization is, what it does, who it's for?
- authority — visible trust signals: about/contact/credentials/testimonials/references
- contentStructure — how cleanly the site is organized into scannable sections/pages
- evidence — presence of specifics, data, sources an AI system would want to cite
- brandConsistency — does the site consistently name itself/its offerings the same way across pages
- extractability — how easily a direct answer about this business could be lifted from these pages
- structuredData — coverage of schema.org markup across the site
- topicCoverage — breadth/depth of coverage of the business's core subject matter across all pages

Then list up to 6 concrete SITE-LEVEL "AI Visibility Opportunities" — grounded, specific actions (e.g. "add Organization schema sitewide", "add a dedicated Team/About page", "consolidate scattered case studies onto one page"). Do NOT claim these guarantee inclusion in any AI answer — frame them as opportunities.

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "factors": {
    "entityClarity": { "score": 0, "note": "string" }, "authority": { "score": 0, "note": "string" },
    "contentStructure": { "score": 0, "note": "string" }, "evidence": { "score": 0, "note": "string" },
    "brandConsistency": { "score": 0, "note": "string" }, "extractability": { "score": 0, "note": "string" },
    "structuredData": { "score": 0, "note": "string" }, "topicCoverage": { "score": 0, "note": "string" }
  },
  "opportunities": [ { "title": "string", "why": "string", "priority": "Critical|High|Medium|Low" } ]
}`;

  try {
    const parsed = await callOpenRouterJson({ system, prompt, maxTokens: 2000, temperature: 0.45 });
    if (!parsed.factors) throw new Error("VertexRank AI's response was missing factor data.");

    const factors = {};
    for (const key of ["entityClarity", "authority", "contentStructure", "evidence", "brandConsistency", "extractability", "structuredData", "topicCoverage"]) {
      const f = parsed.factors[key] || {};
      factors[key] = { score: clampInt(f.score, 0, 100, 40), note: f.note || "" };
    }

    const opportunities = (parsed.opportunities || []).map((o, idx) => ({
      id: `sgeoo_${idx}`,
      title: o.title || "",
      why: o.why || "",
      priority: o.priority || "Medium",
      source: "VertexRank AI Analysis",
    }));

    return Response.json({
      result: { ...observed, factors, opportunities, generatedAt: new Date().toISOString() },
    });
  } catch (err) {
    return Response.json({
      result: { ...observed, factors: null, opportunities: [], generatedAt: new Date().toISOString() },
      warning: err.message || "VertexRank AI couldn't generate site-wide GEO factors, but the observed signal data above is real crawl data.",
    });
  }
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
