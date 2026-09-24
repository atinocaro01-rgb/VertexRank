import { callOpenRouterJson } from "../../../lib/openrouter";
import { classifyBacklinkOpportunities } from "../../../lib/backlinkClassifier";

// Feature: Backlink Opportunities. Typically run against a CRAWL OF A
// COMPETITOR (or any site in the client's space): the idea is that sites
// which already link to a competitor in this niche are plausible prospects
// to ALSO consider linking to the client — directories, associations,
// publications, and resource pages a business in this space tends to get
// listed on. `crawl` is whichever site's outbound links should be mined;
// `ourContext` (optional) is a short description of the CLIENT's own
// business, used only to ground the AI's relevance reasoning.
//
// Safety requirement (explicit, from the person who requested this
// feature): this must never claim a link exists, is guaranteed, or will be
// obtained. That's enforced in three independent layers here, since prompt
// instructions alone aren't a guarantee of model output:
//   1. The system prompt explicitly forbids this framing.
//   2. A fixed, NOT-AI-generated disclaimer string is always included in
//      the response, regardless of what the model returns.
//   3. Every opportunity is labeled source: "VertexRank AI Estimate" (see
//      lib/dataLabel.js's convention) rather than "Analysis" — this is
//      explicitly a speculative prospect list, not an observed fact or a
//      confident conclusion from evidence.

export const runtime = "nodejs";
export const maxDuration = 60;

const DISCLAIMER = "These are potential prospects worth investigating, identified because they already link to a similar business — not existing backlinks, and not a guarantee that any link can be obtained.";

const MAX_CANDIDATES_TO_AI = 25;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const { crawl, ourContext } = body || {};
  if (!crawl?.pages?.length) {
    return Response.json({ error: "Site crawl data is required. Run a full-site crawl of the target site first." }, { status: 400 });
  }

  const candidates = classifyBacklinkOpportunities(crawl.pages);

  const observed = {
    sourceDomain: crawl.domain,
    pagesCrawled: crawl.pages.length,
    candidateDomainsFound: candidates.length,
    candidates,
    disclaimer: DISCLAIMER,
  };

  if (candidates.length === 0) {
    return Response.json({
      result: { ...observed, opportunities: [], generatedAt: new Date().toISOString() },
    });
  }

  const topCandidates = candidates.slice(0, MAX_CANDIDATES_TO_AI);
  const candidateBlock = topCandidates
    .map((c, i) => `${i + 1}. [host=${c.host}] Type: ${c.destinationType}. Linked from ${c.linkingPageCount} page(s) on ${crawl.domain}. Example: anchor text "${c.examples[0]?.anchorText || "(none)"}" on "${c.examples[0]?.fromPageTitle}"${c.resourcePageMentions > 0 ? " (found on a resources/partners-style page)" : ""}`)
    .join("\n");

  const system = `You are VertexRank AI. You are given a real list of external domains that a real competitor site links to, classified by type. Your ONLY job is to explain, for domains that look like genuine prospects, WHY that domain might be worth the client investigating as a possible backlink source — reasoning from the domain's type and how the competitor uses it. You MUST NOT claim any of these are existing backlinks for the client, that a link is guaranteed, or that VertexRank has contacted anyone. Use only cautious, prospecting language: "worth investigating", "a plausible prospect", "consider reaching out to" — never "you will get a backlink" or similar certainty. Skip any domain in the list that doesn't look like a genuine prospect (e.g. a one-off unrelated mention).`;

  const contextLine = ourContext ? `The client's own business, for relevance judgment: ${String(ourContext).slice(0, 400)}` : "No description of the client's own business was provided — reason generally from each domain's type.";

  const prompt = `Competitor/target site analyzed: ${crawl.domain}
${contextLine}

Candidate external domains this site links to (real, observed data):
${candidateBlock}

For each candidate worth surfacing (skip weak/irrelevant ones), provide:
- host (must match one of the [host=...] values above)
- whyRelevant: one grounded sentence, reasoning from the domain's type and how the competitor uses it — never claim it's already a backlink for the client
- suggestedApproach: one short, concrete, cautious next step (e.g. "check their submission guidelines", "see if they accept guest content")
- priority: "High"|"Medium"|"Low" based on how strong a fit this looks like

Respond with ONLY a JSON object, no markdown fences, no commentary:
{ "opportunities": [ { "host": "string", "whyRelevant": "string", "suggestedApproach": "string", "priority": "string" } ] }`;

  try {
    const parsed = await callOpenRouterJson({ system, prompt, maxTokens: 2000, temperature: 0.4 });
    if (!Array.isArray(parsed.opportunities)) throw new Error("VertexRank AI's response was missing opportunity data.");

    const byHost = new Map(topCandidates.map((c) => [c.host, c]));
    const opportunities = parsed.opportunities
      .filter((o) => byHost.has(o.host)) // never trust an AI-invented domain
      .map((o, idx) => {
        const c = byHost.get(o.host);
        return {
          id: `bko_${idx}`,
          host: o.host,
          destinationType: c.destinationType,
          linkingPageCount: c.linkingPageCount,
          example: c.examples[0] || null,
          whyRelevant: o.whyRelevant || "",
          suggestedApproach: o.suggestedApproach || "",
          priority: o.priority || "Medium",
          source: "VertexRank AI Estimate",
        };
      });

    return Response.json({
      result: { ...observed, opportunities, generatedAt: new Date().toISOString() },
    });
  } catch (err) {
    // The classified candidate list never depended on the AI step — it's
    // still real, useful, and returned even if the AI explanation fails.
    return Response.json({
      result: { ...observed, opportunities: [], generatedAt: new Date().toISOString() },
      warning: err.message || "VertexRank AI couldn't generate relevance explanations, but the candidate list above is real data from the crawl.",
    });
  }
}
