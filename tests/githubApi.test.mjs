import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTarget, siteUrlOf, errorResponse, summarizePlan, clientFromEnv } from "../lib/githubApi.js";
import { GitHubError } from "../lib/github.js";

test("parseTarget accepts owner/repo or a URL and rejects anything else", () => {
  assert.deepEqual(parseTarget({ repoUrl: "https://github.com/acme/site/tree/gh-pages" }), { ok: true, owner: "acme", repo: "site", branch: "gh-pages" });
  assert.deepEqual(parseTarget({ owner: "acme", repo: "site", branch: "main" }), { ok: true, owner: "acme", repo: "site", branch: "main" });
  assert.deepEqual(parseTarget({ repoUrl: "acme/site", branch: "dev" }), { ok: true, owner: "acme", repo: "site", branch: "dev" });
  for (const bad of [{}, { owner: "a/b", repo: "x" }, { owner: "acme", repo: "../x" }, { repoUrl: "https://evil.com/a/b" }, { owner: "acme", repo: "site", branch: "../x" }, null]) assert.equal(parseTarget(bad).ok, false, JSON.stringify(bad));
});

test("siteUrlOf normalises to an origin and refuses non-http(s)", () => {
  assert.equal(siteUrlOf("example.com"), "https://example.com"); assert.equal(siteUrlOf("http://a.com/path?q=1"), "http://a.com");
  for (const bad of ["", null, "javascript:alert(1)", "ftp://a.com", "x".repeat(3000)]) assert.equal(siteUrlOf(bad), null, String(bad).slice(0, 20));
});

test("errors become JSON responses with sensible statuses and no internals", async () => {
  const cases = [["NO_TOKEN", 503], ["BAD_TOKEN", 502], ["RATE_LIMIT", 429], ["FORBIDDEN", 403], ["NOT_FOUND", 404], ["INVALID", 400], ["NOT_UTF8", 422]];
  for (const [code, status] of cases) { const r = errorResponse(new GitHubError(code, "friendly message")); assert.equal(r.status, status); assert.deepEqual(await r.json(), { error: "friendly message", code }); }
  const orig = console.error; console.error = () => {};
  try { const r = errorResponse(new Error("secret internals ghp_TOKEN")); assert.equal(r.status, 500); assert.ok(!JSON.stringify(await r.json()).includes("ghp_TOKEN")); } finally { console.error = orig; }
});

test("summarizePlan never sends whole files to the browser", () => {
  const plan = { results: [{ id: "a", ok: true }], canCreate: true, analysis: { verdict: "plain-html", warnings: ["w"], reasons: ["r"], siteRoots: [1], counts: {} },
    edits: [{ path: "a.html", before: "SECRET-BEFORE", after: "SECRET-AFTER", diff: "d", stats: { added: 1, removed: 1 }, fixIds: ["a"] }], creates: [{ path: "robots.txt", content: "SECRET-CONTENT", diff: "d2", stats: { added: 2, removed: 0 }, fixIds: ["b"] }] };
  const out = JSON.stringify(summarizePlan(plan));
  for (const secret of ["SECRET-BEFORE", "SECRET-AFTER", "SECRET-CONTENT"]) assert.ok(!out.includes(secret), secret);
  assert.deepEqual(summarizePlan(plan).edits, [{ path: "a.html", diff: "d", stats: { added: 1, removed: 1 }, fixIds: ["a"] }]);
});

test("the client needs a token from the environment", () => {
  assert.throws(() => clientFromEnv({}), { code: "NO_TOKEN" });
  assert.doesNotThrow(() => clientFromEnv({ GITHUB_TOKEN: "t" }));
});

// Structural guards on the route files (they use Next-style imports, so they can't be imported under plain Node).
const route = (n) => readFileSync(new URL(`../app/api/github/${n}/route.js`, import.meta.url), "utf8");
for (const name of ["inspect", "preview", "create-pr", "pr-status"]) {
  test(`github/${name}: goes through the guard (password + rate limits + body cap) before anything else`, () => {
    const src = route(name);
    assert.match(src, /guardJson\(req, "github"\)/); assert.ok(src.indexOf("guardJson(") < src.indexOf("clientFromEnv("), "guard runs first");
    assert.match(src, /export const runtime = "nodejs"/); assert.ok(!/GITHUB_TOKEN/.test(src), "routes never touch the token directly");
  });
}
test("create-pr requires explicit confirmation and never accepts file contents from the browser", () => {
  const src = route("create-pr");
  assert.match(src, /body\.confirm !== true/); assert.ok(!/body\.(edits|files|content|diff)/.test(src));
});
