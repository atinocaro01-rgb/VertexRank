// Shared helpers for the /api/gsc/* routes: building the (read-only) Search Console client from the environment,
// mapping errors to JSON responses, and a short report cache. The routes themselves stay thin.

import { createGscAuth, GscError } from "./gscAuth.js";
import { createGscClient } from "./gscClient.js";

export function gscFromEnv(env = process.env, fetchImpl) {
  const auth = createGscAuth({ env, fetchImpl });
  return { auth, client: createGscClient({ auth, fetchImpl }) };
}

const STATUS = { NOT_CONFIGURED: 503, BAD_CONFIG: 503, BAD_KEY: 502, AUTH_FAILED: 502, NETWORK: 502, FORBIDDEN: 403, NOT_FOUND: 404, RATE_LIMIT: 429, BAD_REQUEST: 400, UPSTREAM: 502 };

/** GscError messages are written for people and never contain the key; anything else becomes a generic message. */
export function errorResponse(err) {
  if (err instanceof GscError) return Response.json({ error: err.message, code: err.code }, { status: STATUS[err.code] || 502 });
  console.error("[gsc] unexpected error:", err?.name, err?.message); // message only
  return Response.json({ error: "Something went wrong talking to Search Console. Try again." }, { status: 500 });
}

/** Tiny in-memory cache (per server instance) so repeated clicks don't re-run nine Google queries. Failures aren't cached. */
export function createCache({ ttlMs = 10 * 60 * 1000, max = 50, now = () => Date.now() } = {}) {
  const map = new Map();
  async function cached(key, fn) {
    const hit = map.get(key);
    if (hit && now() - hit.at < ttlMs) return { value: hit.value, cached: true };
    const value = await fn(); // if this throws, nothing is cached
    if (map.size >= max) map.delete(map.keys().next().value);
    map.set(key, { at: now(), value });
    return { value, cached: false };
  }
  cached.delete = (key) => map.delete(key);
  return cached;
}
