import test from "node:test";
import assert from "node:assert/strict";
import { rate, buildPsiUrl, parsePsi, weakVitals, vitalsRec, fmtMetric, upsertPageSpeed } from "../lib/pagespeed.js";

const raw = (over = {}) => ({
  id: "https://s.com/",
  loadingExperience: { overall_category: "SLOW", metrics: {
    LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4800, category: "SLOW" }, INTERACTION_TO_NEXT_PAINT: { percentile: 150, category: "FAST" }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12, category: "AVERAGE" },
  } },
  lighthouseResult: { finalUrl: "https://s.com/", categories: { performance: { score: 0.42 } }, audits: {
    "largest-contentful-paint": { numericValue: 5200 }, "cumulative-layout-shift": { numericValue: 0.3 }, "total-blocking-time": { numericValue: 450 }, "first-contentful-paint": { numericValue: 2100 },
    "uses-optimized-images": { title: "Efficiently encode images", displayValue: "Potential savings of 900 KiB", details: { type: "opportunity", overallSavingsMs: 1800 } },
    "unused-javascript": { title: "Reduce unused JavaScript", details: { type: "opportunity", overallSavingsMs: 450 } },
    "tiny": { title: "Tiny win", details: { type: "opportunity", overallSavingsMs: 50 } },
    "not-opportunity": { title: "Diagnostic", details: { type: "table" } },
  } },
  ...over,
});

test("rate uses Google's thresholds", () => {
  assert.equal(rate("lcp", 2500), "good"); assert.equal(rate("lcp", 2501), "needs improvement"); assert.equal(rate("lcp", 4001), "poor");
  assert.equal(rate("cls", 0.1), "good"); assert.equal(rate("cls", 0.26), "poor"); assert.equal(rate("inp", 200), "good"); assert.equal(rate("inp", 600), "poor");
  assert.equal(rate("lcp", null), ""); assert.equal(rate("nope", 1), "");
});

test("buildPsiUrl encodes the page, strategy and optional key", () => {
  const u = new URL(buildPsiUrl("https://s.com/a b?x=1&y=2", "desktop", "KEY"));
  assert.equal(u.searchParams.get("url"), "https://s.com/a b?x=1&y=2"); assert.equal(u.searchParams.get("strategy"), "desktop"); assert.equal(u.searchParams.get("key"), "KEY");
  assert.equal(new URL(buildPsiUrl("https://s.com/", "weird")).searchParams.get("strategy"), "mobile");
  assert.equal(new URL(buildPsiUrl("https://s.com/")).searchParams.has("key"), false);
});

test("parsePsi keeps real-user (field) and lab data apart, scales CLS, and lists only worthwhile savings", () => {
  const r = parsePsi(raw(), { url: "https://s.com/", strategy: "mobile", now: new Date("2026-11-17T10:00:00Z") });
  assert.equal(r.score, 42); assert.equal(r.fetchedAt, "2026-11-17T10:00:00.000Z");
  assert.deepEqual(r.field.lcp, { value: 4800, rating: "poor" }); assert.equal(r.field.cls.value, 0.12); assert.equal(r.field.cls.rating, "needs improvement"); assert.equal(r.field.overall, "poor");
  assert.equal(r.lab.lcp, 5200); assert.equal(r.lab.lcpRating, "poor"); assert.equal(r.lab.tbtRating, "needs improvement");
  assert.deepEqual(r.opportunities.map((o) => o.title), ["Efficiently encode images", "Reduce unused JavaScript"]);
  assert.equal(parsePsi({}), null);
});

test("a page without enough real-user data falls back to lab numbers", () => {
  const r = parsePsi(raw({ loadingExperience: { metrics: {} } }), { url: "https://s.com/" });
  assert.equal(r.field, null);
  assert.deepEqual(weakVitals(r).map((w) => [w.metric, w.source]), [["lcp", "lab test"], ["cls", "lab test"], ["tbt", "lab test"]].sort((a, b) => 0)); // all weak, poor first
});

test("weakVitals orders poor before needs-improvement and skips good ones; vitalsRec names the evidence", () => {
  const r = parsePsi(raw(), { url: "https://s.com/page", strategy: "mobile", now: new Date("2026-11-17T00:00:00Z") });
  const w = weakVitals(r);
  assert.deepEqual(w.map((x) => x.metric), ["lcp", "cls"]); assert.ok(!w.some((x) => x.metric === "inp"));
  const rec = vitalsRec(r);
  assert.match(rec.title, /Improve Core Web Vitals on \/page \(mobile\)/); assert.match(rec.evidence, /4\.8 s/); assert.match(rec.evidence, /Efficiently encode images/);
  assert.equal(rec.priority, "High"); assert.deepEqual(rec.urls, ["https://s.com/page"]);
});

test("fmtMetric and upsertPageSpeed", () => {
  assert.equal(fmtMetric("lcp", 2400), "2.4 s"); assert.equal(fmtMetric("inp", 180), "180 ms"); assert.equal(fmtMetric("cls", 0.1234), "0.12"); assert.equal(fmtMetric("lcp", null), "n/a");
  const a = { url: "u", strategy: "mobile", score: 1 }, b = { url: "u", strategy: "desktop", score: 2 }, a2 = { url: "u", strategy: "mobile", score: 9 };
  const list = upsertPageSpeed(upsertPageSpeed([], a), b);
  assert.deepEqual(upsertPageSpeed(list, a2).map((x) => x.score), [9, 2]);
  assert.equal(upsertPageSpeed(Array.from({ length: 30 }, (_, i) => ({ url: `u${i}`, strategy: "mobile" })), a).length, 20);
});
