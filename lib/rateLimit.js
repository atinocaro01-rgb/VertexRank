// Fixed-window rate limiting.
//
// Backing store, in order of preference:
//   1. Upstash Redis / Vercel KV over REST, when UPSTASH_REDIS_REST_URL +
//      UPSTASH_REDIS_REST_TOKEN (or Vercel KV's KV_REST_API_URL + KV_REST_API_TOKEN)
//      are set. This is the only option that works properly on Vercel, because
//      each serverless invocation can land on a different instance.
//   2. An in-memory Map. Per-instance only, so it is a best-effort brake (it
//      still stops a single hot instance being hammered) — NOT a real limit.
//      A one-time warning is logged in production when this is in use.
//
// If Redis is configured but errors out, we fall back to memory for that call
// rather than failing open with no limit at all.

import { createHash } from "node:crypto";

const memory = new Map(); // key -> { count, resetAt }
let warnedNoStore = false;

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

function memoryHit(key, windowSec, now) {
  if (memory.size > 5000) {
    for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
  }
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

async function redisHit(cfg, key, windowSec) {
  const res = await fetch(`${cfg.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify([["INCR", key], ["EXPIRE", key, String(windowSec + 5)]]),
    signal: AbortSignal.timeout(1500),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`rate-limit store HTTP ${res.status}`);
  const data = await res.json();
  const count = Number(data?.[0]?.result);
  if (!Number.isFinite(count)) throw new Error("rate-limit store returned no count");
  return count;
}

/**
 * Registers one hit against `${name}:${id}` in a fixed window and reports
 * whether it is within `limit`. Returns { ok, count, limit, retryAfterSec }.
 */
export async function hit({ name, id, limit, windowSec }) {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const bucket = Math.floor(now / windowMs);
  const retryAfterSec = Math.max(1, Math.ceil(((bucket + 1) * windowMs - now) / 1000));
  const key = `vr:rl:${name}:${windowSec}:${id}:${bucket}`;

  let count;
  const cfg = redisConfig();
  if (cfg) {
    try {
      count = await redisHit(cfg, key, windowSec);
    } catch (err) {
      console.warn("[rateLimit] store error, using in-memory fallback:", err.message);
    }
  } else if (!warnedNoStore && process.env.NODE_ENV === "production") {
    warnedNoStore = true;
    console.warn(
      "[rateLimit] No UPSTASH_REDIS_REST_URL / KV_REST_API_URL configured — rate limits are per-instance " +
      "and WEAK on serverless. Add a Redis/KV store for real limits."
    );
  }
  if (count === undefined) count = memoryHit(key, windowSec, now);

  return { ok: count <= limit, count, limit, retryAfterSec };
}

/** Client identifier for limiting. Hashed so raw IPs aren't stored in the limiter keys. */
export function clientId(req) {
  // On Vercel these headers are set by the platform and can't be spoofed by the
  // caller. If you self-host behind your own proxy, make sure it overwrites them.
  const fwd = req.headers.get("x-forwarded-for");
  const ip = req.headers.get("x-real-ip") || (fwd ? fwd.split(",")[0].trim() : "") || "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}
