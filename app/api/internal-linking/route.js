import { callOpenRouterJson } from "../../../lib/openrouter";
import { findLinkCandidates } from "../../../lib/internalLinking";

// Targets orphan pages and weakly-linked pages (already identified
// deterministically by lib/siteCrawler.js's link-graph analysis) and
// recommends which other pages should link to them, with natural anchor
// text. The candidate shortlist per target is deterministic (content
// similarity); the AI layer picks the best of those and writes the anchor
// text, since "which of these related pages makes the most natural sense
// to link from, worded how a human editor would" is a judgment call, not
// something a similarity score alone should decide.

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_TARGETS_PER_REQUEST = 15;

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

  const orphans = crawl.siteWide?.orphanPages || [];
  const weak = crawl.siteWide?.weakLinkedPages || [];
  const allTargets = [...new Set([...orphans, ...weak])];
  const truncatedTargets = allTargets.length > MAX_TARGETS_PER_REQUEST;
  const targets = allTargets.slice(0, MAX_TARGETS_PER_REQUEST);

  const observed = {
    domain: crawl.domain,
    pagesCrawled: crawl.pages.length,
    orphanPageCount: orphans.length,
    weakLinkedPageCount: weak.length,
    targetsAnalyzed: targets.length,
    targetsTruncated: truncatedTargets,
  };

  if (targets.length === 0) {
    return Response.json({
      result: { ...observed, recommendations: [], generatedAt: new Date().toISOString(), note: "No orphan or weakly-linked pages were found in this crawl — internal linking looks healthy." },
    });
  }

  const candidateSets = findLinkCandidates(crawl.pages, targets, { topN: 5 });
  const withCandidates = candidateSets.filter((t) => t.candidates.length > 0);
  const withoutCandidates = candidateSets.filter((t) => t.candidates.length === 0);

  if (withCandidates.length === 0) {
    // Every target is real, but none has ANY topically-related page on the
    // site — no AI call needed, there's nothing for it to choose between.
    return Response.json({
      result: {
        ...observed, recommendations: [], generatedAt: new Date().toISOString(),
        note: "Orphan/weak pages were found, but no other crawled page shares enough content overlap to suggest a natural link from.",
      },
    });
  }

  const targetBlock = withCandidates
    .map((t, i) => `${i + 1}. TARGET: "${t.targetTitle}" (${t.targetUrl}), H1: "${t.targetH1}"\n   Candidate source pages: ${t.candidates.map((c) => `"${c.title}" (${c.url}) [${c.similarity}% content overlap]`).join("; ")}`)
    .join("\n");

  const system = `You are VertexRank AI, an internal linking strategist. You are given real target pages that currently have few or no internal links pointing at them, and a real, deterministically-ranked shortlist of other pages on the same site that share topical content overlap. Your job is to pick which of the GIVEN candidates make natural editorial sense to link from (not all candidates need to be used), and write natural anchor text for each — text a human editor would actually write, incorporating a relevant term, never generic text like "click here". You never invent a source page that wasn't in the candidate list given.`;

  const prompt = `Website: ${crawl.domain}

${targetBlock}

For each numbered target above, recommend up to 3 of the GIVEN candidate pages to add an internal link from (fewer if the candidates aren't a good editorial fit — don't force a link that wouldn't make sense to a reader). For each recommended link, write natural anchor text and a one-sentence reason.

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "recommendations": [
    {
      "targetUrl": "string (must match one of the TARGET urls above)",
      "links": [
        { "fromUrl": "string (must match one of that target's candidate urls)", "anchorText": "string", "reason": "string" }
      ]
    }
  ]
}`;

  try {
    const parsed = await callOpenRouterJson({ system, prompt, maxTokens: 2200, temperature: 0.5 });
    if (!Array.isArray(parsed.recommendations)) throw new Error("VertexRank AI's response was missing recommendation data.");

    const candidatesByTarget = new Map(withCandidates.map((t) => [t.targetUrl, new Set(t.candidates.map((c) => c.url))]));
    const recommendations = parsed.recommendations
      .filter((r) => candidatesByTarget.has(r.targetUrl))
      .map((r, idx) => {
        const validSources = candidatesByTarget.get(r.targetUrl);
        const links = (r.links || [])
          .filter((l) => validSources.has(l.fromUrl)) // never trust an AI-invented source page
          .map((l, lidx) => ({ id: `il_${idx}_${lidx}`, fromUrl: l.fromUrl, anchorText: l.anchorText || "", reason: l.reason || "", source: "VertexRank AI Analysis" }));
        return { id: `ilt_${idx}`, targetUrl: r.targetUrl, links };
      })
      .filter((r) => r.links.length > 0);

    return Response.json({
      result: {
        ...observed,
        recommendations,
        pagesWithNoRelatedContent: withoutCandidates.map((t) => t.targetUrl),
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    // The deterministic candidate shortlist is still useful on its own even
    // without the AI's final pick + anchor text — return it rather than
    // nothing.
    return Response.json({
      result: {
        ...observed,
        recommendations: [],
        candidateShortlist: withCandidates,
        generatedAt: new Date().toISOString(),
      },
      warning: err.message || "VertexRank AI couldn't finalize link recommendations, but the candidate shortlist above is real, computed from content similarity.",
    });
  }
}
