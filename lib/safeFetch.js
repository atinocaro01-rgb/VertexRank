// SSRF-safe outbound fetching.
//
// Every request VertexRank makes to a URL that a user (or a page/sitemap a user
// pointed us at) controls must go through this module, never through bare
// fetch(). It enforces, in one place:
//
//   1. URL rules: http/https only, no embedded credentials, ports 80/443 only,
//      no localhost / single-label / internal-looking hostnames, no IP literals
//      in private, loopback, link-local, metadata, multicast or reserved ranges
//      (IPv4 and IPv6, including IPv4-mapped / NAT64 / 6to4 forms).
//   2. Connect-time DNS validation: the hostname is resolved INSIDE the socket's
//      own `lookup` hook and the connection is made to exactly the address that
//      was validated. There is no gap between "check" and "connect" for a DNS
//      rebinding attack to slip through. If ANY record for a name is blocked,
//      the whole name is refused.
//   3. Manual redirects: every hop is re-validated (URL rules + connect-time
//      DNS), the hop count is capped, and callers can add their own policy
//      (e.g. "stay on the same site").
//   4. Hard resource limits: overall deadline, response-size cap (applied to
//      DECOMPRESSED bytes, so a gzip bomb can't expand past it), content-type
//      allowlist, and non-2xx bodies are never downloaded.
//
// Uses node:http / node:https directly (no extra dependency) because that is
// what exposes the `lookup` hook needed for connect-time validation.
// Server-side only — import from route handlers / lib code that runs on Node.

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

export class SafeFetchError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/* ------------------------------------------------------------------ */
/* IP classification                                                  */
/* ------------------------------------------------------------------ */

function ipv4ToInt(ip) {
  const p = ip.split(".").map(Number);
  return p[0] * 16777216 + (p[1] << 16) + (p[2] << 8) + p[3];
}

// [base, prefixLength] — anything inside these is never a legitimate public
// crawl target.
const V4_BLOCKED_CIDRS = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay (deprecated)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
].map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (ipv4ToInt(base) & mask) >>> 0, mask };
});

function isBlockedV4Int(n) {
  return V4_BLOCKED_CIDRS.some(({ base, mask }) => ((n & mask) >>> 0) === base);
}

function parseIPv6(input) {
  let ip = input.split("%")[0].toLowerCase();
  if (ip.includes(".")) {
    // Trailing dotted IPv4 (e.g. ::ffff:127.0.0.1) -> two hex groups.
    const i = ip.lastIndexOf(":");
    const n = ipv4ToInt(ip.slice(i + 1));
    ip = ip.slice(0, i + 1) + (((n >>> 16) & 0xffff).toString(16)) + ":" + ((n & 0xffff).toString(16));
  }
  const [head, rest] = ip.split("::");
  const h = head ? head.split(":") : [];
  let groups;
  if (rest === undefined) {
    groups = h;
  } else {
    const r = rest ? rest.split(":") : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - r.length)).fill("0"), ...r];
  }
  return groups.map((g) => parseInt(g || "0", 16));
}

/** True if `ip` must never be connected to. Unparseable input counts as blocked. */
export function isBlockedIp(ip) {
  const s = String(ip || "").trim().replace(/^\[|\]$/g, "");
  const family = net.isIP(s.split("%")[0]);
  if (family === 4) return isBlockedV4Int(ipv4ToInt(s));
  if (family === 6) {
    const g = parseIPv6(s);
    if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return true;
    const embeddedV4 = ((g[6] << 16) | g[7]) >>> 0;
    // ::ffff:a.b.c.d (IPv4-mapped) -> judge the embedded IPv4 address.
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isBlockedV4Int(embeddedV4);
    // ::/96 — unspecified, loopback, and the deprecated IPv4-compatible range.
    if (g.slice(0, 6).every((x) => x === 0)) return true;
    // 64:ff9b::/96 (NAT64) -> judge the embedded IPv4; 64:ff9b:1::/48 is local-use.
    if (g[0] === 0x64 && g[1] === 0xff9b) {
      return g.slice(2, 6).every((x) => x === 0) ? isBlockedV4Int(embeddedV4) : true;
    }
    // 2002::/16 (6to4) -> judge the embedded IPv4.
    if (g[0] === 0x2002) return isBlockedV4Int(((g[1] << 16) | g[2]) >>> 0);
    if (g[0] === 0x2001 && g[1] < 0x200) return true; // IETF assignments incl. Teredo
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    if (g[0] === 0x3fff && g[1] < 0x1000) return true; // documentation (RFC 9637)
    // Only global unicast (2000::/3) is allowed; everything else (ULA fc00::/7,
    // link-local fe80::/10, site-local, multicast ff00::/8, ...) is refused.
    return !(g[0] >= 0x2000 && g[0] <= 0x3fff);
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* URL validation                                                     */
/* ------------------------------------------------------------------ */

const BLOCKED_HOST_SUFFIXES = [
  ".localhost", ".local", ".internal", ".localdomain", ".home.arpa",
  ".lan", ".intranet", ".corp", ".private",
];

function assertSafeUrl(input, cfg) {
  let u;
  try {
    u = input instanceof URL ? new URL(input.href) : new URL(String(input));
  } catch {
    throw new SafeFetchError("INVALID_URL", "That doesn't look like a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SafeFetchError("BAD_PROTOCOL", "Only http and https URLs are allowed.");
  }
  if (u.username || u.password) {
    throw new SafeFetchError("BAD_CREDENTIALS", "URLs with embedded credentials aren't allowed.");
  }
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (!cfg.allowedPorts.includes(port)) {
    throw new SafeFetchError("BAD_PORT", "Only standard web ports (80 and 443) are allowed.");
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) throw new SafeFetchError("INVALID_URL", "That doesn't look like a valid URL.");
  // WHATWG URL already canonicalises decimal/hex/octal IPv4 forms (2130706433,
  // 0x7f.1, 0177.0.0.1) to dotted quads, so IP literals are checked here directly.
  if (net.isIP(host)) {
    if (cfg.isBlockedIp(host)) throw new SafeFetchError("BLOCKED_ADDRESS", "That address isn't allowed.");
    return u;
  }
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes(".")) {
    throw new SafeFetchError("BLOCKED_HOST", "That address isn't allowed.");
  }
  return u;
}

/* ------------------------------------------------------------------ */
/* Connect-time DNS validation                                        */
/* ------------------------------------------------------------------ */

function defaultLookup(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

function makeSafeLookup(cfg) {
  // Signature matches net.connect's `lookup` option.
  return (hostname, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    const wantAll = !!options?.all;
    const fam = options?.family === 4 || options?.family === "IPv4" ? 4
      : options?.family === 6 || options?.family === "IPv6" ? 6 : 0;
    Promise.resolve(cfg.lookup(hostname))
      .then((addrs) => {
        if (!Array.isArray(addrs) || addrs.length === 0) {
          throw new SafeFetchError("DNS_FAILED", "Couldn't resolve that domain.");
        }
        // One bad record poisons the name: refuse the lot.
        if (addrs.some((a) => cfg.isBlockedIp(a.address))) {
          throw new SafeFetchError("BLOCKED_ADDRESS", "That address isn't allowed.");
        }
        const list = addrs.filter((a) => !fam || a.family === fam);
        if (list.length === 0) throw new SafeFetchError("DNS_FAILED", "Couldn't resolve that domain.");
        if (wantAll) callback(null, list);
        else callback(null, list[0].address, list[0].family);
      })
      .catch((err) => callback(err));
  };
}

/* ------------------------------------------------------------------ */
/* One HTTP request (no redirect following)                           */
/* ------------------------------------------------------------------ */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function requestOnce(url, { cfg, headers, deadline, maxBytes, accept }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: "GET",
        headers,
        lookup: cfg.safeLookup,
        agent: false, // fresh connection per request: no pooled-socket surprises across validations
      },
      (res) => {
        const status = res.statusCode || 0;
        const resHeaders = res.headers;

        if (REDIRECT_STATUSES.has(status) && resHeaders.location) {
          res.destroy();
          return done(resolve, { status, headers: resHeaders, redirectTo: String(resHeaders.location) });
        }
        if (status < 200 || status >= 300) {
          res.destroy(); // never download error/odd bodies
          return done(resolve, { status, headers: resHeaders, body: Buffer.alloc(0) });
        }
        const ct = String(resHeaders["content-type"] || "").toLowerCase();
        if (accept?.length && ct && !accept.some((p) => ct.startsWith(p))) {
          res.destroy();
          return done(resolve, { status, headers: resHeaders, body: Buffer.alloc(0), wrongType: true });
        }

        const enc = String(resHeaders["content-encoding"] || "").toLowerCase().trim();
        let stream = res;
        if (enc === "gzip" || enc === "x-gzip" || enc === "deflate") stream = res.pipe(zlib.createUnzip());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc && enc !== "identity") {
          res.destroy();
          return done(resolve, { status, headers: resHeaders, body: Buffer.alloc(0), wrongType: true });
        }

        const chunks = [];
        let total = 0;
        let truncated = false;
        const finish = () => done(resolve, { status, headers: resHeaders, body: Buffer.concat(chunks), truncated });

        stream.on("data", (chunk) => {
          if (settled) return;
          const room = maxBytes - total;
          if (chunk.length > room) {
            if (room > 0) chunks.push(chunk.subarray(0, room));
            total = maxBytes;
            truncated = true;
            finish(); // resolve first, then tear everything down
            req.destroy();
            res.destroy();
            if (stream !== res) stream.destroy();
            return;
          }
          chunks.push(chunk);
          total += chunk.length;
        });
        stream.on("end", finish);
        stream.on("error", (err) => done(reject, err));
        res.on("error", (err) => done(reject, err));
        res.on("close", () => {
          if (!res.complete) done(reject, new SafeFetchError("CONNECTION", "The connection closed early."));
        });
      }
    );

    timer = setTimeout(
      () => req.destroy(new SafeFetchError("TIMEOUT", "timed out")),
      Math.max(1, deadline - Date.now())
    );
    req.on("error", (err) => done(reject, err));
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

const FRIENDLY = {
  TIMEOUT: "timed out",
  INVALID_URL: "invalid URL",
  BAD_PROTOCOL: "URL not allowed",
  BAD_CREDENTIALS: "URL not allowed",
  BAD_PORT: "URL not allowed",
  BLOCKED_HOST: "URL not allowed",
  BLOCKED_ADDRESS: "URL not allowed",
  TOO_MANY_REDIRECTS: "too many redirects",
  REDIRECT_BLOCKED: "redirected to a different site",
  BAD_CONTENT_TYPE: "unsupported content type",
  DNS_FAILED: "could not resolve domain",
};

function decodeBody(buf, contentType) {
  const label = /charset=["']?([\w-]+)/i.exec(contentType || "")?.[1];
  if (label) {
    try { return new TextDecoder(label).decode(buf); } catch { /* unknown charset -> UTF-8 */ }
  }
  return new TextDecoder("utf-8").decode(buf);
}

function flattenHeaders(h) {
  const o = {};
  for (const [k, v] of Object.entries(h || {})) o[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  return o;
}

export function createSafeFetch(overrides = {}) {
  const cfg = {
    allowedPorts: [80, 443],
    maxRedirects: 5,
    defaultMaxBytes: 2 * 1024 * 1024,
    lookup: defaultLookup,
    isBlockedIp,
    ...overrides,
  };
  cfg.safeLookup = makeSafeLookup(cfg);

  /**
   * Fetches a URL as text. Never throws: failures come back as
   * { ok: false, error, errorCode }. Successful results carry
   * { ok, status, text, finalUrl, ms, headers, redirects, truncated }.
   *
   * opts: timeoutMs (whole request incl. redirects), maxBytes, maxRedirects,
   *       accept (content-type prefixes), headers, redirectPolicy(from, to) -> bool
   */
  async function safeFetchText(rawUrl, opts = {}) {
    const start = Date.now();
    const deadline = start + (opts.timeoutMs ?? 8000);
    const maxBytes = opts.maxBytes ?? cfg.defaultMaxBytes;
    const maxRedirects = opts.maxRedirects ?? cfg.maxRedirects;
    const headers = {
      Accept: "text/html,application/xhtml+xml,application/xml,text/plain",
      "Accept-Encoding": "gzip, deflate, br",
      ...(opts.headers || {}),
    };
    const redirects = [];
    try {
      let current = assertSafeUrl(rawUrl, cfg);
      for (let hop = 0; ; hop++) {
        const r = await requestOnce(current, { cfg, headers, deadline, maxBytes, accept: opts.accept });
        if (r.redirectTo !== undefined) {
          if (hop >= maxRedirects) {
            throw new SafeFetchError("TOO_MANY_REDIRECTS", "Too many redirects.", { status: r.status });
          }
          let next;
          try { next = new URL(r.redirectTo, current); } catch {
            throw new SafeFetchError("INVALID_URL", "Bad redirect target.", { status: r.status });
          }
          next = assertSafeUrl(next, cfg);
          if (opts.redirectPolicy && !opts.redirectPolicy(current, next)) {
            throw new SafeFetchError("REDIRECT_BLOCKED", "Redirect not allowed.", { status: r.status });
          }
          redirects.push({ status: r.status, from: current.href, to: next.href });
          current = next;
          continue;
        }
        const flat = flattenHeaders(r.headers);
        const base = { status: r.status, finalUrl: current.href, ms: Date.now() - start, headers: flat, redirects };
        if (r.wrongType) {
          return { ...base, ok: false, text: "", error: FRIENDLY.BAD_CONTENT_TYPE, errorCode: "BAD_CONTENT_TYPE" };
        }
        const ok = r.status >= 200 && r.status < 300;
        return {
          ...base,
          ok,
          text: ok ? decodeBody(r.body, flat["content-type"]) : "",
          truncated: !!r.truncated,
          ...(ok ? {} : { error: `HTTP ${r.status}`, errorCode: "HTTP_STATUS" }),
        };
      }
    } catch (err) {
      const code = err?.code && FRIENDLY[err.code] ? err.code : err?.code === "ETIMEDOUT" ? "TIMEOUT" : "CONNECTION";
      return {
        ok: false, status: err?.status || 0, text: "", ms: Date.now() - start, redirects,
        error: FRIENDLY[code] || "could not connect", errorCode: code,
      };
    }
  }

  /**
   * Early, user-facing validation for a URL a user just typed: URL rules plus a
   * DNS check, so routes can answer 400 immediately instead of failing deep in a
   * crawl. (The connect-time check in safeFetchText is the real enforcement; this
   * is only for a clean error message.)
   */
  async function validatePublicUrl(raw) {
    let u;
    try { u = assertSafeUrl(raw, cfg); } catch (err) {
      return { ok: false, code: err.code, message: err.message };
    }
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!net.isIP(host)) {
      try {
        const addrs = await cfg.lookup(host);
        if (!addrs?.length) return { ok: false, code: "DNS_FAILED", message: "Couldn't resolve that domain." };
        if (addrs.some((a) => cfg.isBlockedIp(a.address))) {
          return { ok: false, code: "BLOCKED_ADDRESS", message: "That address isn't allowed." };
        }
      } catch {
        return { ok: false, code: "DNS_FAILED", message: "Couldn't resolve that domain." };
      }
    }
    return { ok: true, url: u };
  }

  return { safeFetchText, validatePublicUrl, assertSafeUrl: (u) => assertSafeUrl(u, cfg) };
}

const defaultInstance = createSafeFetch();
export const safeFetchText = defaultInstance.safeFetchText;
export const validatePublicUrl = defaultInstance.validatePublicUrl;
