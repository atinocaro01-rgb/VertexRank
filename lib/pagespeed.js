// Core Web Vitals via Google's PageSpeed Insights API (pure helpers: no network here). Tests: tests/pagespeed.test.mjs.
//
// Two kinds of numbers come back and are kept apart:
//   FIELD data = what real Chrome users experienced over the last 28 days (the data Google uses for ranking). Only present for
//                pages with enough traffic.
//   LAB data   = one simulated Lighthouse load right now. Useful for finding causes, but not what Google ranks on.

export const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

// Google's published thresholds: [good up to, poor above].
export const THRESHOLDS = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25], tbt: [200, 600] };
export const METRIC_LABEL = { lcp: "Largest Contentful Paint (loading)", inp: "Interaction to Next Paint (responsiveness)", cls: "Cumulative Layout Shift (stability)", tbt: "Total Blocking Time (lab stand-in for responsiveness)" };

/** "good" | "needs improvement" | "poor" for a metric value, or "" when there is no value. */
export function rate(metric, value) {
  const t = THRESHOLDS[metric];
  if (!t || !Number.isFinite(value)) return "";
  return value <= t[0] ? "good" : value > t[1] ? "poor" : "needs improvement";
}

export function buildPsiUrl(pageUrl, strategy = "mobile", key = "") {
  const q = new URLSearchParams({ url: pageUrl, strategy: strategy === "desktop" ? "desktop" : "mobile", category: "performance" });
  if (key) q.set("key", key);
  return `${PSI_ENDPOINT}?${q.toString()}`;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const CAT = { FAST: "good", AVERAGE: "needs improvement", SLOW: "poor" };

/** Turns a raw PageSpeed Insights response into the small shape the app stores. Returns null when it has no usable data. */
export function parsePsi(json, { url, strategy = "mobile", now = new Date() } = {}) {
  const lh = json?.lighthouseResult;
  const audits = lh?.audits || {};
  if (!lh) return null;
  const lab = {
    lcp: num(audits["largest-contentful-paint"]?.numericValue), cls: num(audits["cumulative-layout-shift"]?.numericValue),
    tbt: num(audits["total-blocking-time"]?.numericValue), fcp: num(audits["first-contentful-paint"]?.numericValue),
  };
  const fm = json?.loadingExperience?.metrics || {};
  const pick = (k, scale = 1) => { const m = fm[k]; const v = num(m?.percentile); return v === null ? null : { value: v / scale, rating: CAT[m.category] || "" }; };
  const field = { lcp: pick("LARGEST_CONTENTFUL_PAINT_MS"), inp: pick("INTERACTION_TO_NEXT_PAINT"), cls: pick("CUMULATIVE_LAYOUT_SHIFT_SCORE", 100) };
  const hasField = !!(field.lcp || field.inp || field.cls);
  const opportunities = Object.values(audits)
    .filter((a) => a?.details?.type === "opportunity" && num(a.details.overallSavingsMs) >= 300)
    .sort((a, b) => b.details.overallSavingsMs - a.details.overallSavingsMs).slice(0, 5)
    .map((a) => ({ title: String(a.title || "").slice(0, 120), savingsMs: Math.round(a.details.overallSavingsMs), display: String(a.displayValue || "").slice(0, 60) }));
  const score = num(lh.categories?.performance?.score);
  return {
    url: String(url || json?.id || lh.finalUrl || "").slice(0, 500), strategy: strategy === "desktop" ? "desktop" : "mobile",
    fetchedAt: now.toISOString(),
    score: score === null ? null : Math.round(score * 100),
    field: hasField ? { ...field, overall: CAT[json.loadingExperience?.overall_category] || "" } : null,
    lab: { ...lab, lcpRating: rate("lcp", lab.lcp), clsRating: rate("cls", lab.cls), tbtRating: rate("tbt", lab.tbt) },
    opportunities,
  };
}

/** The metrics (field first, lab as a fallback) that are not "good", worst first. */
export function weakVitals(r) {
  const out = [];
  const add = (metric, value, rating, source) => { if (rating && rating !== "good") out.push({ metric, value, rating, source }); };
  if (r?.field) { add("lcp", r.field.lcp?.value, r.field.lcp?.rating, "real users"); add("inp", r.field.inp?.value, r.field.inp?.rating, "real users"); add("cls", r.field.cls?.value, r.field.cls?.rating, "real users"); }
  else if (r?.lab) { add("lcp", r.lab.lcp, r.lab.lcpRating, "lab test"); add("cls", r.lab.cls, r.lab.clsRating, "lab test"); add("tbt", r.lab.tbt, r.lab.tbtRating, "lab test"); }
  return out.sort((a, b) => (a.rating === "poor" ? 0 : 1) - (b.rating === "poor" ? 0 : 1));
}

export const fmtMetric = (metric, v) => (!Number.isFinite(v) ? "n/a" : metric === "cls" ? v.toFixed(2) : v >= 1000 && metric !== "inp" ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

/** A Generate-fix / Action Center input for a page with weak vitals. */
export function vitalsRec(r) {
  const weak = weakVitals(r);
  const what = weak.map((w) => `${METRIC_LABEL[w.metric].split(" (")[0]} ${fmtMetric(w.metric, w.value)} (${w.rating}, ${w.source})`).join("; ");
  const tips = (r.opportunities || []).map((o) => `${o.title}${o.display ? ` (${o.display})` : ""}`).join("; ");
  return {
    title: `Improve Core Web Vitals on ${(() => { try { return new URL(r.url).pathname || "/"; } catch { return r.url; } })()} (${r.strategy})`,
    evidence: `${what || "Performance score " + r.score}. Measured by Google PageSpeed Insights on ${r.fetchedAt.slice(0, 10)}.${tips ? ` Biggest savings Lighthouse found: ${tips}.` : ""}`,
    recommendedAction: "Work through the largest savings first: compress and properly size images, serve them in modern formats, reserve space for images and embeds (fixes layout shift), defer or remove unused JavaScript, and cache static files. Re-test after each change.",
    module: "Core Web Vitals", source: "Google PageSpeed Insights (observed)", actionType: "Technical Fix", priority: weak.some((w) => w.rating === "poor") ? "High" : "Medium", urls: [r.url],
  };
}

/** Replaces the stored result for the same page + device, newest first, keeping at most `cap`. */
export function upsertPageSpeed(list, result, cap = 20) {
  const rest = (Array.isArray(list) ? list : []).filter((x) => !(x.url === result.url && x.strategy === result.strategy));
  return [result, ...rest].slice(0, cap);
}
