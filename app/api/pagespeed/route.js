import { guardJson } from "../../../lib/apiGuard";
import { validatePublicUrl } from "../../../lib/safeFetch";
import { buildPsiUrl, parsePsi } from "../../../lib/pagespeed";

export const runtime = "nodejs";
export const maxDuration = 60;

// Core Web Vitals for ONE public page, from Google's PageSpeed Insights API (free). Optional env: PAGESPEED_API_KEY (a Google API
// key with the PageSpeed Insights API enabled) raises the quota; without it Google applies a small shared limit.
// Returns { result: { url, strategy, score, field, lab, opportunities, fetchedAt } }.
export async function POST(req) {
  const guard = await guardJson(req, "pagespeed");
  if (!guard.ok) return guard.response;
  let url;
  try { url = new URL(String(guard.body?.url || "")); } catch { return Response.json({ error: "That doesn't look like a valid URL." }, { status: 400 }); }
  if (!/^https?:$/.test(url.protocol)) return Response.json({ error: "Only http and https pages can be tested." }, { status: 400 });
  const allowed = await validatePublicUrl(url);
  if (!allowed.ok) return Response.json({ error: allowed.message }, { status: 400 });
  const strategy = guard.body?.strategy === "desktop" ? "desktop" : "mobile";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 52000);
  try {
    const res = await fetch(buildPsiUrl(url.toString(), strategy, process.env.PAGESPEED_API_KEY || ""), { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (res.status === 429) return Response.json({ error: "Google's free PageSpeed quota is used up for now. Try again later, or add a PAGESPEED_API_KEY to raise it." }, { status: 429 });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = String(json?.error?.message || "").slice(0, 200);
      return Response.json({ error: /FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST/i.test(msg) ? "Google couldn't load that page to test it. Check that it is public and loads in a browser." : `PageSpeed Insights couldn't test that page${msg ? `: ${msg}` : "."}` }, { status: 502 });
    }
    const result = parsePsi(json, { url: url.toString(), strategy });
    if (!result) return Response.json({ error: "PageSpeed Insights returned no performance data for that page." }, { status: 502 });
    return Response.json({ result });
  } catch (err) {
    return Response.json({ error: err?.name === "AbortError" ? "The test took too long. Try again." : "Couldn't reach PageSpeed Insights. Try again." }, { status: 502 });
  } finally { clearTimeout(timer); }
}
