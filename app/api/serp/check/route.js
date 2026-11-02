import { guardJson } from "../../../../lib/apiGuard";
import { serpStoreFromEnv } from "../../../../lib/serpStoreEnv";
import { serpFromEnv } from "../../../../lib/serpApi";
import { errorResponse, siteHostFrom } from "../../../../lib/serpRoutes";
import { checkKeywords, jobConfig, usedThisMonth } from "../../../../lib/serpJob";
import { selectDue } from "../../../../lib/rankHistory";
import { StoreError, isUuid } from "../../../../lib/serpStore";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_PER_REQUEST = 3; // each keyword is one search at the provider

// "Check rankings" now: up to three of the website's tracked keywords (the ones you pick, otherwise the least recently checked),
// each stored as a snapshot. Counts against the same monthly budget as the scheduled run (but not against its manual reserve).
export async function POST(req) {
  const guard = await guardJson(req, "serp");
  if (!guard.ok) return guard.response;
  try {
    const siteHost = siteHostFrom(guard.body);
    const store = serpStoreFromEnv();
    const serp = serpFromEnv();
    if (!serp.configured()) throw new StoreError("NOT_CONFIGURED", "Live search results aren't set up yet. Add SERPAPI_KEY on the server.", 503);
    const all = (await store.listKeywords(siteHost)).filter((k) => k.active);
    const picked = Array.isArray(guard.body.ids) ? guard.body.ids.filter(isUuid) : [];
    const chosen = picked.length ? all.filter((k) => picked.includes(k.id)) : selectDue(all, { intervalDays: 0, limit: MAX_PER_REQUEST });
    if (chosen.length === 0) return Response.json({ checked: [], errors: [], note: "No active keywords to check." });
    const cfg = jobConfig();
    const used = await usedThisMonth(store, Date.now());
    const left = Math.max(0, cfg.monthlyBudget - used);
    if (left === 0) throw new StoreError("LIMIT", `This month's budget of ${cfg.monthlyBudget} tracked-keyword searches is used up. It resets next month, or raise SERP_MONTHLY_BUDGET if your plan allows more.`, 429);
    const r = await checkKeywords({ store, serp, keywords: chosen.slice(0, Math.min(MAX_PER_REQUEST, left)), trigger: "manual" });
    return Response.json(r);
  } catch (err) {
    return errorResponse(err);
  }
}
