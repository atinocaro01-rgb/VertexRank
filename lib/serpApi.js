// Shared helpers for the /api/serp/* routes: building the provider from the environment, mapping errors to JSON
// responses, and a cache so repeating a search doesn't spend the provider's monthly allowance. The routes stay thin.

import { createSerp, SerpError } from "./serpProvider.js";
import { createCache } from "./gscApi.js";

export function serpFromEnv(env = process.env, fetchImpl) {
  return createSerp({ env, fetchImpl });
}

const STATUS = { NOT_CONFIGURED: 503, BAD_CONFIG: 503, BAD_REQUEST: 400, AUTH_FAILED: 502, RATE_LIMIT: 429, QUOTA: 429, NETWORK: 502, UPSTREAM: 502 };

/** SerpErrors carry messages written for people and never the key; anything else becomes a generic message. */
export function errorResponse(err) {
  if (err instanceof SerpError) return Response.json({ error: err.message, code: err.code }, { status: STATUS[err.code] || 502 });
  console.error("[serp] unexpected error:", err?.name, err?.message); // message only
  return Response.json({ error: "Something went wrong fetching search results. Try again." }, { status: 500 });
}

// A result is a snapshot, but rankings don't move minute to minute, and each fresh search spends allowance. Six hours;
// the person can always ask for fresh results. Per server instance only (the same limits as the Search Console cache).
export const SERP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const createSerpCache = () => createCache({ ttlMs: SERP_CACHE_TTL_MS, max: 200 });

export const serpCacheKey = (provider, { query, country, device }) => `${provider}|${country}|${device}|${query.toLowerCase()}`;
