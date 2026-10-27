// One guard for every public API route: bounded body size, JSON parsing, per-client
// rate limits, and optional global daily usage caps (a kill-switch on total spend).
//
//   const g = await guardJson(req, "aiHeavy");
//   if (!g.ok) return g.response;
//   const body = g.body;
//
// Policies (edit here — this is the single place limits live):
//   crawl       outbound site crawls (each is up to ~45s and 60 fetches to someone's server)
//   ai          calls that spend LLM credits (shared counter across light + heavy routes)
//   signals     the "signalsOnly" fast path: pure computation, no LLM call, so it is cheap
//
// Environment (all optional):
//   VR_RATE_LIMIT_MULTIPLIER   scale every per-client limit (e.g. 2 = twice as generous)
//   VR_GLOBAL_DAILY_CRAWLS     total crawls/day across ALL users; over it -> 503
//   VR_GLOBAL_DAILY_AI_CALLS   total LLM-spending calls/day across ALL users; over it -> 503
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL / KV_REST_API_TOKEN)
//                              shared store — required for limits to hold on Vercel

import { clientId, hit } from "./rateLimit.js";
import { accessConfig, checkAccess, LOCKED_MESSAGE } from "./accessControl.js";

const KB = 1024;
const MB = 1024 * KB;
const MULT = Math.max(0.1, Number(process.env.VR_RATE_LIMIT_MULTIPLIER) || 1);
const scale = (n) => Math.max(1, Math.round(n * MULT));

export const POLICIES = {
  crawl: {
    counter: "crawl", maxBodyBytes: 4 * KB, globalDailyEnv: "VR_GLOBAL_DAILY_CRAWLS",
    windows: [{ limit: 10, windowSec: 600 }, { limit: 60, windowSec: 86400 }],
  },
  // Crawls a competitor (shares the crawl budget) but also receives our own crawl in the body.
  competitor: {
    counter: "crawl", maxBodyBytes: 4 * MB, globalDailyEnv: "VR_GLOBAL_DAILY_CRAWLS",
    windows: [{ limit: 10, windowSec: 600 }, { limit: 60, windowSec: 86400 }],
  },
  aiLight: {
    counter: "ai", maxBodyBytes: 256 * KB, globalDailyEnv: "VR_GLOBAL_DAILY_AI_CALLS",
    windows: [{ limit: 40, windowSec: 600 }, { limit: 300, windowSec: 86400 }],
  },
  aiHeavy: {
    counter: "ai", maxBodyBytes: 4 * MB, globalDailyEnv: "VR_GLOBAL_DAILY_AI_CALLS",
    windows: [{ limit: 40, windowSec: 600 }, { limit: 300, windowSec: 86400 }],
  },
  // GitHub operations (inspect / preview / create a pull request / PR status). Previews read many files, so keep these modest.
  github: {
    counter: "github", maxBodyBytes: 512 * KB,
    windows: [{ limit: 40, windowSec: 600 }, { limit: 400, windowSec: 86400 }],
  },
  signals: {
    counter: "signals", maxBodyBytes: 4 * MB,
    windows: [{ limit: 120, windowSec: 600 }],
  },
};

const BURST = { limit: 90, windowSec: 60 }; // every route, every request, before the body is even read

function deny(status, error, retryAfterSec) {
  const headers = retryAfterSec ? { "Retry-After": String(retryAfterSec) } : undefined;
  return { ok: false, response: Response.json({ error }, { status, headers }) };
}

function waitText(sec) {
  if (sec < 90) return "a minute";
  if (sec < 5400) return `${Math.ceil(sec / 60)} minutes`;
  return `${Math.ceil(sec / 3600)} hours`;
}

async function readCapped(req, maxBytes) {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true };
  if (!req.body) return { text: "" };
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode() };
}

/**
 * Applies burst limit -> body cap -> policy limits -> global cap, in that order, and
 * returns { ok: true, body } or { ok: false, response }.
 *
 * opts.signalsPolicy: if the body has `signalsOnly: true` (the route then skips the LLM
 * entirely), charge the cheap "signals" budget instead of the LLM budget.
 */
export async function guardJson(req, policyName, opts = {}) {
  const base = POLICIES[policyName];
  if (!base) throw new Error(`Unknown API policy: ${policyName}`);
  const id = clientId(req);

  // Stage 0 — access. The middleware already enforces this for every request; checking again here means these
  // routes stay protected even if the middleware is removed or its matcher changes.
  const auth = req.headers.get("authorization");
  const access = checkAccess(auth, accessConfig(process.env));
  if (!access.allowed) {
    if (access.reason === "not_configured") return deny(503, LOCKED_MESSAGE);
    if (auth) { // a wrong password was actually presented: throttle guessing
      const fails = await hit({ name: "authfail", id, limit: 10, windowSec: 600 });
      if (!fails.ok) return deny(429, "Too many failed sign-in attempts. Try again later.", fails.retryAfterSec);
    }
    return { ok: false, response: Response.json({ error: "Authentication required." }, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="VertexRank"' } }) };
  }

  const burst = await hit({ name: "burst", id, limit: scale(BURST.limit), windowSec: BURST.windowSec });
  if (!burst.ok) return deny(429, "Too many requests — slow down for a moment and try again.", burst.retryAfterSec);

  const raw = await readCapped(req, base.maxBodyBytes);
  if (raw.tooLarge) return deny(413, "That request is too large.");
  let body;
  try { body = JSON.parse(raw.text); } catch { return deny(400, "Invalid request."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return deny(400, "Invalid request.");

  const policy = opts.signalsPolicy && body.signalsOnly === true ? POLICIES.signals : base;

  for (const w of policy.windows) {
    const r = await hit({ name: policy.counter, id, limit: scale(w.limit), windowSec: w.windowSec });
    if (!r.ok) {
      return deny(
        429,
        `You've hit the usage limit for this feature. Please try again in about ${waitText(r.retryAfterSec)}.`,
        r.retryAfterSec
      );
    }
  }

  const globalLimit = policy.globalDailyEnv ? Number(process.env[policy.globalDailyEnv]) : 0;
  if (globalLimit > 0) {
    const r = await hit({ name: `${policy.counter}-global`, id: "all", limit: globalLimit, windowSec: 86400 });
    if (!r.ok) {
      return deny(503, "VertexRank has reached its daily capacity for this feature. Please try again later.", r.retryAfterSec);
    }
  }

  return { ok: true, body };
}
