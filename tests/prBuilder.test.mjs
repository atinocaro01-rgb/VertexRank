import test from "node:test";
import assert from "node:assert/strict";
import { planChanges, createPullRequest, buildPrBody, LIMITS } from "../lib/prBuilder.js";
import { GitHubError } from "../lib/github.js";

/** An in-memory GitHub: same interface as lib/github.js, with a record of every write so tests can prove what was (not) touched. */
function fakeGithub(initialFiles, { branch = "main", failBranchOnce = false, getFileErrors = {} } = {}) {
  const files = { ...initialFiles };
  const log = { commits: [], branches: [], pulls: [], reads: [] };
  let branchFailed = false;
  const baseSha = "b".repeat(40), baseTree = "e".repeat(40);
  return {
    files, log,
    async getBranchHead(o, r, b) { if (b !== branch) throw new GitHubError("NOT_FOUND", "no such branch", 404); return { sha: baseSha, treeSha: baseTree }; },
    async getTree() { return { entries: Object.keys(files).map((path) => ({ path, type: "blob" })), truncated: false }; },
    async getFile(o, r, path, ref) { log.reads.push({ path, ref }); if (getFileErrors[path]) throw getFileErrors[path]; return files[path] === undefined ? null : { text: files[path], sha: "s-" + path, size: files[path].length }; },
    async createCommit(o, r, { baseSha: parent, baseTreeSha, files: changed, message }) { const c = { sha: "c".repeat(40), parent, baseTreeSha, files: changed, message }; log.commits.push(c); return { sha: c.sha, treeSha: "d".repeat(40) }; },
    async createBranch(o, r, name, sha) { if (failBranchOnce && !branchFailed) { branchFailed = true; throw new GitHubError("UNPROCESSABLE", "Reference already exists", 422); } log.branches.push({ name, sha }); },
    async createPull(o, r, pr) { log.pulls.push(pr); return { number: 12, url: `https://github.com/${o}/${r}/pull/12` }; },
  };
}

const SITE = "https://a.com";
const HTML = (title, extra = "") => `<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8">\n${title ? `  <title>${title}</title>\n` : ""}${extra}</head>\n<body>\n  <h1>Hi</h1>\n  <a href="https://a.com/old">old</a>\n</body>\n</html>\n`;
const repo = () => ({ "index.html": HTML("Home"), "about.html": HTML("About us"), "contact.html": HTML(""), "css/site.css": "body{}", "README.md": "# site" });
const ctx = (client, extra = {}) => ({ client, owner: "acme", repo: "site", branch: "main", siteRoot: "", siteUrl: SITE, ...extra });
const fx = (id, kind, pageUrl, o = {}) => ({ id, kind, ...(pageUrl ? { pageUrl } : {}), ...o });

test("preview: verified fixes produce minimal diffs, blocked ones explain themselves, nothing is written", async () => {
  const gh = fakeGithub(repo());
  const plan = await planChanges({ ...ctx(gh), fixes: [
    fx("t1", "set_title", `${SITE}/about`, { value: "About Acme", expected: "About us" }),
    fx("t2", "set_title", `${SITE}/contact`, { value: "Contact", expected: "" }),
    fx("t3", "set_title", `${SITE}/`, { value: "Wrong", expected: "Something JS rendered" }), // mismatch -> blocked
    fx("l1", "replace_href", `${SITE}/about`, { from: `${SITE}/old`, to: `${SITE}/new` }),
    fx("r1", "create_robots_txt", null, { sitemapUrl: `${SITE}/sitemap.xml` }),
    fx("s1", "create_sitemap_xml", null, { urls: [`${SITE}/`, `${SITE}/about`] }),
    fx("zz", "set_title", `${SITE}/missing-page`, { value: "X" }),
  ] });
  assert.equal(plan.ok, true); assert.equal(plan.analysis.verdict, "plain-html");
  const byId = Object.fromEntries(plan.results.map((r) => [r.id, r]));
  for (const id of ["t1", "t2", "l1", "r1", "s1"]) assert.equal(byId[id].ok, true, id);
  assert.equal(byId.t3.ok, false); assert.equal(byId.t3.code, "MISMATCH"); assert.equal(byId.zz.code, "NOT_FOUND");
  assert.deepEqual(plan.edits.map((e) => e.path).sort(), ["about.html", "contact.html"]);
  const about = plan.edits.find((e) => e.path === "about.html");
  assert.deepEqual(about.fixIds, ["t1", "l1"]); assert.deepEqual(about.stats, { added: 2, removed: 2 });
  assert.match(about.diff, /-  <title>About us<\/title>\n\+  <title>About Acme<\/title>/); assert.match(about.diff, /-  <a href="https:\/\/a.com\/old">old<\/a>\n\+  <a href="https:\/\/a.com\/new">old<\/a>/);
  assert.deepEqual(plan.creates.map((c) => c.path).sort(), ["robots.txt", "sitemap.xml"]);
  assert.equal(plan.canCreate, true);
  assert.equal(gh.log.commits.length + gh.log.branches.length + gh.log.pulls.length, 0, "preview must not write anything");
  assert.ok(gh.log.reads.every((r) => r.ref === "b".repeat(40)), "files are read at the pinned commit, not a moving branch");
});

test("create: one commit on a NEW branch from the pinned commit, a PR against the base branch, base untouched", async () => {
  const gh = fakeGithub(repo());
  const before = JSON.stringify(gh.files);
  const r = await createPullRequest({ ...ctx(gh), fixes: [
    fx("t1", "set_title", `${SITE}/about`, { value: "About Acme", expected: "About us" }),
    fx("t3", "set_title", `${SITE}/`, { value: "Wrong", expected: "JS rendered" }),
    fx("r1", "create_robots_txt", null, {}),
  ], context: { findingTitle: "Pages with poor titles" }, now: new Date("2026-10-27T10:20:30Z"), rand: () => 0.5 });
  assert.equal(r.ok, true);
  assert.equal(r.pr.url, "https://github.com/acme/site/pull/12"); assert.equal(r.branch, "vertexrank/fixes-20261027102030-7fff");
  assert.equal(gh.log.commits.length, 1);
  const c = gh.log.commits[0];
  assert.equal(c.parent, "b".repeat(40)); assert.deepEqual(c.files.map((f) => f.path).sort(), ["about.html", "robots.txt"]);
  assert.equal(c.files.find((f) => f.path === "about.html").content, repo()["about.html"].replace("About us", "About Acme"));
  assert.equal(c.files.find((f) => f.path === "robots.txt").content, "User-agent: *\nAllow: /\n");
  assert.deepEqual(gh.log.branches, [{ name: r.branch, sha: c.sha }]);
  const pr = gh.log.pulls[0];
  assert.equal(pr.base, "main"); assert.equal(pr.head, r.branch); assert.notEqual(pr.head, pr.base); assert.equal(pr.draft, false);
  assert.equal(pr.title, "Pages with poor titles (VertexRank)");
  assert.match(pr.body, /\| Page title \| https:\/\/a.com\/about → about.html \|/); assert.match(pr.body, /Skipped \(not changed\)/); assert.match(pr.body, /isn't what the crawler saw/);
  assert.match(pr.body, /re-crawl it in VertexRank/);
  assert.equal(JSON.stringify(gh.files), before, "the base branch's files are never modified");
});

test("repos that aren't plain HTML are refused before any fix runs", async () => {
  const next = fakeGithub({ "package.json": "{}", "next.config.js": "", "pages/index.js": "", "public/index.html": HTML("x") });
  const r = await planChanges({ ...ctx(next), fixes: [fx("t", "set_title", `${SITE}/`, { value: "x" })] });
  assert.equal(r.ok, false); assert.equal(r.error.code, "UNSUPPORTED_REPO"); assert.match(r.error.message, /framework/i); assert.equal(r.error.analysis.verdict, "framework");
  assert.equal(next.log.reads.length, 0, "no file was even read");
  const wp = await createPullRequest({ ...ctx(fakeGithub({ "wp-config.php": "", "index.php": "", "wp-content/a.php": "", "index.html": "x" })), fixes: [fx("t", "set_title", `${SITE}/`, { value: "x" })] });
  assert.equal(wp.ok, false); assert.equal(wp.error.code, "UNSUPPORTED_REPO");
});

test("nothing applicable -> no commit, no branch, no PR", async () => {
  const gh = fakeGithub(repo());
  const r = await createPullRequest({ ...ctx(gh), fixes: [fx("t", "set_title", `${SITE}/about`, { value: "X", expected: "not what the file says" }), fx("u", "set_title", `${SITE}/gone`, { value: "X" })] });
  assert.equal(r.ok, false); assert.equal(r.error.code, "NOTHING_TO_DO"); assert.equal(r.error.results.length, 2);
  assert.equal(gh.log.commits.length + gh.log.branches.length + gh.log.pulls.length, 0);
});

test("a file that already exists is never overwritten; other fixes still go ahead", async () => {
  const gh = fakeGithub({ ...repo(), "robots.txt": "User-agent: *\nDisallow: /private\n" });
  const plan = await planChanges({ ...ctx(gh), fixes: [fx("r", "create_robots_txt", null, {}), fx("s", "create_sitemap_xml", null, { urls: [`${SITE}/`] }), fx("a", "create_sitemap_xml", null, { urls: [`${SITE}/x`] })] });
  const by = Object.fromEntries(plan.results.map((r) => [r.id, r]));
  assert.equal(by.r.code, "ALREADY_EXISTS"); assert.equal(by.s.ok, true); assert.equal(by.a.code, "DUPLICATE");
  assert.deepEqual(plan.creates.map((c) => c.path), ["sitemap.xml"]);
});

test("site root: fixes map under it, new files are created there, a wrong root is refused", async () => {
  const gh = fakeGithub({ "docs/index.html": HTML("Home"), "docs/about.html": HTML("About"), "README.md": "x" });
  const plan = await planChanges({ ...ctx(gh, { siteRoot: "docs" }), fixes: [fx("t", "set_title", `${SITE}/about`, { value: "About 2", expected: "About" }), fx("r", "create_robots_txt", null, {})] });
  assert.deepEqual([...plan.edits.map((e) => e.path), ...plan.creates.map((c) => c.path)], ["docs/about.html", "docs/robots.txt"]);
  const bad = await planChanges({ ...ctx(gh, { siteRoot: "nowhere" }), fixes: [fx("t", "set_title", `${SITE}/about`, { value: "x" })] });
  assert.equal(bad.error.code, "BAD_ROOT");
  assert.equal((await planChanges({ ...ctx(gh, { siteRoot: "../x" }), fixes: [fx("t", "set_title", `${SITE}/`, { value: "x" })] })).error.code, "INVALID");
});

test("input limits and malformed fixes", async () => {
  const gh = fakeGithub(repo());
  assert.equal((await planChanges({ ...ctx(gh, { branch: "../x" }), fixes: [fx("t", "set_title", `${SITE}/`, { value: "x" })] })).error.code, "INVALID");
  assert.equal((await planChanges({ ...ctx(gh), fixes: [] })).error.code, "INVALID");
  assert.equal((await planChanges({ ...ctx(gh), fixes: Array.from({ length: LIMITS.fixes + 1 }, (_, i) => fx(`f${i}`, "set_title", `${SITE}/`, { value: "x" })) })).error.code, "TOO_MANY");
  const plan = await planChanges({ ...ctx(gh), fixes: [{ id: "bad", kind: "rm_rf" }, fx("evil", "set_title", "https://evil.com/", { value: "x" }), null, fx("ok", "set_title", `${SITE}/about`, { value: "Fine", expected: "About us" })] });
  assert.deepEqual(plan.results.map((r) => [r.id, r.ok, r.code]).slice(0, 2), [["bad", false, "INVALID"], ["evil", false, "INVALID"]]);
  assert.equal(plan.results.find((r) => r.id === "ok").ok, true);
  await assert.rejects(planChanges({ ...ctx(gh, { branch: "nope" }), fixes: [fx("t", "set_title", `${SITE}/`, { value: "x" })] }), { code: "NOT_FOUND" });
});

test("a file GitHub can't safely give us is reported per fix, not thrown", async () => {
  const gh = fakeGithub(repo(), { getFileErrors: { "about.html": new GitHubError("NOT_UTF8", "about.html isn't valid UTF-8 text, so it can't be edited safely.") } });
  const plan = await planChanges({ ...ctx(gh), fixes: [fx("a", "set_title", `${SITE}/about`, { value: "X", expected: "About us" }), fx("b", "set_title", `${SITE}/`, { value: "Home 2", expected: "Home" })] });
  assert.equal(plan.results.find((r) => r.id === "a").code, "NOT_UTF8"); assert.equal(plan.results.find((r) => r.id === "b").ok, true);
});

test("branch name collision retries once with a different name", async () => {
  const gh = fakeGithub(repo(), { failBranchOnce: true });
  const r = await createPullRequest({ ...ctx(gh), fixes: [fx("t", "set_title", `${SITE}/about`, { value: "X", expected: "About us" })], rand: () => 0.25 });
  assert.equal(r.ok, true); assert.match(r.branch, /-b$/); assert.equal(gh.log.branches.length, 1); assert.equal(gh.log.pulls[0].head, r.branch);
});

test("draft option; PR text built from crawled data can't break the markdown table", () => {
  const plan = { analysis: { warnings: ["Heads up | with `code`"] }, edits: [{ path: "a.html" }], creates: [], results: [{ id: "1", kind: "set_title", pageUrl: "https://a.com/x|y", file: "a.html", ok: true, note: "Has | pipe and `tick` and <script>" }, { id: "2", kind: "set_title", ok: false, message: "multi\nline `x`" }] };
  const body = buildPrBody({ siteUrl: SITE, plan, context: { findingTitle: "A | B" } });
  assert.ok(!/<script>/.test(body)); assert.match(body, /Has \\\| pipe and 'tick' and &lt;script>/); assert.match(body, /A \\\| B/);
  assert.ok(body.split("\n").filter((l) => l.startsWith("| Page title")).every((l) => (l.match(/(?<!\\)\|/g) || []).length === 4), "table row keeps exactly 3 cells");
});
