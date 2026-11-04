// Checking tracked keywords: the shared loop used by the manual "Check rankings" button and by the daily scheduled run.
// Server-only; the store and the search provider are injected (tests/serpJob.test.mjs).
//
// Cost control, in order: a per-run cap (SERP_CRON_MAX_PER_RUN), a monthly budget (SERP_MONTHLY_BUDGET, shared by manual and
// scheduled checks) with a reserve kept for manual use (SERP_MANUAL_RESERVE), and a minimum gap between checks of one keyword
// (SERP_CHECK_INTERVAL_DAYS). A keyword that failed is not marked as checked, so it is simply due again next run.

import { positionOf, selectDue, allowanceFor, monthStartIso, utcDay } from "./rankHistory.js";
import { topPayload } from "./keywordIntel.js";
import { SerpError, countSerpKeys } from "./serpProvider.js";

const FATAL = new Set(["NOT_CONFIGURED", "AUTH_FAILED", "QUOTA", "RATE_LIMIT", "BAD_CONFIG"]); // retrying the next keyword would fail the same way
const int = (v, d, min, max) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

export function jobConfig(env = process.env) {
  // Each SerpApi key has its own monthly allowance, so the defaults scale with the number of keys (200 budget / 50 manual reserve per
  // key). Setting SERP_MONTHLY_BUDGET or SERP_MANUAL_RESERVE explicitly always wins.
  const keys = Math.max(1, countSerpKeys(env));
  return {
    perRunMax: int(env.SERP_CRON_MAX_PER_RUN, 5, 0, 20),
    intervalDays: int(env.SERP_CHECK_INTERVAL_DAYS, 7, 1, 60),
    monthlyBudget: int(env.SERP_MONTHLY_BUDGET, 200 * keys, 0, 50000),
    reserve: int(env.SERP_MANUAL_RESERVE, 50 * keys, 0, 50000),
  };
}

/** One search per keyword, one snapshot per successful search. Stops early on errors that would repeat for every keyword. */
export async function checkKeywords({ store, serp, keywords, trigger, now = () => Date.now(), deadlineMs = 45000 }) {
  const started = now();
  const checked = [], errors = [];
  for (const k of keywords) {
    if (now() - started > deadlineMs) { errors.push({ query: k.query, message: "Stopped to stay within the time limit; it will be checked next time." }); break; }
    try {
      const r = await serp.search({ query: k.query, country: k.country, device: k.device });
      const { position, rankingUrl } = positionOf(r.results, k.siteHost);
      await store.insertSnapshot({ keywordId: k.id, checkedAt: r.observedAt, position, rankingUrl, provider: r.source, trigger, topResults: topPayload(r.results, r.related) });
      checked.push({ id: k.id, query: k.query, position, checkedAt: r.observedAt });
    } catch (err) {
      const message = err instanceof SerpError ? err.message : "Couldn't check this keyword.";
      errors.push({ query: k.query, message, code: err instanceof SerpError ? err.code : undefined });
      if (err instanceof SerpError && FATAL.has(err.code)) break;
      if (!(err instanceof SerpError) && err?.name === "StoreError") break; // the database is the problem, not the keyword
    }
  }
  return { checked, errors };
}

/** Searches spent this month by tracked-keyword checks (manual + scheduled). Approximate: the provider bills by its own month. */
export async function usedThisMonth(store, nowMs) { return store.countSnapshotsSince(monthStartIso(nowMs)); }

/**
 * The daily scheduled run. Always touches the database (which also keeps a free Supabase project from pausing), claims the day so a
 * duplicated cron delivery can't spend twice, and records what happened in job_runs.
 */
export async function runScheduledChecks({ store, serp, env = process.env, now = () => Date.now() }) {
  const cfg = jobConfig(env);
  const nowMs = now();
  const runId = await store.claimRun("serp", utcDay(nowMs));
  if (runId === null) return { status: "skipped", note: "Already ran today.", checked: 0, errors: [] };
  let checked = [], errors = [], status = "idle", note = "";
  try {
    const keywords = await store.listActiveKeywords();
    const due = selectDue(keywords, { nowMs, intervalDays: cfg.intervalDays, limit: 1000 });
    const used = await usedThisMonth(store, nowMs);
    const allowance = allowanceFor({ monthlyBudget: cfg.monthlyBudget, usedThisMonth: used, perRunMax: cfg.perRunMax, reserve: cfg.reserve });
    if (due.length === 0) { status = "idle"; note = `Nothing due (${keywords.length} active keyword${keywords.length === 1 ? "" : "s"}).`; }
    else if (!serp.configured()) { status = "no_provider"; note = `${due.length} keyword${due.length === 1 ? " is" : "s are"} due, but SERPAPI_KEY isn't set.`; }
    else if (allowance === 0) { status = "budget_exhausted"; note = `${due.length} due, but this month's budget is used (${used} of ${cfg.monthlyBudget}, ${cfg.reserve} kept for manual checks).`; }
    else {
      const r = await checkKeywords({ store, serp, keywords: due.slice(0, allowance), trigger: "scheduled", now });
      checked = r.checked; errors = r.errors;
      status = errors.length === 0 ? "ok" : checked.length > 0 ? "partial" : "failed";
      note = `Checked ${checked.length} of ${due.length} due keyword${due.length === 1 ? "" : "s"}${due.length > allowance ? ` (limited to ${allowance} this run)` : ""}.`;
    }
    await store.finishRun(runId, { status, checked: checked.length, errors, note });
    return { status, note, checked: checked.length, errors };
  } catch (err) {
    // Nothing was spent if we never got to a search: free the claim so a later delivery today can still run.
    if (checked.length === 0) { try { await store.releaseRun(runId); } catch { /* best effort */ } }
    throw err;
  }
}
