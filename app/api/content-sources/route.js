import { guardJson } from "../../../lib/apiGuard";
import { validateSerpRequest } from "../../../lib/serpProvider";
import { serpFromEnv, errorResponse, createSerpCache, serpCacheKey } from "../../../lib/serpApi";
import { rankSourceCandidates } from "../../../lib/sourceTools";
import { hostOf } from "../../../lib/serpMatch";

export const runtime = "nodejs";
export const maxDuration = 30;

const cache = createSerpCache();

// Candidate sources for an article: what currently ranks for the topic, minus your own site and social/Q&A/marketplace hosts, with
// authoritative hosts (government, education, international bodies, organisations) first. Spends ONE live search (same allowance and
// limits as Live Results). The person chooses which to use; nothing is cited until its text has been read.
export async function POST(req) {
  const guard = await guardJson(req, "serp");
  if (!guard.ok) return guard.response;
  try {
    const request = validateSerpRequest({ query: guard.body.query, country: guard.body.country, device: "desktop" });
    const serp = serpFromEnv();
    const { value } = await cache(serpCacheKey(serp.id, request), () => serp.search(request));
    return Response.json({ query: request.query, country: request.country, observedAt: value.observedAt, candidates: rankSourceCandidates(value.results, hostOf(guard.body.siteHost || "")) });
  } catch (err) {
    return errorResponse(err);
  }
}
