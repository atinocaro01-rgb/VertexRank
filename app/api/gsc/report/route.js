import { guardJson } from "../../../../lib/apiGuard";
import { buildReport, ALLOWED_DAYS } from "../../../../lib/gscReport";
import { isValidProperty } from "../../../../lib/gscClient";
import { gscFromEnv, errorResponse, createCache } from "../../../../lib/gscApi";

export const runtime = "nodejs";
export const maxDuration = 60;

const cache = createCache({ ttlMs: 10 * 60 * 1000 });

// Search performance for one property and period: totals vs the previous period, daily series, top queries and pages,
// query+page pairs and device/country splits. The property must be one the service account can see (checked in the client).
export async function POST(req) {
  const guard = await guardJson(req, "gsc");
  if (!guard.ok) return guard.response;
  const { siteUrl, days, refresh } = guard.body;
  if (!isValidProperty(siteUrl)) return Response.json({ error: "Choose a Search Console property first." }, { status: 400 });
  const n = ALLOWED_DAYS.includes(Number(days)) ? Number(days) : 28;
  try {
    const { client } = gscFromEnv();
    const key = `${siteUrl}|${n}`;
    if (refresh === true) cache.delete(key); // the person asked for fresh numbers
    const { value, cached } = await cache(key, () => buildReport({ client, siteUrl, days: n }));
    return Response.json({ report: value, cached });
  } catch (err) {
    return errorResponse(err);
  }
}
