import { guardJson } from "../../../lib/apiGuard";
import { safeFetchText, validatePublicUrl } from "../../../lib/safeFetch";
import { extractReadable } from "../../../lib/sourceTools";
import { hostOf } from "../../../lib/serpMatch";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_URLS = 5;

// Reads the text of the pages the person chose as sources (or pasted), so the writer can cite what they actually say. Uses the same
// SSRF-protected fetcher as the site crawler (public http/https only, size and time limits), shares the crawl rate limits, and
// returns only a bounded excerpt of each page. Per-URL failures come back as { ok: false, error } instead of failing the batch.
export async function POST(req) {
  const guard = await guardJson(req, "crawl");
  if (!guard.ok) return guard.response;
  const urls = [...new Set((Array.isArray(guard.body.urls) ? guard.body.urls : []).filter((u) => typeof u === "string").map((u) => u.trim()).filter(Boolean))].slice(0, MAX_URLS);
  if (urls.length === 0) return Response.json({ error: "Add at least one source URL." }, { status: 400 });
  const sources = await Promise.all(urls.map(async (url) => {
    const check = await validatePublicUrl(url);
    if (!check.ok) return { url, ok: false, error: check.message || "That URL can't be used." };
    const r = await safeFetchText(url, { timeoutMs: 8000, maxBytes: 1.5 * 1024 * 1024, accept: ["text/html", "application/xhtml"] });
    if (!r.ok) return { url, ok: false, error: r.error || "Couldn't load that page." };
    const page = extractReadable(r.text);
    if (page.excerpt.length < 300) return { url, ok: false, error: "There wasn't enough readable text on that page to use it as a source." };
    const finalUrl = r.finalUrl || url;
    return { url: finalUrl, ok: true, host: hostOf(finalUrl), title: page.title || hostOf(finalUrl), publishedTime: page.publishedTime, excerpt: page.excerpt };
  }));
  return Response.json({ sources });
}
