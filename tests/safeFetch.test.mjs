// Run with: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { isBlockedIp, validatePublicUrl, createSafeFetch } from "../lib/safeFetch.js";

test("isBlockedIp: blocks private/reserved, allows public", () => {
  const blocked = [
    "127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "2001:db8::1", "2001:0:4136:e378::1",
    "not-an-ip", "",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2001:4860:4860::8888"];
  for (const ip of blocked) assert.equal(isBlockedIp(ip), true, `should block ${ip}`);
  for (const ip of allowed) assert.equal(isBlockedIp(ip), false, `should allow ${ip}`);
});

test("validatePublicUrl: rejects dangerous URLs without touching the network", async () => {
  const bad = [
    "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/",
    "http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://[::ffff:7f00:1]/",
    "file:///etc/passwd", "ftp://example.com/", "gopher://example.com/",
    "http://user:pw@example.com/", "http://example.com:8080/", "http://example.com:22/",
    "http://localhost/", "http://foo.localhost/", "http://intranet/", "http://db.internal/", "not a url",
  ];
  for (const u of bad) {
    const r = await validatePublicUrl(u);
    assert.equal(r.ok, false, `should reject ${u}`);
  }
});

// ---- end-to-end behaviour against a local server, with injected DNS ----
const bigBody = Buffer.alloc(5 * 1024 * 1024, "a");
const bomb = zlib.gzipSync(Buffer.alloc(80 * 1024 * 1024, 0));
const server = http.createServer((req, res) => {
  const url = req.url;
  const port = server.address().port;
  if (url === "/ok") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end("<html><title>hi</title></html>"); }
  if (url === "/redir-ok") { res.writeHead(301, { location: "/ok" }); return res.end(); }
  if (url === "/redir-internal") { res.writeHead(302, { location: `http://internal.test:${port}/secret` }); return res.end(); }
  if (url === "/redir-offsite") { res.writeHead(302, { location: `http://other.test:${port}/ok` }); return res.end(); }
  if (url === "/redir-loop") { res.writeHead(302, { location: "/redir-loop" }); return res.end(); }
  if (url === "/redir-file") { res.writeHead(302, { location: "file:///etc/passwd" }); return res.end(); }
  if (url === "/big") { res.writeHead(200, { "content-type": "text/html" }); return res.end(bigBody); }
  if (url === "/bomb") { res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }); return res.end(bomb); }
  if (url === "/pdf") { res.writeHead(200, { "content-type": "application/pdf" }); return res.end("%PDF"); }
  if (url === "/slow") { res.writeHead(200, { "content-type": "text/html" }); res.write("<html>"); return; }
  if (url === "/secret") { res.writeHead(200, { "content-type": "text/html" }); return res.end("INTERNAL SECRET"); }
  res.writeHead(404, { "content-type": "text/html" }); res.end("nope");
});
let sf, port;
let rebindCalls = 0;
test.before(async () => {
  await new Promise((r) => server.listen(0, "0.0.0.0", r));
  port = server.address().port;
  sf = createSafeFetch({
    allowedPorts: [port],
    // Pretend 127.0.0.2 is "internal" and 127.0.0.1 is "public"; both reach the local server.
    isBlockedIp: (ip) => ip === "127.0.0.2",
    lookup: async (host) => {
      if (host === "public.test" || host === "other.test") return [{ address: "127.0.0.1", family: 4 }];
      if (host === "internal.test") return [{ address: "127.0.0.2", family: 4 }];
      if (host === "mixed.test") return [{ address: "127.0.0.1", family: 4 }, { address: "127.0.0.2", family: 4 }];
      if (host === "rebind.test") return [{ address: rebindCalls++ === 0 ? "127.0.0.1" : "127.0.0.2", family: 4 }];
      return [];
    },
  });
});
test.after(() => { server.closeAllConnections?.(); server.close(); });
const U = (p, host = "public.test") => `http://${host}:${port}${p}`;
const html = ["text/html", "application/xhtml+xml"];

test("fetches a normal page", async () => {
  const r = await sf.safeFetchText(U("/ok"), { accept: html });
  assert.equal(r.ok, true); assert.equal(r.status, 200); assert.match(r.text, /<title>hi<\/title>/);
});
test("follows a safe redirect and reports the chain", async () => {
  const r = await sf.safeFetchText(U("/redir-ok"), { accept: html });
  assert.equal(r.ok, true); assert.equal(r.redirects.length, 1); assert.ok(r.finalUrl.endsWith("/ok"));
});
test("blocks a hostname that resolves to an internal address", async () => {
  const r = await sf.safeFetchText(U("/secret", "internal.test"));
  assert.equal(r.ok, false); assert.equal(r.errorCode, "BLOCKED_ADDRESS");
});
test("blocks a name with ANY blocked record", async () => {
  const r = await sf.safeFetchText(U("/ok", "mixed.test"));
  assert.equal(r.ok, false); assert.equal(r.errorCode, "BLOCKED_ADDRESS");
});
test("blocks a redirect that points at an internal host (and never reads its body)", async () => {
  const r = await sf.safeFetchText(U("/redir-internal"));
  assert.equal(r.ok, false); assert.equal(r.errorCode, "BLOCKED_ADDRESS"); assert.ok(!r.text.includes("SECRET"));
});
test("blocks a redirect to a non-http scheme", async () => {
  const r = await sf.safeFetchText(U("/redir-file"));
  assert.equal(r.ok, false); assert.equal(r.errorCode, "BAD_PROTOCOL");
});
test("caps redirect hops", async () => {
  const r = await sf.safeFetchText(U("/redir-loop"), { maxRedirects: 3 });
  assert.equal(r.ok, false); assert.equal(r.errorCode, "TOO_MANY_REDIRECTS");
});
test("applies a caller redirect policy (same-site only)", async () => {
  const sameHost = (from, to) => from.hostname === to.hostname;
  const r = await sf.safeFetchText(U("/redir-offsite"), { redirectPolicy: sameHost });
  assert.equal(r.ok, false); assert.equal(r.errorCode, "REDIRECT_BLOCKED");
});
test("DNS rebinding: name that is public at check time but private at connect time is refused", async () => {
  rebindCalls = 0;
  const check = await sf.validatePublicUrl(U("/ok", "rebind.test"));
  assert.equal(check.ok, true); // looked public when validated...
  const r = await sf.safeFetchText(U("/ok", "rebind.test")); // ...but the connect-time lookup now returns the private IP
  assert.equal(r.ok, false); assert.equal(r.errorCode, "BLOCKED_ADDRESS");
});
test("caps response size", async () => {
  const r = await sf.safeFetchText(U("/big"), { maxBytes: 1000 });
  assert.equal(r.ok, true); assert.equal(r.text.length, 1000); assert.equal(r.truncated, true);
});
test("caps DECOMPRESSED size (gzip bomb)", async () => {
  const t0 = Date.now();
  const r = await sf.safeFetchText(U("/bomb"), { maxBytes: 1024 * 1024 });
  assert.equal(r.truncated, true); assert.ok(r.text.length <= 1024 * 1024); assert.ok(Date.now() - t0 < 5000);
});
test("rejects disallowed content types without downloading", async () => {
  const r = await sf.safeFetchText(U("/pdf"), { accept: html });
  assert.equal(r.ok, false); assert.equal(r.errorCode, "BAD_CONTENT_TYPE");
});
test("enforces the overall timeout", async () => {
  const t0 = Date.now();
  const r = await sf.safeFetchText(U("/slow"), { timeoutMs: 400 });
  assert.equal(r.ok, false); assert.equal(r.errorCode, "TIMEOUT"); assert.ok(Date.now() - t0 < 2000);
});
test("reports HTTP errors without a body", async () => {
  const r = await sf.safeFetchText(U("/missing"));
  assert.equal(r.ok, false); assert.equal(r.status, 404); assert.equal(r.text, "");
});
