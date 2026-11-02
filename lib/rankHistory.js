// Pure logic for rank history (no I/O, no React): where a site ranked in one snapshot, how a keyword's history reads, which
// tracked keywords are due for a scheduled check, and how much of the monthly search budget is left. Client-safe.
// Unit-tested in tests/rankHistory.test.mjs.
//
// A "position" is where the site appeared in the first page of results one provider returned for one query, country, device
// and moment. null means "not in the results returned" (not "unranked"). It is observed, but it is a snapshot — not a live
// rank for everyone — and it will not match Search Console's averaged position.

import { findSiteRank } from "./serpMatch.js";

const DAY = 86400000;

/** The site's best position (and ranking URL) in a list of normalized results, or { position: null }. */
export function positionOf(results, site) {
  const r = findSiteRank(results, site);
  return r ? { position: r.rank, rankingUrl: r.result.url } : { position: null, rankingUrl: null };
}

/**
 * snapshots: [{ checkedAt, position }] in any order.
 * change > 0 means it moved UP (smaller number); null when either of the last two checks has no position.
 */
export function summarize(snapshots) {
  const list = (Array.isArray(snapshots) ? snapshots : [])
    .filter((s) => s && Number.isFinite(Date.parse(s.checkedAt)))
    .map((s) => ({ checkedAt: new Date(s.checkedAt).toISOString(), position: Number.isInteger(s.position) && s.position > 0 ? s.position : null, trigger: s.trigger || null }))
    .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
  if (list.length === 0) return { checks: 0, latest: null, previous: null, change: null, best: null, series: [] };
  const latest = list[list.length - 1];
  const previous = list.length > 1 ? list[list.length - 2] : null;
  const ranked = list.filter((s) => s.position !== null).map((s) => s.position);
  return {
    checks: list.length, latest, previous,
    change: previous && latest.position !== null && previous.position !== null ? previous.position - latest.position : null,
    best: ranked.length ? Math.min(...ranked) : null,
    series: list.map((s) => ({ date: s.checkedAt, position: s.position })),
  };
}

/**
 * Active keywords that are due: never checked, or last checked at least `intervalDays` ago (minus a 2-hour tolerance, because a
 * daily cron fires "sometime in the hour" and must not skip a keyword by a few minutes). Never-checked first, then oldest.
 */
export function selectDue(keywords, { nowMs = Date.now(), intervalDays = 7, limit = 5 } = {}) {
  const need = Math.max(0, intervalDays * DAY - 2 * 3600000);
  return (Array.isArray(keywords) ? keywords : [])
    .filter((k) => k && k.active !== false)
    .filter((k) => !k.lastCheckedAt || !Number.isFinite(Date.parse(k.lastCheckedAt)) || nowMs - Date.parse(k.lastCheckedAt) >= need)
    .sort((a, b) => (Date.parse(a.lastCheckedAt) || 0) - (Date.parse(b.lastCheckedAt) || 0))
    .slice(0, Math.max(0, limit));
}

/** How many searches a run may spend: the per-run cap, bounded by what is left of the monthly budget after the manual reserve. */
export function allowanceFor({ monthlyBudget, usedThisMonth, perRunMax, reserve = 0 }) {
  return Math.max(0, Math.min(perRunMax, monthlyBudget - usedThisMonth - reserve));
}

/** First instant of the current UTC month, as ISO. */
export const monthStartIso = (nowMs = Date.now()) => { const d = new Date(nowMs); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };
/** The UTC calendar day, YYYY-MM-DD. */
export const utcDay = (nowMs = Date.now()) => new Date(nowMs).toISOString().slice(0, 10);
