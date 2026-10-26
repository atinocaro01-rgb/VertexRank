import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkspace, createBackup, backupFilename, parseBackupText, mergeWorkspaces, timeAgo, BACKUP_FORMAT } from "../lib/workspaceBackup.js";

const emptyBundle = () => ({ scores: { overall: null, aeo: null }, siteCrawl: null, keywords: [], aeoQuestions: [], competitors: [], contentIdeas: [], internalLinks: [], backlinks: [], actions: [], contentRoadmap: null, brandNew: "default" });
const deps = { emptyBundle };
const ws = (id, url) => ({ id, url, country: "Kenya", scores: null });
const state = () => ({
  websites: [ws("a", "a.com"), ws("b", "b.com")],
  bundles: { a: { ...emptyBundle(), keywords: [{ keyword: "k" }], actions: [{ id: "x", status: "New" }], siteCrawl: { crawledAt: "2026-01-01", pagesCrawled: 5 }, siteAeoAnalysis: { x: 1 } }, b: { ...emptyBundle() } },
  currentWebsiteId: "b",
});

test("a backup round-trips exactly and carries the app id and format", () => {
  const file = createBackup(state(), new Date("2026-10-26T10:00:00Z"));
  assert.equal(file.app, "vertexrank"); assert.equal(file.format, BACKUP_FORMAT); assert.equal(file.exportedAt, "2026-10-26T10:00:00.000Z");
  const r = parseBackupText(JSON.stringify(file), deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.websites, state().websites);
  assert.equal(r.state.currentWebsiteId, "b");
  assert.deepEqual(r.state.bundles.a.keywords, [{ keyword: "k" }]);
  assert.equal(r.state.bundles.a.siteCrawl.crawlId.startsWith("legacy-"), true); // legacy crawl got an id on the way in
  assert.deepEqual(r.meta, { exportedAt: "2026-10-26T10:00:00.000Z", websites: 2, droppedWebsites: 0, pagesCrawled: 5, actions: 1 });
  assert.equal(backupFilename(new Date("2026-10-26T10:00:00Z")), "vertexrank-backup-2026-10-26.json");
});

test("anything that isn't a valid VertexRank backup is refused with a clear message", () => {
  const bad = [
    ["not json at all", /valid JSON/], ["[]", /isn't a VertexRank backup/], [JSON.stringify({ websites: [] }), /isn't a VertexRank backup/],
    [JSON.stringify({ app: "other", format: 1, websites: [] }), /isn't a VertexRank backup/],
    [JSON.stringify({ app: "vertexrank", websites: [] }), /format version/],
    [JSON.stringify({ app: "vertexrank", format: 99, websites: [] }), /newer version/],
    [JSON.stringify({ app: "vertexrank", format: 1 }), /list of websites/],
  ];
  for (const [text, re] of bad) { const r = parseBackupText(text, deps); assert.equal(r.ok, false, text); assert.match(r.error, re); }
  assert.equal(parseBackupText("x".repeat(100), deps, { maxBytes: 10 }).ok, false);
  assert.equal(parseBackupText(null, deps).ok, false);
});

test("import normalises like a normal load: missing fields get defaults, junk is dropped, unknown bundles ignored", () => {
  const messy = { app: "vertexrank", format: 1, websites: [ws("a", "a.com"), null, { url: "no-id.com" }, "str"], bundles: { a: { keywords: "nope", actions: [{ id: 1 }], scores: { aeo: 70 } }, ghost: { keywords: [{ keyword: "x" }] } }, currentWebsiteId: "missing" };
  const r = parseBackupText(JSON.stringify(messy), deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.websites.map((w) => w.id), ["a"]); assert.equal(r.meta.droppedWebsites, 3);
  assert.deepEqual(Object.keys(r.state.bundles), ["a"]); // the 'ghost' bundle has no website
  assert.deepEqual(r.state.bundles.a.keywords, []); assert.equal(r.state.bundles.a.brandNew, "default");
  assert.deepEqual(r.state.bundles.a.scores, { overall: null, aeo: 70 });
  assert.equal(r.state.currentWebsiteId, "a"); // invalid selection falls back to the first website
  assert.equal(normalizeWorkspace(null, deps), null);
});

test("backups from before the rename keep working (old brand relabelled)", () => {
  const old = JSON.stringify({ app: "vertexrank", format: 1, websites: [ws("a", "a.com")], bundles: { a: { siteAeoAnalysis: { source: "RankPilot AI Analysis" } } } });
  assert.equal(parseBackupText(old, deps).state.bundles.a.siteAeoAnalysis.source, "VertexRank AI Analysis");
});

test("hostile keys can't poison objects", () => {
  const text = '{"app":"vertexrank","format":1,"websites":[{"id":"a","url":"a.com"}],"bundles":{"a":{"__proto__":{"polluted":true},"keywords":[]}}}';
  const r = parseBackupText(text, deps);
  assert.equal(r.ok, true); assert.equal({}.polluted, undefined); assert.equal(r.state.bundles.a.polluted, undefined);
});

test("merge: adds only what is missing, never overwrites, keeps the current selection", () => {
  const current = { websites: [ws("a", "https://a.com/")], bundles: { a: { ...emptyBundle(), keywords: [{ keyword: "mine" }] } }, currentWebsiteId: "a" };
  const incoming = { websites: [ws("a", "a.com"), ws("z", "WWW-less.com"), ws("c", "a.com"), ws("d", "d.com")], bundles: { a: emptyBundle(), z: emptyBundle(), c: emptyBundle(), d: { ...emptyBundle(), keywords: [{ keyword: "theirs" }] } }, currentWebsiteId: "d" };
  const m = mergeWorkspaces(current, incoming);
  assert.deepEqual(m.websites.map((w) => w.id), ["a", "z", "d"]);
  assert.deepEqual(m.added, ["z", "d"]);
  assert.deepEqual(m.skipped.map((s) => s.reason), ["already exists", "a website with this URL already exists"]);
  assert.deepEqual(m.bundles.a.keywords, [{ keyword: "mine" }]); assert.deepEqual(m.bundles.d.keywords, [{ keyword: "theirs" }]);
  assert.equal(m.currentWebsiteId, "a");
  assert.equal(mergeWorkspaces({ websites: [], bundles: {}, currentWebsiteId: null }, incoming).currentWebsiteId, "a");
});

test("timeAgo", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  assert.equal(timeAgo("2026-10-26T11:59:30Z", now), "just now");
  assert.equal(timeAgo("2026-10-26T11:15:00Z", now), "45 minutes ago");
  assert.equal(timeAgo("2026-10-26T09:00:00Z", now), "3 hours ago");
  assert.equal(timeAgo("2026-10-23T12:00:00Z", now), "3 days ago");
  assert.equal(timeAgo("2026-10-25T12:00:00Z", now), "1 day ago");
  assert.equal(timeAgo("garbage", now), null); assert.equal(timeAgo(undefined, now), null);
});
