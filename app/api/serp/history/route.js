import { guardJson } from "../../../../lib/apiGuard";
import { serpStoreFromEnv } from "../../../../lib/serpStoreEnv";
import { errorResponse, siteHostFrom } from "../../../../lib/serpRoutes";
import { summarize, monthStartIso } from "../../../../lib/rankHistory";
import { jobConfig, usedThisMonth } from "../../../../lib/serpJob";
import { countSerpKeys } from "../../../../lib/serpProvider";
import { StoreError } from "../../../../lib/serpStore";

export const runtime = "nodejs";
export const maxDuration = 30;

const DAYS = [30, 90, 180];

// Tracked keywords for one website with their position history, plus the scheduled-run status and this month's budget.
// When the database isn't set up this answers { configured: false } (not an error) so the screen can explain how to set it up.
export async function POST(req) {
  const guard = await guardJson(req, "serpData");
  if (!guard.ok) return guard.response;
  try {
    const siteHost = siteHostFrom(guard.body);
    const days = DAYS.includes(Number(guard.body.days)) ? Number(guard.body.days) : 90;
    const store = serpStoreFromEnv();
    if (!store.configured()) return Response.json({ configured: false });
    const now = Date.now();
    const keywords = await store.listKeywords(siteHost);
    const snaps = await store.snapshots(keywords.map((k) => k.id), new Date(now - days * 86400000).toISOString());
    const byKeyword = new Map();
    for (const s of snaps) { if (!byKeyword.has(s.keywordId)) byKeyword.set(s.keywordId, []); byKeyword.get(s.keywordId).push(s); }
    const [used, runs] = await Promise.all([usedThisMonth(store, now), store.lastRuns("serp", 1)]);
    const cfg = jobConfig();
    return Response.json({
      configured: true, siteHost, days, monthStart: monthStartIso(now),
      keywords: keywords.map((k) => ({ ...k, ...summarize(byKeyword.get(k.id) || []) })),
      budget: { used, monthly: cfg.monthlyBudget, reserve: cfg.reserve, perRun: cfg.perRunMax, intervalDays: cfg.intervalDays, keys: countSerpKeys() },
      lastRun: runs[0] || null,
    });
  } catch (err) {
    if (err instanceof StoreError && err.code === "NO_TABLES") return Response.json({ configured: true, missingTables: true, error: err.message });
    return errorResponse(err);
  }
}
