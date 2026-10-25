import test from "node:test";
import assert from "node:assert/strict";
import { parseRobotsTxt, matcherFor } from "../lib/robotsTxt.js";

const m = (txt, agent = "vertexrankbot") => matcherFor(parseRobotsTxt(txt), agent);

test("no rules / empty / missing: everything allowed", () => {
  assert.equal(m("").isAllowed("/anything"), true);
  assert.equal(m("User-agent: *\nDisallow:").isAllowed("/x"), true);
  assert.equal(matcherFor(null, "x").isAllowed("/x"), true);
});
test("prefix Disallow, comments, CRLF and BOM", () => {
  const r = m("\uFEFF# hi\r\nUser-agent: *\r\nDisallow: /private # secret\r\n");
  assert.equal(r.isAllowed("/private/page"), false);
  assert.equal(r.isAllowed("/public"), true);
});
test("wildcards and $ anchors", () => {
  const r = m("User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*?sort=\nDisallow: /tmp/*/cache");
  assert.equal(r.isAllowed("/files/a.pdf"), false);
  assert.equal(r.isAllowed("/files/a.pdf?x=1"), true); // $ anchors the end
  assert.equal(r.isAllowed("/search?sort=asc"), false);
  assert.equal(r.isAllowed("/search?q=a&sort=asc"), true); // rule needs the literal ?sort=
  assert.equal(r.isAllowed("/tmp/a/b/cache"), false);
  assert.equal(r.isAllowed("/tmp/cache"), true);
});
test("longest match wins; Allow wins ties", () => {
  const r = m("User-agent: *\nDisallow: /shop\nAllow: /shop/sale\nDisallow: /a\nAllow: /a");
  assert.equal(r.isAllowed("/shop/item"), false);
  assert.equal(r.isAllowed("/shop/sale/1"), true);
  assert.equal(r.isAllowed("/a/b"), true);
});
test("most specific user-agent group wins and groups do not merge across agents", () => {
  const txt = "User-agent: *\nDisallow: /\n\nUser-agent: googlebot\nDisallow: /admin\n";
  assert.equal(m(txt, "googlebot").isAllowed("/blog"), true);
  assert.equal(m(txt, "googlebot").isAllowed("/admin/x"), false);
  assert.equal(m(txt, "vertexrankbot").isAllowed("/blog"), false);
  assert.equal(m(txt, "vertexrankbot").blocksWholeSite(), true);
  assert.equal(m(txt, "googlebot").blocksWholeSite(), false);
});
test("consecutive user-agent lines share rules; our own token beats *", () => {
  const txt = "User-agent: bingbot\nUser-agent: vertexrankbot\nDisallow: /nope\n\nUser-agent: *\nDisallow: /";
  assert.equal(m(txt).isAllowed("/ok"), true);
  assert.equal(m(txt).isAllowed("/nope/x"), false);
  assert.equal(m(txt, "bingbot").isAllowed("/nope"), false);
});
test("Disallow: / with an Allow carve-out is not 'whole site blocked'", () => {
  const r = m("User-agent: *\nDisallow: /\nAllow: /about");
  assert.equal(r.blocksWholeSite(), false);
  assert.equal(r.isAllowed("/about"), true);
  assert.equal(r.isAllowed("/x"), false);
});
test("sitemaps are collected regardless of groups; rules before any user-agent are ignored", () => {
  const p = parseRobotsTxt("Disallow: /ignored\nSitemap: https://a.com/s.xml\nUser-agent: *\nDisallow: /x\nSitemap: https://a.com/t.xml");
  assert.deepEqual(p.sitemaps, ["https://a.com/s.xml", "https://a.com/t.xml"]);
  assert.equal(matcherFor(p, "x").isAllowed("/ignored"), true);
});
