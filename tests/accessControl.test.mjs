import test from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqual, parseBasicAuth, accessConfig, checkAccess } from "../lib/accessControl.js";

const basic = (user, pass) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

test("timingSafeEqual", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  for (const [a, b] of [["abc", "abd"], ["abc", "abcd"], ["", "a"], ["a", ""]]) assert.equal(timingSafeEqual(a, b), false);
  assert.equal(timingSafeEqual("", ""), true); assert.equal(timingSafeEqual(null, undefined), true);
  assert.equal(timingSafeEqual("pässword", "pässword"), true); assert.equal(timingSafeEqual("pässword", "password"), false);
});

test("parseBasicAuth handles colons in the password, unicode, and garbage", () => {
  assert.deepEqual(parseBasicAuth(basic("me", "a:b:c")), { user: "me", pass: "a:b:c" });
  assert.deepEqual(parseBasicAuth(basic("", "pässwörd✓")), { user: "", pass: "pässwörd✓" });
  for (const bad of [null, undefined, "", "Bearer abc", "Basic", "Basic !!!!", "Basic " + Buffer.from("nocolon").toString("base64")]) assert.equal(parseBasicAuth(bad), null, String(bad));
});

test("with a password configured: only the right password gets in", () => {
  const cfg = accessConfig({ VR_ACCESS_PASSWORD: "correct horse battery staple", NODE_ENV: "production" });
  assert.deepEqual(checkAccess(basic("anyone", "correct horse battery staple"), cfg), { allowed: true });
  assert.deepEqual(checkAccess(basic("anyone", "wrong"), cfg), { allowed: false, reason: "invalid" });
  assert.deepEqual(checkAccess(undefined, cfg), { allowed: false, reason: "missing" });
  assert.deepEqual(checkAccess("Bearer x", cfg), { allowed: false, reason: "invalid" });
  assert.equal(checkAccess(basic("x", "correct horse battery stapl"), cfg).allowed, false); // prefix
  assert.equal(checkAccess(basic("x", "correct horse battery staplee"), cfg).allowed, false); // extension
});

test("a required username is enforced when VR_ACCESS_USER is set", () => {
  const cfg = accessConfig({ VR_ACCESS_PASSWORD: "pw", VR_ACCESS_USER: "owner" });
  assert.equal(checkAccess(basic("owner", "pw"), cfg).allowed, true);
  assert.equal(checkAccess(basic("someone", "pw"), cfg).allowed, false);
});

test("no password: production is LOCKED, development is open, explicit opt-out is open", () => {
  assert.deepEqual(checkAccess(undefined, accessConfig({ NODE_ENV: "production" })), { allowed: false, reason: "not_configured" });
  assert.deepEqual(checkAccess(undefined, accessConfig({ NODE_ENV: "development" })), { allowed: true });
  assert.deepEqual(checkAccess(undefined, accessConfig({})), { allowed: true });
  assert.deepEqual(checkAccess(undefined, accessConfig({ NODE_ENV: "production", VR_ACCESS_DISABLED: "1" })), { allowed: true });
  assert.deepEqual(checkAccess(undefined, accessConfig({ NODE_ENV: "production", VR_ACCESS_DISABLED: "true" })), { allowed: true });
});

test("an empty-string password counts as 'not configured' (never as 'empty password accepted')", () => {
  const cfg = accessConfig({ VR_ACCESS_PASSWORD: "", NODE_ENV: "production" });
  assert.equal(checkAccess(basic("a", ""), cfg).allowed, false);
});
