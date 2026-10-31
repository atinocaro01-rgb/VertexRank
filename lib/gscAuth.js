// Sign-in to Google as a SERVICE ACCOUNT, for read-only Search Console access. No OAuth consent screen, no redirect
// routes, no per-user refresh tokens to store: the owner adds the service account's email as a (Restricted) user on each
// Search Console property once, and this module exchanges a short-lived signed JWT for a short-lived access token.
//
// Security notes:
//   - The key lives only in the GOOGLE_SERVICE_ACCOUNT_JSON environment variable (raw JSON or base64 of it). It is never
//     returned, logged, or included in an error message; only the service account's e-mail (not a secret) is surfaced,
//     so the owner knows which address to add in Search Console.
//   - Google's token endpoint and the scope are constants here. The key file's own "token_uri" field is deliberately
//     ignored, so a doctored key file can't point this server at another host.
//   - Scope is read-only (webmasters.readonly): this code can never change anything in Search Console.
//
// Node-only (uses node:crypto). `fetch` and the clock are injectable for tests (tests/gscAuth.test.mjs).

import { createSign } from "node:crypto";

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export class GscError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "GscError";
    this.code = code;
    this.status = status;
  }
}

const b64url = (input) => Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/**
 * Reads the service account from the environment value. Returns null when nothing is configured; throws a GscError
 * (without echoing the value) when something is configured but unusable.
 */
export function parseServiceAccount(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  let json;
  try {
    json = JSON.parse(text.startsWith("{") ? text : Buffer.from(text, "base64").toString("utf8"));
  } catch {
    throw new GscError("BAD_CONFIG", "GOOGLE_SERVICE_ACCOUNT_JSON isn't valid. Paste the whole contents of the service account's JSON key file (or its base64 encoding).");
  }
  const email = typeof json?.client_email === "string" ? json.client_email.trim() : "";
  let key = typeof json?.private_key === "string" ? json.private_key : "";
  if (key && !key.includes("\n") && key.includes("\\n")) key = key.replace(/\\n/g, "\n"); // some env managers double-escape newlines
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) {
    throw new GscError("BAD_CONFIG", "GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key. Use the JSON key file downloaded from the service account's Keys tab.");
  }
  return { clientEmail: email, privateKey: key };
}

/** Builds the signed JWT (RS256) Google exchanges for an access token. */
export function signJwt({ clientEmail, privateKey }, nowSec) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: clientEmail, scope: GSC_SCOPE, aud: TOKEN_ENDPOINT, iat: nowSec, exp: nowSec + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  let signature;
  try {
    signature = signer.sign(privateKey, "base64");
  } catch {
    throw new GscError("BAD_CONFIG", "The service account's private key couldn't be used to sign. Re-download the JSON key file and paste it again.");
  }
  return `${header}.${claims}.${signature.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
}

/**
 * Creates an auth helper. `env` is process.env (or a stand-in). The access token is cached in memory until a minute
 * before it expires, and concurrent callers share one in-flight exchange.
 */
export function createGscAuth({ env = process.env, fetchImpl, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let account;
  let cached = null; // { token, expiresAt }
  let inflight = null;

  function load() {
    if (account === undefined) account = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return account;
  }

  async function exchange() {
    const sa = load();
    const assertion = signJwt(sa, Math.floor(now() / 1000));
    let res;
    try {
      res = await doFetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new GscError("NETWORK", "Couldn't reach Google to sign in. Check your connection and try again.");
    }
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    if (!res.ok || !body?.access_token) {
      const reason = body?.error;
      if (reason === "invalid_grant") throw new GscError("BAD_KEY", "Google rejected the service account key (it may be disabled, deleted, or the server's clock is far off). Create a new key and update GOOGLE_SERVICE_ACCOUNT_JSON.", res.status);
      throw new GscError("AUTH_FAILED", `Google sign-in failed${reason ? ` (${String(reason).slice(0, 60)})` : ""}.`, res.status);
    }
    const ttl = Math.max(60, Number(body.expires_in) || 3600);
    cached = { token: body.access_token, expiresAt: now() + (ttl - 60) * 1000 };
    return cached.token;
  }

  return {
    /** True when a service account is configured (throws GscError BAD_CONFIG if it is configured but invalid). */
    configured() { return !!load(); },
    /** The address to add under Settings → Users and permissions in Search Console (not a secret), or null. */
    serviceAccountEmail() { return load()?.clientEmail ?? null; },
    async getAccessToken() {
      if (!load()) throw new GscError("NOT_CONFIGURED", "Search Console isn't set up yet. Add the GOOGLE_SERVICE_ACCOUNT_JSON environment variable (see the README).");
      if (cached && cached.expiresAt > now()) return cached.token;
      if (!inflight) inflight = exchange().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
