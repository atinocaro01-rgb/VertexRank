import test from "node:test";
import assert from "node:assert/strict";
import { createGithubClient, GitHubError, isValidOwner, isValidRepo, isValidBranch, isValidRepoPath, parseRepoUrl } from "../lib/github.js";

test("name and path validation blocks traversal and odd characters", () => {
  assert.equal(isValidOwner("my-org"), true); assert.equal(isValidOwner("-bad"), false); assert.equal(isValidOwner("a/b"), false); assert.equal(isValidOwner("bad-"), false); assert.equal(isValidOwner(""), false);
  assert.equal(isValidRepo("site.v2_x"), true); for (const b of ["..", ".", "a/b", "x.git", "", "a b", "a?b"]) assert.equal(isValidRepo(b), false, b);
  assert.equal(isValidBranch("feature/x-1"), true); for (const b of ["../x", "a..b", "/a", "a/", "-x", "a//b", "x.lock", "a b", "a;b", "a.", ""]) assert.equal(isValidBranch(b), false, b);
  assert.equal(isValidRepoPath("docs/about/index.html"), true);
  for (const p of ["/etc/passwd", "../x", "a/../b", "a//b", "a/./b", "a\\b", ".git/config", "a/.GIT/x", "a/", "", "x\u0000y", "x".repeat(501)]) assert.equal(isValidRepoPath(p), false, JSON.stringify(p));
});

test("parseRepoUrl accepts the forms people paste", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/acme/site"), { owner: "acme", repo: "site", branch: null });
  assert.deepEqual(parseRepoUrl("github.com/acme/site.git"), { owner: "acme", repo: "site", branch: null });
  assert.deepEqual(parseRepoUrl("acme/site"), { owner: "acme", repo: "site", branch: null });
  assert.deepEqual(parseRepoUrl("https://github.com/acme/site/tree/gh-pages/docs"), { owner: "acme", repo: "site", branch: "gh-pages/docs" });
  assert.deepEqual(parseRepoUrl("https://www.github.com/acme/site/?tab=readme"), { owner: "acme", repo: "site", branch: null });
  for (const bad of ["", "https://evil.com/acme/site", "acme", "https://github.com/acme", "https://github.com/-x/site", "https://github.com/acme/../x", null]) assert.equal(parseRepoUrl(bad), null, String(bad));
});

const fakeFetch = (handler) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); }; f.calls = calls; return f; };
const json = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
const SHA = "a".repeat(40);

test("no token -> a helpful error; the client only ever talks to api.github.com with the token in the header", async () => {
  assert.throws(() => createGithubClient({}), (e) => e instanceof GitHubError && e.code === "NO_TOKEN" && /GITHUB_TOKEN/.test(e.message));
  const f = fakeFetch(() => json(200, { full_name: "acme/site", default_branch: "main", private: true, permissions: { push: true }, html_url: "u" }));
  const c = createGithubClient({ token: "ghp_SECRET", fetchImpl: f });
  assert.deepEqual(await c.getRepo("acme", "site"), { fullName: "acme/site", defaultBranch: "main", private: true, archived: false, canPush: true, htmlUrl: "u" });
  assert.equal(f.calls[0].url, "https://api.github.com/repos/acme/site"); assert.equal(f.calls[0].init.headers.Authorization, "Bearer ghp_SECRET");
  assert.ok(!f.calls[0].url.includes("ghp_SECRET"));
});

test("invalid names are rejected before any request is made", async () => {
  const f = fakeFetch(() => json(200, {}));
  const c = createGithubClient({ token: "t", fetchImpl: f });
  await assert.rejects(c.getRepo("a/b", "x"), { code: "INVALID" });
  await assert.rejects(c.getRepo("acme", "../x"), { code: "INVALID" });
  await assert.rejects(c.getBranchHead("acme", "site", "../main"), { code: "INVALID" });
  await assert.rejects(c.getFile("acme", "site", "../../etc/passwd", SHA), { code: "INVALID" });
  await assert.rejects(c.getTree("acme", "site", "not-a-sha"), { code: "INVALID" });
  await assert.rejects(c.createBranch("acme", "site", "bad name", SHA), { code: "INVALID" });
  await assert.rejects(c.getPull("acme", "site", 0), { code: "INVALID" });
  assert.equal(f.calls.length, 0);
});

test("HTTP errors map to messages a person can act on, and never leak the token", async () => {
  const cases = [[401, {}, "BAD_TOKEN"], [403, { "x-ratelimit-remaining": "0" }, "RATE_LIMIT"], [403, {}, "FORBIDDEN"], [404, {}, "NOT_FOUND"], [409, {}, "CONFLICT"], [422, {}, "UNPROCESSABLE"], [500, {}, "GITHUB_ERROR"]];
  for (const [status, headers, code] of cases) {
    const c = createGithubClient({ token: "ghp_SECRET", fetchImpl: fakeFetch(() => json(status, { message: "detail text" }, headers)) });
    await assert.rejects(c.getRepo("acme", "site"), (e) => e.code === code && e.status === status && !e.message.includes("ghp_SECRET"), `${status}`);
  }
  const net = createGithubClient({ token: "t", fetchImpl: async () => { throw new Error("socket ghp_SECRET"); } });
  await assert.rejects(net.getRepo("acme", "site"), (e) => e.code === "NETWORK" && !e.message.includes("ghp_SECRET"));
});

test("getFile decodes base64 UTF-8, returns null for 404, refuses non-UTF-8 and oversized files", async () => {
  const ok = (text) => ({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64"), sha: "s1", size: text.length });
  let next = ok("héllo <b>wörld</b>\n");
  const c = createGithubClient({ token: "t", fetchImpl: fakeFetch((url) => (next === 404 ? json(404, {}) : json(200, next))) });
  assert.deepEqual(await c.getFile("acme", "site", "docs/a b.html", SHA), { text: "héllo <b>wörld</b>\n", sha: "s1", size: 19 });
  next = 404; assert.equal(await c.getFile("acme", "site", "x.html", "main"), null);
  next = { type: "file", encoding: "base64", content: Buffer.from([0x68, 0xff, 0xfe, 0x69]).toString("base64"), sha: "s", size: 4 };
  await assert.rejects(c.getFile("acme", "site", "x.html", SHA), { code: "NOT_UTF8" });
  next = { type: "file", encoding: "none", content: "", sha: "s", size: 2_000_000 };
  await assert.rejects(c.getFile("acme", "site", "x.html", SHA), { code: "TOO_LARGE" });
  next = [{ type: "file" }]; await assert.rejects(c.getFile("acme", "site", "dir", SHA), { code: "NOT_A_FILE" });
});

test("path segments are URL-encoded; commit, branch and pull requests are shaped correctly", async () => {
  const f = fakeFetch((url, init) => {
    if (url.endsWith("/git/trees")) return json(201, { sha: "t".repeat(40) });
    if (url.endsWith("/git/commits")) return json(201, { sha: "c".repeat(40) });
    if (url.endsWith("/git/refs")) return json(201, {});
    if (url.endsWith("/pulls")) return json(201, { number: 7, html_url: "https://github.com/acme/site/pull/7" });
    return json(200, { type: "file", encoding: "base64", content: "", sha: "x", size: 0 });
  });
  const c = createGithubClient({ token: "t", fetchImpl: f });
  await c.getFile("acme", "site", "my dir/a#b.html", SHA);
  assert.match(f.calls[0].url, /\/contents\/my%20dir\/a%23b\.html\?ref=a{40}$/);
  const commit = await c.createCommit("acme", "site", { baseSha: SHA, baseTreeSha: SHA, files: [{ path: "index.html", content: "<p>" }], message: "m" });
  assert.deepEqual(commit, { sha: "c".repeat(40), treeSha: "t".repeat(40) });
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { base_tree: SHA, tree: [{ path: "index.html", mode: "100644", type: "blob", content: "<p>" }] });
  assert.deepEqual(JSON.parse(f.calls[2].init.body), { message: "m", tree: "t".repeat(40), parents: [SHA] });
  await c.createBranch("acme", "site", "vertexrank/x", "c".repeat(40));
  assert.deepEqual(JSON.parse(f.calls[3].init.body), { ref: "refs/heads/vertexrank/x", sha: "c".repeat(40) });
  assert.deepEqual(await c.createPull("acme", "site", { title: "T", body: "B", head: "vertexrank/x", base: "main" }), { number: 7, url: "https://github.com/acme/site/pull/7" });
  assert.equal(JSON.parse(f.calls[4].init.body).draft, false);
  await assert.rejects(c.createCommit("acme", "site", { baseSha: SHA, baseTreeSha: SHA, files: [{ path: "../evil", content: "x" }], message: "m" }), { code: "INVALID" });
});
