// In-memory fake of lib/safeFetch.js. The fake web lives on globalThis.__web:
//   { "https://a.com/x": { status, type, body, location, headers } }
export async function validatePublicUrl(u) { return { ok: true, url: new URL(String(u)) }; }

export async function safeFetchText(rawUrl, opts = {}) {
  const web = globalThis.__web || {};
  const redirects = [];
  let current = new URL(String(rawUrl));
  const log = (globalThis.__requests ||= []);
  for (let hop = 0; ; hop++) {
    log.push({ url: current.href, headersOnly: !!opts.headersOnly });
    const key = current.href.replace(/([^/])\/$/, "$1") === current.href ? current.href : current.href;
    const entry = web[current.href] || web[key];
    if (!entry) return { ok: false, status: 0, text: "", redirects, headers: {}, error: "could not connect", errorCode: "CONNECTION" };
    if (entry.location) {
      if (hop >= (opts.maxRedirects ?? 5)) return { ok: false, status: entry.status || 301, text: "", redirects, headers: {}, error: "too many redirects", errorCode: "TOO_MANY_REDIRECTS" };
      const next = new URL(entry.location, current);
      if (opts.redirectPolicy && !opts.redirectPolicy(current, next)) return { ok: false, status: entry.status || 301, text: "", redirects, headers: {}, error: "redirected to a different site", errorCode: "REDIRECT_BLOCKED" };
      redirects.push({ status: entry.status || 301, from: current.href, to: next.href });
      current = next;
      continue;
    }
    const headers = { "content-type": entry.type || "text/html", ...(entry.headers || {}) };
    const status = entry.status || 200;
    const ok = status >= 200 && status < 300;
    const base = { status, finalUrl: current.href, ms: 5, headers, redirects };
    if (opts.headersOnly) return { ...base, ok, text: "", ...(ok ? {} : { error: `HTTP ${status}`, errorCode: "HTTP_STATUS" }) };
    if (!ok) return { ...base, ok: false, text: "", error: `HTTP ${status}`, errorCode: "HTTP_STATUS" };
    if (opts.accept?.length && !opts.accept.some((p) => headers["content-type"].startsWith(p))) return { ...base, ok: false, text: "", error: "unsupported content type", errorCode: "BAD_CONTENT_TYPE" };
    return { ...base, ok: true, text: entry.body || "", truncated: false };
  }
}
