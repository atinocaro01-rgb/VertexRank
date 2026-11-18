// Turns report data (lib/clientReport.js) into one self-contained, print-ready HTML document (pure, no dependencies).
// Used for the in-app preview, "Save as PDF" (the browser's print dialog) and "Download HTML". Every piece of text is escaped.
// Tests: tests/clientReport.test.mjs.

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n = (v) => (Number.isFinite(v) ? v.toLocaleString("en-US") : "–");
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "–");
const day = (iso) => { try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); } catch { return ""; } };

const CSS = `
*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1c2430;background:#fff;font-size:13px;line-height:1.5}
.page{max-width:820px;margin:0 auto;padding:36px 40px}
.cover{border-bottom:3px solid #2b5cff;padding-bottom:18px;margin-bottom:22px}
.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5b6676;margin:0 0 6px}
h1{font-size:28px;margin:0 0 4px;line-height:1.2}h2{font-size:17px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid #dfe4ec}h3{font-size:13px;margin:16px 0 6px}
.muted{color:#5b6676}.small{font-size:11px}
.tiles{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}.tile{flex:1 1 150px;border:1px solid #dfe4ec;border-radius:8px;padding:10px 12px;break-inside:avoid}
.tile b{display:block;font-size:22px;line-height:1.2}.tile span{font-size:11px;color:#5b6676}
table{width:100%;border-collapse:collapse;margin:6px 0 4px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e8ecf2;vertical-align:top}th{font-size:11px;color:#5b6676;font-weight:600}td.r,th.r{text-align:right}
tr{break-inside:avoid}.pill{display:inline-block;font-size:10px;font-weight:700;border-radius:999px;padding:1px 8px;margin-right:6px;white-space:nowrap}
.Critical{background:#fde8e8;color:#b42318}.High{background:#fff0e0;color:#b45309}.Medium{background:#fff7d6;color:#8a6d00}.Low{background:#e8f0ff;color:#2b5cff}
.win{background:#e3f6ec;color:#177245}.watch{background:#fff0e0;color:#b45309}.pass{background:#e3f6ec;color:#177245}.warn{background:#fff7d6;color:#8a6d00}.fail{background:#fde8e8;color:#b42318}
.bar{height:8px;background:#e8ecf2;border-radius:99px;overflow:hidden;min-width:120px}.bar i{display:block;height:100%;background:#2b5cff}
ul{margin:4px 0 4px 18px;padding:0}li{margin:2px 0}.note{background:#f5f7fb;border-radius:8px;padding:10px 12px;margin:10px 0;white-space:pre-wrap}
.item{border:1px solid #e8ecf2;border-radius:8px;padding:9px 12px;margin:8px 0;break-inside:avoid}.item p{margin:3px 0}
footer{margin-top:30px;padding-top:12px;border-top:1px solid #dfe4ec}
@page{size:A4;margin:14mm}@media print{.page{padding:0;max-width:none}h2{break-after:avoid}}
`;

const pill = (cls, text) => `<span class="pill ${esc(cls)}">${esc(text)}</span>`;
const section = (title, body) => `<section><h2>${esc(title)}</h2>${body}</section>`;
const tile = (value, label) => `<div class="tile"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
const table = (head, rows) => `<table><thead><tr>${head.map(([h, r]) => `<th class="${r ? "r" : ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
const td = (v, r) => `<td class="${r ? "r" : ""}">${v}</td>`;

export function renderReportHtml(d) {
  const on = (id) => d.sections?.[id] !== false;
  const parts = [];
  const m = d.meta;

  // Cover
  parts.push(`<header class="cover"><p class="eyebrow">SEO report</p><h1>${esc(m.siteName || m.domain || "Your website")}</h1>
    <p class="muted">${m.clientName ? `Prepared for ${esc(m.clientName)}` : ""}${m.clientName && m.preparedBy ? " · " : ""}${m.preparedBy ? `Prepared by ${esc(m.preparedBy)}` : ""}${m.clientName || m.preparedBy ? " · " : ""}${esc(day(m.generatedAt))}</p></header>`);
  if (m.notes) parts.push(`<div class="note">${esc(m.notes)}</div>`);

  // Summary
  if (on("summary")) {
    const tiles = [tile(d.playbook.overall.score === null ? "–" : `${d.playbook.overall.score}%`, "Playbook score (items measured so far)")];
    if (d.search.has) tiles.push(tile(n(d.search.totals.clicks), `Clicks from Google, last ${d.search.days} days`), tile(n(d.search.totals.impressions), "Impressions"));
    if (d.summary.pagesCrawled) tiles.push(tile(n(d.summary.pagesCrawled), "Pages crawled"), tile(n(d.summary.severity.Critical + d.summary.severity.High), "Critical + high issues"));
    const hl = d.highlights.length ? `<h3>Highlights</h3><ul>${d.highlights.map((h) => `<li>${pill(h.kind, h.kind === "win" ? "Good" : "Watch")}${esc(h.text)}</li>`).join("")}</ul>` : "";
    parts.push(section("Summary", `<div class="tiles">${tiles.join("")}</div>${hl}${d.highlights.length ? "" : `<p class="muted">Not enough data yet for highlights. Run a site crawl and connect Search Console.</p>`}`));
  }

  // Playbook
  if (on("playbook")) {
    const rows = d.playbook.groups.map((g) => td(`<b>${esc(g.title)}</b>`) + td(g.score === null ? `<span class="muted">Not measured yet</span>` : `<div class="bar"><i style="width:${g.score}%"></i></div>`) + td(g.score === null ? "–" : `${g.score}%`, true) + td(`<span class="muted small">${g.measured} of ${g.total} items measured</span>${g.weak.length ? `<br><span class="small">To work on: ${esc(g.weak.join(", "))}</span>` : ""}`));
    parts.push(section("Playbook scorecard", `<p class="muted">Progress against a 2026 SEO checklist of ${d.playbook.overall.total} items across six areas. Items that can't be measured yet are left out of the score rather than counted as good or bad.</p>${table([["Area"], ["Progress"], ["Score", true], ["Detail"]], rows.map((r) => `<tr>${r}</tr>`))}`));
  }

  // Search performance
  if (on("search")) {
    if (!d.search.has) parts.push(section("Search performance", `<p class="muted">Google Search Console isn't connected for this website yet, so there is no search data to report.</p>`));
    else {
      const s = d.search, ch = s.change;
      const delta = (v) => (v === null || v === undefined ? "" : ` <span class="muted small">(${v >= 0 ? "+" : ""}${v}%)</span>`);
      const tiles = [tile(n(s.totals.clicks), "Clicks"), tile(n(s.totals.impressions), "Impressions"), tile(pct(s.totals.ctr), "Average CTR"), tile(Number.isFinite(s.totals.position) ? s.totals.position.toFixed(1) : "–", "Average position")];
      const top = s.topQueries.length ? `<h3>Top queries</h3>${table([["Query"], ["Clicks", true], ["Impressions", true], ["Position", true]], s.topQueries.map((q) => `<tr>${td(esc(q.query))}${td(n(q.clicks), true)}${td(n(q.impressions), true)}${td(q.position.toFixed(1), true)}</tr>`))}` : "";
      const qw = s.quickWins.length ? `<h3>Quick wins: queries close to the top of page one</h3><p class="muted small">Average position 4–20 with real impressions. Improving the page that ranks is usually the cheapest gain.</p>${table([["Query"], ["Page"], ["Impressions", true], ["Position", true]], s.quickWins.map((q) => `<tr>${td(esc(q.query))}${td(esc(q.page))}${td(n(q.impressions), true)}${td(q.position.toFixed(1), true)}</tr>`))}` : "";
      const rf = s.refresh.length ? `<h3>Pages worth refreshing</h3><ul>${s.refresh.map((r) => `<li><b>${esc(r.path)}</b>: ${esc(r.reasons.join("; "))}</li>`).join("")}</ul>` : "";
      parts.push(section("Search performance", `<p class="muted">Google Search Console, ${esc(s.days)} days${s.range ? ` (${esc(s.range.startDate || "")} to ${esc(s.range.endDate || "")})` : ""}${ch ? ", compared with the previous equal period" : ""}.</p><div class="tiles">${tiles.join("")}</div>${ch ? `<p class="small muted">Clicks ${delta(ch.clicks).trim()} · Impressions ${delta(ch.impressions).trim()} vs previous period.</p>` : ""}${top}${qw}${rf}`));
    }
  }

  // Issues
  if (on("issues")) {
    if (!d.summary.pagesCrawled) parts.push(section("Issues found", `<p class="muted">No site crawl has been run yet.</p>`));
    else {
      const sv = d.summary.severity;
      const list = d.issues.map((i) => `<div class="item"><p>${pill(i.severity, i.severity)}<b>${esc(i.title)}</b>${i.pages ? ` <span class="muted small">(${i.pages} ${i.pages === 1 ? "page" : "pages"})</span>` : ""}</p>${i.why ? `<p class="muted">${esc(i.why)}</p>` : ""}${i.fix ? `<p><b>Fix:</b> ${esc(i.fix)}</p>` : ""}</div>`).join("");
      parts.push(section("Issues found", `<p class="muted">${d.summary.totalIssues} ${d.summary.totalIssues === 1 ? "issue" : "issues"} across ${d.summary.pagesCrawled} crawled pages: ${sv.Critical} critical, ${sv.High} high, ${sv.Medium} medium, ${sv.Low} low. The most important ${d.issues.length} are below.</p>${list || `<p>No issues found.</p>`}`));
    }
  }

  // Vitals
  if (on("vitals")) {
    if (!d.vitals.length) parts.push(section("Page speed (Core Web Vitals)", `<p class="muted">Page speed hasn't been tested yet.</p>`));
    else parts.push(section("Page speed (Core Web Vitals)", `<p class="muted">Measured by Google PageSpeed Insights. Real-user data is what Google ranks on; pages without enough traffic show a single lab test instead.</p>${table([["Page"], ["Device"], ["Score", true], ["Based on"], ["Needs work"]], d.vitals.map((v) => `<tr>${td(esc(v.path))}${td(esc(v.strategy))}${td(v.score === null ? "–" : esc(v.score), true)}${td(esc(v.basis))}${td(v.weak.length ? esc(v.weak.join("; ")) : `${pill("pass", "Good")}`)}</tr>`))}`));
  }

  // Content
  if (on("content")) {
    const c = d.content;
    if (!c.total) parts.push(section("Content", `<p class="muted">No content plan yet.</p>`));
    else {
      const up = c.upcoming.length ? `<h3>Coming up</h3>${table([["Date"], ["Topic"], ["Stage"]], c.upcoming.map((u) => `<tr>${td(esc(u.date))}${td(esc(u.title))}${td(esc(u.stage === "draft" ? "Draft written" : "Idea"))}</tr>`))}` : "";
      const pub = c.publishedNow.length ? `<h3>Published</h3><ul>${c.publishedNow.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "";
      parts.push(section("Content", `<div class="tiles">${tile(c.counts.idea, "Ideas planned")}${tile(c.counts.draft, "Drafts written")}${tile(c.counts.published, "Published")}</div>${pub}${up}`));
    }
  }

  // Local
  if (on("local") && d.local.has) {
    const L = d.local;
    const checks = L.checks.length ? table([["Check"], ["Result"]], L.checks.map((c) => `<tr>${td(esc(c.title))}${td(pill(c.status === "pass" ? "pass" : c.status === "warn" ? "warn" : "fail", c.status === "pass" ? "OK" : c.status === "warn" ? "Check" : "Missing"))}</tr>`)) : "";
    const areas = L.areas.length ? `<h3>Pages for areas served</h3><ul>${L.areas.map((a) => `<li>${esc(a.area)}: ${a.status === "page" ? "has its own page" : a.status === "mention" ? "mentioned only" : "no page yet"}</li>`).join("")}</ul>` : "";
    parts.push(section("Local SEO", `<p class="muted">Checklist progress (Google Business Profile, citations, reviews): ${L.checklist.done} of ${L.checklist.total} ticked by the site owner. Website checks come from the crawl.</p>${checks}${areas}`));
  }

  // Next steps
  if (on("nextSteps")) {
    parts.push(section("Recommended next steps", d.nextSteps.length ? `<ol>${d.nextSteps.map((s) => `<li>${pill(s.priority, s.priority)}<b>${esc(s.title)}</b>${s.action ? `<br><span class="muted">${esc(s.action)}</span>` : ""}</li>`).join("")}</ol>` : `<p class="muted">No open recommendations right now.</p>`));
  }

  // Sources
  parts.push(`<footer class="small muted"><p><b>Where this comes from.</b> ${d.sources.length ? d.sources.map(esc).join(" ") : "No data sources connected yet."}</p><p>Scores and checks are VertexRank's own, based on the data above. They are not Google scores and don't predict rankings. Backlinks, Google Business Profile status and reviews can't be read automatically and are not part of the data.</p></footer>`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(`SEO report: ${m.siteName || m.domain || ""}`)}</title><style>${CSS}</style></head><body><div class="page">${parts.join("\n")}</div></body></html>`;
}
