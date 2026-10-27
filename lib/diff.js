// Unified diffs for the pull-request preview. Line-based; trims the unchanged prefix/suffix first (our edits are small
// splices, so the changed region is tiny), then an LCS over what's left. Falls back to one replace-block for huge
// changes rather than burning memory.

const splitLines = (t) => (t === "" ? [] : String(t).replace(/\r\n/g, "\n").split("\n"));

export function unifiedDiff(oldText, newText, path, context = 3) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // a trailing newline yields a final empty element; drop it from both so it doesn't register as a change
  if (a.length && a[a.length - 1] === "") a.pop();
  if (b.length && b[b.length - 1] === "") b.pop();

  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  const ops = [];
  for (let i = 0; i < pre; i++) ops.push([" ", a[i]]);
  if (am.length * bm.length > 4_000_000) {
    am.forEach((l) => ops.push(["-", l]));
    bm.forEach((l) => ops.push(["+", l]));
  } else {
    const n = am.length, m = bm.length, w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push([" ", am[i]]); i++; j++; }
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) { ops.push(["-", am[i++]]); }
      else { ops.push(["+", bm[j++]]); }
    }
    while (i < n) ops.push(["-", am[i++]]);
    while (j < m) ops.push(["+", bm[j++]]);
  }
  for (let i = a.length - suf; i < a.length; i++) ops.push([" ", a[i]]);

  const stats = { added: ops.filter((o) => o[0] === "+").length, removed: ops.filter((o) => o[0] === "-").length };
  if (stats.added === 0 && stats.removed === 0) return { diff: "", stats };

  // group changes (plus context) into hunks
  const changeIdx = ops.map((o, k) => (o[0] === " " ? -1 : k)).filter((k) => k >= 0);
  const hunks = [];
  let cur = null;
  for (const k of changeIdx) {
    const from = Math.max(0, k - context), to = Math.min(ops.length - 1, k + context);
    if (cur && from <= cur.to + 1) cur.to = to; else { cur = { from, to }; hunks.push(cur); }
  }
  const out = [oldText === "" ? "--- /dev/null" : `--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks) {
    let oldStart = 1, newStart = 1;
    for (let k = 0; k < h.from; k++) { if (ops[k][0] !== "+") oldStart++; if (ops[k][0] !== "-") newStart++; }
    const slice = ops.slice(h.from, h.to + 1);
    const oldLen = slice.filter((o) => o[0] !== "+").length, newLen = slice.filter((o) => o[0] !== "-").length;
    out.push(`@@ -${oldLen === 0 ? oldStart - 1 : oldStart},${oldLen} +${newLen === 0 ? newStart - 1 : newStart},${newLen} @@`);
    for (const [t, line] of slice) out.push(t + line);
  }
  return { diff: out.join("\n") + "\n", stats };
}
