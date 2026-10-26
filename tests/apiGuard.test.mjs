import test from "node:test";
import assert from "node:assert/strict";

process.env.VR_GLOBAL_DAILY_CRAWLS = "3";
const { guardJson, POLICIES } = await import("../lib/apiGuard.js");

let ipCounter = 0;
const mkReq = (body, ip = `203.0.113.${++ipCounter}`, extra = {}) =>
  new Request("http://localhost/api/x", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("accepts a normal request", async () => {
  const g = await guardJson(mkReq({ url: "example.com" }), "aiLight");
  assert.equal(g.ok, true); assert.equal(g.body.url, "example.com");
});
test("rejects invalid JSON and non-object bodies with 400", async () => {
  for (const b of ["{nope", "[]", "null", "5"]) {
    const g = await guardJson(mkReq(b), "aiLight");
    assert.equal(g.ok, false); assert.equal(g.response.status, 400, b);
  }
});
test("rejects oversized bodies with 413 (declared and streamed)", async () => {
  const big = { x: "a".repeat(POLICIES.crawl.maxBodyBytes + 10) };
  const g = await guardJson(mkReq(big), "crawl");
  assert.equal(g.ok, false); assert.equal(g.response.status, 413);
});
test("per-client limit returns 429 with Retry-After, other clients unaffected", async () => {
  const ip = "198.51.100.7";
  const limit = POLICIES.aiLight.windows[0].limit;
  for (let i = 0; i < limit; i++) assert.equal((await guardJson(mkReq({ i }, ip), "aiLight")).ok, true);
  const over = await guardJson(mkReq({ i: 999 }, ip), "aiLight");
  assert.equal(over.ok, false); assert.equal(over.response.status, 429);
  assert.ok(Number(over.response.headers.get("retry-after")) > 0);
  assert.equal((await guardJson(mkReq({}, "198.51.100.8"), "aiLight")).ok, true);
});
test("light and heavy AI routes share one budget", async () => {
  const ip = "198.51.100.20";
  const limit = POLICIES.aiLight.windows[0].limit;
  for (let i = 0; i < limit; i++) await guardJson(mkReq({}, ip), i % 2 ? "aiHeavy" : "aiLight");
  assert.equal((await guardJson(mkReq({}, ip), "aiHeavy")).ok, false);
});
test("signalsOnly requests are charged to the cheap budget, not the LLM budget", async () => {
  const ip = "198.51.100.30";
  const limit = POLICIES.aiHeavy.windows[0].limit;
  for (let i = 0; i < limit + 20; i++) {
    const g = await guardJson(mkReq({ signalsOnly: true }, ip), "aiHeavy", { signalsPolicy: true });
    assert.equal(g.ok, true, `signals call ${i}`);
  }
  assert.equal((await guardJson(mkReq({}, ip), "aiHeavy", { signalsPolicy: true })).ok, true); // LLM budget untouched
});
test("a client cannot dodge the LLM budget by claiming signalsOnly on a non-signals route", async () => {
  const g = await guardJson(mkReq({ signalsOnly: true }), "aiLight"); // aiLight has no signalsPolicy
  assert.equal(g.ok, true);
});
test("global daily cap returns 503 across different clients", async () => {
  const results = [];
  for (let i = 0; i < 5; i++) results.push((await guardJson(mkReq({ url: "a.com" }, `192.0.2.${i + 1}`), "crawl")).ok);
  assert.deepEqual(results, [true, true, true, false, false]);
  const g = await guardJson(mkReq({ url: "a.com" }, "192.0.2.99"), "crawl");
  assert.equal(g.response.status, 503);
});

test("access control: the API guard enforces the password itself, throttles guessing, and fails closed in production", async () => {
  const saved = { p: process.env.VR_ACCESS_PASSWORD, n: process.env.NODE_ENV };
  const basic = (pw) => "Basic " + Buffer.from(`u:${pw}`).toString("base64");
  try {
    process.env.VR_ACCESS_PASSWORD = "a-long-random-password";
    const ip = "203.0.113.200";
    const noAuth = await guardJson(mkReq({ x: 1 }, ip), "aiLight");
    assert.equal(noAuth.ok, false); assert.equal(noAuth.response.status, 401);
    assert.match(noAuth.response.headers.get("www-authenticate"), /Basic/);
    assert.equal((await guardJson(mkReq({ x: 1 }, ip, { authorization: basic("a-long-random-password") }), "aiLight")).ok, true);
    // guessing: 10 wrong passwords are answered 401, the 11th is throttled
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await guardJson(mkReq({ x: 1 }, "203.0.113.201", { authorization: basic("wrong" + i) }), "aiLight")).response.status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401)); assert.equal(statuses[10], 429);
    // production with no password configured is locked, not open
    delete process.env.VR_ACCESS_PASSWORD; process.env.NODE_ENV = "production";
    const locked = await guardJson(mkReq({ x: 1 }, "203.0.113.202"), "aiLight");
    assert.equal(locked.response.status, 503);
  } finally {
    if (saved.p === undefined) delete process.env.VR_ACCESS_PASSWORD; else process.env.VR_ACCESS_PASSWORD = saved.p;
    if (saved.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.n;
  }
});
