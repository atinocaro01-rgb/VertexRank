// Access control for a personal, single-owner deployment: one shared password, HTTP Basic Auth.
//
// Why this exists: the API routes spend your LLM credits, and (soon) will be able to open pull requests on
// your repositories. A public URL must not allow that. Browsers show their own login prompt for Basic Auth
// and then send the credentials with every request, including the app's own fetch() calls, so no login UI
// is needed.
//
// Behaviour:
//   VR_ACCESS_PASSWORD set        -> every request must carry it (any username, or VR_ACCESS_USER if set)
//   unset, production             -> locked (503) rather than silently open: a forgotten variable must not
//                                    publish your tools
//   unset, development            -> open, so `npm run dev` needs no setup
//   VR_ACCESS_DISABLED=1          -> explicit opt-out, for deployments already protected another way
//                                    (VPN, Vercel password protection, localhost only)
//
// Only Web APIs (atob, TextEncoder/TextDecoder) are used so this runs unchanged in the Edge middleware and
// in Node route handlers.

/** Constant-time string comparison (does not leak how many leading characters matched). */
export function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a ?? ""));
  const y = enc.encode(String(b ?? ""));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Parses an `Authorization: Basic ...` header into { user, pass }, or null if absent/malformed. */
export function parseBasicAuth(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(String(header || ""));
  if (!m) return null;
  try {
    const bin = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
    const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const i = text.indexOf(":");
    if (i === -1) return null;
    return { user: text.slice(0, i), pass: text.slice(i + 1) };
  } catch {
    return null;
  }
}

/** Reads the access settings from an environment-like object. */
export function accessConfig(env = {}) {
  return {
    password: String(env.VR_ACCESS_PASSWORD || ""),
    user: String(env.VR_ACCESS_USER || ""),
    disabled: env.VR_ACCESS_DISABLED === "1" || env.VR_ACCESS_DISABLED === "true",
    production: env.NODE_ENV === "production",
  };
}

/**
 * Decides whether a request may proceed.
 * Returns { allowed: true } or { allowed: false, reason: "not_configured" | "missing" | "invalid" }.
 */
export function checkAccess(authHeader, config) {
  const { password, user, disabled, production } = config;
  if (disabled) return { allowed: true };
  if (!password) return production ? { allowed: false, reason: "not_configured" } : { allowed: true };
  const creds = parseBasicAuth(authHeader);
  if (!creds) return { allowed: false, reason: authHeader ? "invalid" : "missing" };
  // Evaluate both checks so timing doesn't reveal which one failed.
  const passOk = timingSafeEqual(creds.pass, password);
  const userOk = user ? timingSafeEqual(creds.user, user) : true;
  return passOk && userOk ? { allowed: true } : { allowed: false, reason: "invalid" };
}

export const LOCKED_MESSAGE =
  "VertexRank is locked. Set the VR_ACCESS_PASSWORD environment variable (a long, random password) and redeploy. " +
  "To run without a password (for example behind a VPN), set VR_ACCESS_DISABLED=1.";
