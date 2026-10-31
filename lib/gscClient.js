// A minimal, READ-ONLY Search Console API client: list the properties the service account can see, and run Search
// Analytics queries. Only Google's fixed API host is ever contacted; the property identifier is validated and must be one
// the service account actually has access to (checked against its own property list), and every date range is validated.
// Node-only; `fetch`, the clock and sleep are injectable (tests/gscClient.test.mjs).

import { GscError } from "./gscAuth.js";

const API = "https://www.googleapis.com/webmasters/v3";
export const MAX_RANGE_DAYS = 480; // Search Console keeps about 16 months
const SITES_TTL_MS = 5 * 60 * 1000;

/** "sc-domain:example.com" (domain property) or "https://example.com/" / "https://example.com/blog/" (URL-prefix property). */
export function isValidProperty(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > 300) return false;
  return /^sc-domain:[A-Za-z0-9.-]+$/.test(s) || /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[^\s?#]*)?$/.test(s);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const toUtcMs = (d) => Date.parse(`${d}T00:00:00Z`);

/** Validates a YYYY-MM-DD range: real dates, start <= end, not in the future, within Search Console's retention. */
export function validateRange(startDate, endDate, nowMs = Date.now()) {
  if (!ISO.test(startDate || "") || !ISO.test(endDate || "") || Number.isNaN(toUtcMs(startDate)) || Number.isNaN(toUtcMs(endDate))) throw new GscError("BAD_REQUEST", "Dates must be real calendar dates (YYYY-MM-DD).");
  if (new Date(toUtcMs(startDate)).toISOString().slice(0, 10) !== startDate || new Date(toUtcMs(endDate)).toISOString().slice(0, 10) !== endDate) throw new GscError("BAD_REQUEST", "Dates must be real calendar dates.");
  if (toUtcMs(startDate) > toUtcMs(endDate)) throw new GscError("BAD_REQUEST", "The start date is after the end date.");
  if (toUtcMs(endDate) > nowMs) throw new GscError("BAD_REQUEST", "The end date is in the future.");
  if ((nowMs - toUtcMs(startDate)) / 86400000 > MAX_RANGE_DAYS) throw new GscError("BAD_REQUEST", "Search Console only keeps about 16 months of data; choose a more recent start date.");
}

const DIMENSIONS = new Set(["date", "query", "page", "country", "device"]);

export function createGscClient({ auth, fetchImpl, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let sitesCache = null; // { at, sites }

  async function call(method, path, body, attempt = 0) {
    const token = await auth.getAccessToken();
    let res;
    try {
      res = await doFetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      throw new GscError("NETWORK", "Couldn't reach Google Search Console. Try again in a moment.");
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 1) { await sleep(800); return call(method, path, body, attempt + 1); }
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch { /* no body */ }
    const email = auth.serviceAccountEmail?.();
    if (res.status === 401) throw new GscError("AUTH_FAILED", "Google rejected the sign-in. Check the service account key (GOOGLE_SERVICE_ACCOUNT_JSON).", 401);
    if (res.status === 403) throw new GscError("FORBIDDEN", `The service account${email ? ` (${email})` : ""} doesn't have access to this property. In Search Console open the property, go to Settings → Users and permissions → Add user, and add that address with Restricted (read-only) permission.`, 403);
    if (res.status === 404) throw new GscError("NOT_FOUND", "Search Console doesn't know this property. Check it's spelled exactly as in Search Console.", 404);
    if (res.status === 429) throw new GscError("RATE_LIMIT", "Google's Search Console quota was hit. Wait a few minutes and try again.", 429);
    if (res.status === 400) throw new GscError("BAD_REQUEST", `Google rejected the request${detail ? `: ${detail.slice(0, 160)}` : ""}.`, 400);
    throw new GscError("UPSTREAM", `Search Console returned an error (${res.status}). Try again later.`, res.status);
  }

  async function listSites({ fresh = false } = {}) {
    if (!fresh && sitesCache && now() - sitesCache.at < SITES_TTL_MS) return sitesCache.sites;
    const data = await call("GET", "/sites");
    const sites = (data.siteEntry || [])
      .filter((s) => s && typeof s.siteUrl === "string" && s.permissionLevel !== "siteUnverifiedUser")
      .map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel || "unknown" }));
    sitesCache = { at: now(), sites };
    return sites;
  }

  async function assertAccessible(siteUrl) {
    if (!isValidProperty(siteUrl)) throw new GscError("BAD_REQUEST", "That isn't a valid Search Console property.");
    const sites = await listSites();
    if (!sites.some((s) => s.siteUrl === siteUrl)) {
      const email = auth.serviceAccountEmail?.();
      throw new GscError("FORBIDDEN", `The service account${email ? ` (${email})` : ""} doesn't have access to ${siteUrl}. Add it under Settings → Users and permissions in Search Console.`, 403);
    }
  }

  /** One Search Analytics request. Returns normalised rows [{ keys, clicks, impressions, ctr, position }]. */
  async function query(siteUrl, { startDate, endDate, dimensions = [], rowLimit = 1000, startRow = 0 }) {
    await assertAccessible(siteUrl);
    validateRange(startDate, endDate, now());
    if (!Array.isArray(dimensions) || dimensions.length > 3 || !dimensions.every((d) => DIMENSIONS.has(d))) throw new GscError("BAD_REQUEST", "Unsupported dimensions.");
    const limit = Math.min(Math.max(1, Math.floor(rowLimit)), 25000);
    const data = await call("POST", `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      startDate, endDate, dimensions, rowLimit: limit, startRow: Math.max(0, Math.floor(startRow)), type: "web",
    });
    return (data.rows || []).map((r) => ({
      keys: Array.isArray(r.keys) ? r.keys.map(String) : [],
      clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0, ctr: Number(r.ctr) || 0, position: Number(r.position) || 0,
    }));
  }

  /** Pages through results until `maxRows` rows or the data runs out. */
  async function queryAll(siteUrl, params, { maxRows = 5000, pageSize = 1000 } = {}) {
    const out = [];
    while (out.length < maxRows) {
      const rows = await query(siteUrl, { ...params, rowLimit: Math.min(pageSize, maxRows - out.length), startRow: out.length });
      out.push(...rows);
      if (rows.length < Math.min(pageSize, maxRows - out.length + rows.length)) break;
    }
    return out;
  }

  return { listSites, query, queryAll, assertAccessible };
}
