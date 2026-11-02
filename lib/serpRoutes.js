// Shared request handling for the rank-history routes: reading the website host and keyword fields from a validated body, and
// mapping store/search errors to JSON. Server-only.

import { hostOf } from "./serpMatch.js";
import { validateSerpRequest, SerpError } from "./serpProvider.js";
import { StoreError, isSiteHost } from "./serpStore.js";
import { errorResponse as serpErrorResponse } from "./serpApi.js";

const STATUS = { NOT_CONFIGURED: 503, BAD_CONFIG: 503, BAD_REQUEST: 400, LIMIT: 400, AUTH_FAILED: 502, NO_TABLES: 503, UNREACHABLE: 502, DB: 502 };

export function errorResponse(err) {
  if (err instanceof StoreError) return Response.json({ error: err.message, code: err.code }, { status: STATUS[err.code] || 502 });
  if (err instanceof SerpError) return serpErrorResponse(err);
  console.error("[serp-history] unexpected error:", err?.name, err?.message); // message only
  return Response.json({ error: "Something went wrong with rank history. Try again." }, { status: 500 });
}

/** The website host from a body field (a URL or a bare domain), validated. Throws StoreError(BAD_REQUEST). */
export function siteHostFrom(body) {
  const h = hostOf(typeof body?.siteHost === "string" ? body.siteHost : "");
  if (!isSiteHost(h)) throw new StoreError("BAD_REQUEST", "Choose a website first.", 400);
  return h;
}

/** { query, country, device } with the same validation as a live search (query is stored lowercase so lookups match). */
export function keywordFrom(body) {
  const v = validateSerpRequest(body);
  return { ...v, query: v.query.toLowerCase() };
}
