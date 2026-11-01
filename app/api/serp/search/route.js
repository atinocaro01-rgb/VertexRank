import { guardJson } from "../../../../lib/apiGuard";
import { validateSerpRequest } from "../../../../lib/serpProvider";
import { serpFromEnv, errorResponse, createSerpCache, serpCacheKey } from "../../../../lib/serpApi";

export const runtime = "nodejs";
export const maxDuration = 30;

const cache = createSerpCache();

// Organic results for ONE query, country and device from the configured provider (never a URL the client chose).
// Shape: { query, country, device, results: [{ rank, title, url, snippet }], source, observedAt, cached }.
export async function POST(req) {
  const guard = await guardJson(req, "serp");
  if (!guard.ok) return guard.response;
  try {
    const request = validateSerpRequest(guard.body);
    const serp = serpFromEnv();
    const key = serpCacheKey(serp.id, request);
    if (guard.body.refresh === true) cache.delete(key); // the person asked for fresh results
    const { value, cached } = await cache(key, () => serp.search(request));
    return Response.json({ ...value, cached });
  } catch (err) {
    return errorResponse(err);
  }
}
