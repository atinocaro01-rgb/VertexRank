import test from "node:test";
import assert from "node:assert/strict";
import { positionOf, summarize, selectDue, allowanceFor, monthStartIso, utcDay } from "../lib/rankHistory.js";
import { isCronRequest } from "../lib/cronAuth.js";

const DAY = 86400000;
const NOW = Date.parse("2026-11-10T05:30:00Z");

test("positionOf finds the best position and URL, or reports not-in-results", () => {
  const results = [{ rank: 1, url: "https://a.com/" }, { rank: 5, url: "https://www.mysite.com/x" }, { rank: 8, url: "https://mysite.com/y" }];
  assert.deepEqual(positionOf(results, "mysite.com"), { position: 5, rankingUrl: "https://www.mysite.com/x" });
  assert.deepEqual(positionOf(results, "nope.com"), { position: null, rankingUrl: null });
  assert.deepEqual(positionOf(null, "mysite.com"), { position: null, rankingUrl: null });
});

test("summarize: latest, previous, change (positive = moved up), best, ordered series; bad rows ignored", () => {
  const s = summarize([{ checkedAt: "2026-11-08T00:00:00Z", position: 4 }, { checkedAt: "2026-11-01T00:00:00Z", position: 9 }, { checkedAt: "bad", position: 1 }, null, { checkedAt: "2026-11-05T00:00:00Z", position: null }]);
  assert.equal(s.checks, 3); assert.equal(s.latest.position, 4); assert.equal(s.previous.position, null); assert.equal(s.change, null); assert.equal(s.best, 4);
  assert.deepEqual(s.series.map((p) => p.position), [9, null, 4]);
  const up = summarize([{ checkedAt: "2026-11-01T00:00:00Z", position: 9 }, { checkedAt: "2026-11-08T00:00:00Z", position: 4 }]); assert.equal(up.change, 5);
  const down = summarize([{ checkedAt: "2026-11-01T00:00:00Z", position: 3 }, { checkedAt: "2026-11-08T00:00:00Z", position: 6 }]); assert.equal(down.change, -3);
  assert.deepEqual(summarize([]), { checks: 0, latest: null, previous: null, change: null, best: null, series: [] }); assert.equal(summarize(null).checks, 0);
  assert.equal(summarize([{ checkedAt: "2026-11-01T00:00:00Z", position: 0 }]).latest.position, null);
});

test("selectDue: never-checked first, then oldest; respects the interval (with a 2h tolerance for cron timing); skips paused; honours the limit", () => {
  const k = (id, daysAgo, o = {}) => ({ id, active: true, lastCheckedAt: daysAgo === null ? null : new Date(NOW - daysAgo * DAY).toISOString(), ...o });
  const due = selectDue([k("a", 8), k("b", null), k("c", 3), k("d", 20), k("e", 9, { active: false }), k("f", 7)], { nowMs: NOW, intervalDays: 7, limit: 10 });
  assert.deepEqual(due.map((x) => x.id), ["b", "d", "a", "f"]);
  assert.deepEqual(selectDue([k("a", 8), k("b", null), k("d", 20)], { nowMs: NOW, intervalDays: 7, limit: 2 }).map((x) => x.id), ["b", "d"]);
  assert.equal(selectDue([k("x", 7 - 1 / 24)], { nowMs: NOW, intervalDays: 7 }).length, 1, "within the 2h tolerance counts as due");
  assert.equal(selectDue([k("x", 6.5)], { nowMs: NOW, intervalDays: 7 }).length, 0);
  assert.deepEqual(selectDue(null), []); assert.deepEqual(selectDue([k("a", 1)], { nowMs: NOW, intervalDays: 0 }).map((x) => x.id), ["a"]);
});

test("allowanceFor and dates", () => {
  assert.equal(allowanceFor({ monthlyBudget: 200, usedThisMonth: 10, perRunMax: 5, reserve: 50 }), 5);
  assert.equal(allowanceFor({ monthlyBudget: 200, usedThisMonth: 148, perRunMax: 5, reserve: 50 }), 2);
  assert.equal(allowanceFor({ monthlyBudget: 200, usedThisMonth: 150, perRunMax: 5, reserve: 50 }), 0);
  assert.equal(allowanceFor({ monthlyBudget: 200, usedThisMonth: 999, perRunMax: 5, reserve: 0 }), 0);
  assert.equal(monthStartIso(NOW), "2026-11-01T00:00:00.000Z"); assert.equal(utcDay(NOW), "2026-11-10");
});

test("cron auth: needs a long secret and an exact Bearer match; anything else is refused", () => {
  const env = { CRON_SECRET: "a-long-random-secret-1234" };
  assert.equal(isCronRequest("Bearer a-long-random-secret-1234", env), true);
  for (const h of [null, "", "Bearer wrong", "bearer a-long-random-secret-1234", "Basic YTpi", "Bearer a-long-random-secret-1234x", "a-long-random-secret-1234"]) assert.equal(isCronRequest(h, env), false, String(h));
  assert.equal(isCronRequest("Bearer short", { CRON_SECRET: "short" }), false, "a short secret is never accepted");
  assert.equal(isCronRequest("Bearer ", {}), false); assert.equal(isCronRequest("Bearer undefined", {}), false);
});
