// A small HTML tag scanner. It finds where tags and attributes sit in the SOURCE TEXT so fixes can be made as
// precise string splices. We deliberately do NOT parse-and-reserialise the HTML: that would reformat the whole file
// (indentation, quoting, attribute order, entities) and bury the real change in a huge, unreviewable diff.
//
// Handles what real hand-written HTML throws at it: comments, doctype, uppercase tags, quoted attributes that contain
// ">", unquoted and valueless attributes, self-closing tags, and raw-text elements (<script>, <style>, <textarea>,
// <title>) whose contents must not be scanned for tags. It is a scanner, not a validator: broken markup yields a best
// effort and callers must treat "couldn't find it" as "refuse to edit".

const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const NAME = /[A-Za-z][A-Za-z0-9:_-]*/y;
const ATTR_NAME = /[^\s"'<>\/=]+/y;
const UNQUOTED = /[^\s>]+/y;

function stickyMatch(re, text, pos) {
  re.lastIndex = pos;
  const m = re.exec(text);
  return m && m.index === pos ? m[0] : null;
}

/**
 * Returns every tag in document order:
 *   opening/self-closing: { name, closing:false, start, end, selfClosing, attrs:[{name, nameLower, value, quote, start, end, valueStart, valueEnd}] }
 *   closing:              { name, closing:true, start, end }
 * `start`/`end` are string indices (end exclusive). Names are lowercased.
 */
export function scanTags(html) {
  const text = String(html ?? "");
  const n = text.length;
  const tags = [];
  let i = 0;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    if (text.startsWith("<!--", lt)) {
      const e = text.indexOf("-->", lt + 4);
      i = e === -1 ? n : e + 3;
      continue;
    }
    const c1 = text[lt + 1];
    if (c1 === "!" || c1 === "?") {
      const e = text.indexOf(">", lt);
      i = e === -1 ? n : e + 1;
      continue;
    }
    if (c1 === "/") {
      const name = stickyMatch(NAME, text, lt + 2);
      if (!name) { i = lt + 1; continue; }
      const e = text.indexOf(">", lt);
      if (e === -1) break;
      tags.push({ name: name.toLowerCase(), closing: true, start: lt, end: e + 1 });
      i = e + 1;
      continue;
    }
    const name = stickyMatch(NAME, text, lt + 1);
    if (!name) { i = lt + 1; continue; } // a bare "<" in text

    // attributes
    let p = lt + 1 + name.length;
    const attrs = [];
    let selfClosing = false;
    let closed = false;
    while (p < n) {
      while (p < n && /\s/.test(text[p])) p++;
      if (p >= n) break;
      if (text[p] === ">") { p++; closed = true; break; }
      if (text[p] === "/") {
        if (text[p + 1] === ">") { selfClosing = true; p += 2; closed = true; break; }
        p++;
        continue;
      }
      const an = stickyMatch(ATTR_NAME, text, p);
      if (!an) { p++; continue; }
      const attr = { name: an, nameLower: an.toLowerCase(), value: null, quote: null, start: p, end: p + an.length, valueStart: -1, valueEnd: -1 };
      p += an.length;
      let q = p;
      while (q < n && /\s/.test(text[q])) q++;
      if (text[q] === "=") {
        q++;
        while (q < n && /\s/.test(text[q])) q++;
        const ch = text[q];
        if (ch === '"' || ch === "'") {
          const close = text.indexOf(ch, q + 1);
          const vEnd = close === -1 ? n : close;
          attr.quote = ch; attr.valueStart = q + 1; attr.valueEnd = vEnd; attr.value = text.slice(q + 1, vEnd);
          attr.end = close === -1 ? n : close + 1;
          p = attr.end;
        } else {
          const v = stickyMatch(UNQUOTED, text, q) || "";
          attr.value = v; attr.valueStart = q; attr.valueEnd = q + v.length; attr.end = q + v.length;
          p = attr.end;
        }
      }
      attrs.push(attr);
    }
    if (!closed) break; // unterminated tag at end of file
    const tag = { name: name.toLowerCase(), closing: false, start: lt, end: p, selfClosing, attrs };
    tags.push(tag);
    i = p;
    if (RAW_TEXT.has(tag.name) && !selfClosing) {
      const re = new RegExp(`</${tag.name}[\\s>/]`, "ig");
      re.lastIndex = p;
      const m = re.exec(text);
      i = m ? m.index : n;
    }
  }
  return tags;
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}
/** Decoded, whitespace-collapsed, trimmed — the form used to compare what the crawler saw with what the file says. */
export const normalizeText = (s) => decodeEntities(s).replace(/\s+/g, " ").trim();
export const escapeText = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const escapeAttr = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const getAttr = (tag, name) => tag.attrs?.find((a) => a.nameLower === name.toLowerCase()) || null;
export const attrValue = (tag, name) => { const a = getAttr(tag, name); return a && a.value !== null ? decodeEntities(a.value) : null; };

/** Applies non-overlapping splices ({start,end,text}) to `html`. */
export function applySplices(html, splices) {
  let out = html;
  for (const s of [...splices].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

/** "\r\n" if the file uses Windows line endings, else "\n". */
export const detectEol = (text) => (/\r\n/.test(text) ? "\r\n" : "\n");
