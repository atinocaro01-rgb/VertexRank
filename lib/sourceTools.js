// Finding and reading the sources an article can honestly cite. Server-side helpers, pure (the routes do the network).
// Tests: tests/articleWriter.test.mjs.
//
// Why this exists: an article's claims are only as good as what they rest on. So sources are REAL pages: candidates come from a
// live search (or URLs the person pastes), the person picks which to use, and the writer is given each page's actual text and may
// only cite a source for something that text says. Nothing is cited from memory.

import { hostOf } from "./serpMatch.js";
import { isGenericHost } from "./serpInsights.js";
import { decodeEntities, normalizeText } from "./htmlScan.js";

const AUTHORITY = [
  [/\.(gov|mil)(\.[a-z]{2})?$|\.go\.[a-z]{2}$|\.gov\.[a-z]{2}$/, "Government"],
  [/\.edu(\.[a-z]{2})?$|\.ac\.[a-z]{2}$|\.sc\.ke$/, "Education / research"],
  [/(^|\.)(who|un|unesco|unicef|worldbank|oecd|imf|europa)\.(int|org|eu)$/, "International body"],
  [/\.org(\.[a-z]{2})?$/, "Organisation"],
];

/** A rough label for how authoritative the host looks. It is a hint for the person choosing sources, not a guarantee. */
export function authorityOf(host) {
  for (const [re, label] of AUTHORITY) if (re.test(host)) return label;
  return "Other";
}
const RANK = { Government: 0, "International body": 1, "Education / research": 2, Organisation: 3, Other: 4 };

/** Source candidates from search results: not the site itself, not social/Q&A/marketplace hosts; authoritative hosts first. */
export function rankSourceCandidates(results, ownHost, limit = 8) {
  const seen = new Set();
  const out = [];
  (Array.isArray(results) ? results : []).forEach((r, i) => {
    const host = /^https?:\/\//i.test(String(r?.url || "")) ? hostOf(r.url) : ""; // real web links only
    if (!host || seen.has(host) || host === hostOf(ownHost) || host.endsWith(`.${hostOf(ownHost)}`) || isGenericHost(host)) return;
    seen.add(host);
    out.push({ title: String(r.title || host).slice(0, 200), url: r.url, host, snippet: String(r.snippet || "").slice(0, 300), authority: authorityOf(host), order: i });
  });
  return out.sort((a, b) => RANK[a.authority] - RANK[b.authority] || a.order - b.order).slice(0, limit).map(({ order, ...c }) => c);
}

const BLOCKS = ["script", "style", "noscript", "iframe", "svg", "nav", "header", "footer", "aside", "form", "template"];

/** Readable text of an HTML page for use as source material: title, publish date if declared, and the main text (capped). */
export function extractReadable(html, { maxChars = 2500 } = {}) {
  let h = String(html || "");
  const meta = (re) => { const m = re.exec(h); return m ? normalizeText(m[1]) : ""; };
  const title = meta(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) || meta(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const publishedTime = meta(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']*)["']/i) || meta(/<time[^>]+datetime=["']([^"']*)["']/i);
  for (const tag of BLOCKS) h = h.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  h = h.replace(/<!--[\s\S]*?-->/g, " ");
  const region = /<article\b[\s\S]*?<\/article>/i.exec(h) || /<main\b[\s\S]*?<\/main>/i.exec(h) || /<body\b[\s\S]*?<\/body>/i.exec(h);
  const text = normalizeText(decodeEntities((region ? region[0] : h).replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "$& ").replace(/<[^>]+>/g, " ")));
  return { title: title.slice(0, 200), publishedTime: publishedTime.slice(0, 40), excerpt: text.slice(0, maxChars), chars: text.length };
}
