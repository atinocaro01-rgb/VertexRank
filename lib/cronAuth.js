// Authenticates Vercel Cron requests. Vercel sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set as an
// environment variable (you create it; use 16+ random characters). Web APIs only, so it runs in the Edge middleware too.

import { timingSafeEqual } from "./accessControl.js";

export const CRON_PATHS = ["/api/cron/serp"];
export const MIN_SECRET_LENGTH = 16;

/** True only when a long-enough secret is configured AND the request carries exactly `Bearer <secret>`. */
export function isCronRequest(authHeader, env = {}) {
  const secret = typeof env.CRON_SECRET === "string" ? env.CRON_SECRET : "";
  if (secret.length < MIN_SECRET_LENGTH) return false;
  const m = /^Bearer (.+)$/.exec(String(authHeader || ""));
  return !!m && timingSafeEqual(m[1], secret);
}
