import test from "node:test";
import assert from "node:assert/strict";
import { unifiedDiff } from "../lib/diff.js";

test("identical text -> empty diff", () => { const r = unifiedDiff("a\nb\n", "a\nb\n", "x.html"); assert.equal(r.diff, ""); assert.deepEqual(r.stats, { added: 0, removed: 0 }); });

test("a one-line change shows exactly that line with context and correct hunk numbers", () => {
  const old = ["<html>", "<head>", "  <title>Old</title>", "  <meta charset=utf-8>", "</head>", "<body>", "x", "y", "z", "</body>", "</html>"].join("\n") + "\n";
  const neu = old.replace("Old", "New");
  const r = unifiedDiff(old, neu, "index.html");
  assert.deepEqual(r.stats, { added: 1, removed: 1 });
  assert.equal(r.diff, ["--- a/index.html", "+++ b/index.html", "@@ -1,6 +1,6 @@", " <html>", " <head>", "-  <title>Old</title>", "+  <title>New</title>", "   <meta charset=utf-8>", " </head>", " <body>", ""].join("\n"));
});

test("insertions and a new file", () => {
  const r = unifiedDiff("<head>\n</head>\n", "<head>\n  <title>T</title>\n</head>\n", "i.html");
  assert.deepEqual(r.stats, { added: 1, removed: 0 }); assert.match(r.diff, /@@ -1,2 \+1,3 @@\n <head>\n\+  <title>T<\/title>\n <\/head>/);
  const f = unifiedDiff("", "a\nb\n", "robots.txt");
  assert.match(f.diff, /^--- \/dev\/null\n\+\+\+ b\/robots.txt\n@@ -0,0 \+1,2 @@\n\+a\n\+b\n$/); assert.deepEqual(f.stats, { added: 2, removed: 0 });
});

test("distant changes become separate hunks; CRLF files diff cleanly", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const neu = [...lines]; neu[2] = "CHANGED A"; neu[35] = "CHANGED B";
  const r = unifiedDiff(lines.join("\n") + "\n", neu.join("\n") + "\n", "f");
  assert.equal(r.diff.match(/^@@/gm).length, 2); assert.deepEqual(r.stats, { added: 2, removed: 2 });
  const crlf = unifiedDiff("a\r\nb\r\n", "a\r\nB\r\n", "f"); assert.deepEqual(crlf.stats, { added: 1, removed: 1 }); assert.ok(!crlf.diff.includes("\r"));
});
