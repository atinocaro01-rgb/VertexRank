// Matching a website against SERP results. Pure helpers (no I/O, no provider code) so the browser can use them too.

/** Host of a URL or bare domain, lowercased, without "www.". "" if it can't be read. */
export function hostOf(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return "";
  try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

/** Does `host` belong to `site` (the same host or one of its subdomains)? */
export function sameSite(host, site) {
  const h = hostOf(host), d = hostOf(site);
  return !!h && !!d && (h === d || h.endsWith(`.${d}`));
}

/** The best (lowest) rank at which the website appears in these results, or null. Also returns the matching result. */
export function findSiteRank(results, site) {
  for (const r of Array.isArray(results) ? results : []) if (r && sameSite(r.url, site)) return { rank: r.rank, result: r };
  return null;
}
