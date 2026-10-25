// A deliberately small cheerio stand-in: just the API surface lib/siteCrawler.js uses
// (selectors: tag, [attr], [attr="v"], descendant/child/comma; first/filter/map/get/each/slice/clone/find/remove/text/attr/contents).
const VOID = new Set(["meta", "link", "img", "br", "hr", "input", "area", "base", "col", "source"]);

function parse(html, xml) {
  const root = { type: "root", children: [], parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\?[\s\S]*?\?>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^>]*?)?)(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) { // closing tag: pop to the matching open element
      let n = cur;
      while (n && n.type !== "root" && n.name !== m[1].toLowerCase()) n = n.parent;
      if (n && n.type !== "root") cur = n.parent;
    } else if (m[2]) {
      const name = m[2].toLowerCase();
      const attrs = {};
      const ar = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a;
      while ((a = ar.exec(m[3] || ""))) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
      const el = { type: "tag", name, attrs, children: [], parent: cur };
      cur.children.push(el);
      if (!m[4] && (xml || !VOID.has(name))) cur = el;
    } else if (m[5] !== undefined) {
      cur.children.push({ type: "text", data: m[5], parent: cur });
    }
  }
  return root;
}
const walk = (node, fn) => { for (const c of node.children || []) { if (c.type === "tag") fn(c); walk(c, fn); } };
const textOf = (n) => (n.type === "text" ? n.data : (n.children || []).map(textOf).join(""));
const deepCopy = (n, parent = null) => { const c = { ...n, parent }; if (n.children) c.children = n.children.map((k) => deepCopy(k, c)); if (n.attrs) c.attrs = { ...n.attrs }; return c; };

function parseSelector(sel) {
  return sel.split(",").map((part) => {
    const tokens = part.trim().replace(/\s*>\s*/g, " > ").split(/\s+/);
    const chain = []; let comb = " ";
    for (const t of tokens) {
      if (t === ">") { comb = ">"; continue; }
      const mm = /^([a-zA-Z][\w-]*)?((?:\[[^\]]+\])*)$/.exec(t);
      const attrs = [];
      const ar = /\[([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g; let a;
      while ((a = ar.exec(mm?.[2] || ""))) attrs.push([a[1].toLowerCase(), a[2] ?? a[3] ?? a[4]]);
      chain.push({ tag: mm?.[1]?.toLowerCase(), attrs, comb });
      comb = " ";
    }
    return chain;
  });
}
const compoundMatches = (n, c) => n.type === "tag" && (!c.tag || n.name === c.tag) && c.attrs.every(([k, v]) => (v === undefined ? k in n.attrs : n.attrs[k] === v));
function chainMatches(n, chain, i) {
  if (!compoundMatches(n, chain[i])) return false;
  if (i === 0) return true;
  const comb = chain[i].comb;
  if (comb === ">") return n.parent?.type === "tag" && chainMatches(n.parent, chain, i - 1);
  for (let p = n.parent; p && p.type === "tag"; p = p.parent) if (chainMatches(p, chain, i - 1)) return true;
  return false;
}

class Coll {
  constructor(nodes) { this.nodes = nodes; this.length = nodes.length; }
  first() { return new Coll(this.nodes.slice(0, 1)); }
  slice(a, b) { return new Coll(this.nodes.slice(a, b)); }
  text() { return this.nodes.map(textOf).join(""); }
  attr(k) { return this.nodes[0]?.attrs?.[k.toLowerCase()]; }
  each(fn) { this.nodes.forEach((n, i) => fn(i, n)); return this; }
  filter(fn) { return new Coll(this.nodes.filter((n, i) => (typeof fn === "function" ? fn(i, n) : true))); }
  map(fn) { return { get: () => this.nodes.map((n, i) => fn(i, n)).filter((v) => v !== null && v !== undefined) }; }
  get() { return this.nodes; }
  clone() { return new Coll(this.nodes.map((n) => deepCopy(n))); }
  find(sel) { const out = []; const chains = parseSelector(sel); this.nodes.forEach((root) => walk(root, (n) => { if (chains.some((c) => chainMatches(n, c, c.length - 1))) out.push(n); })); return new Coll(out); }
  remove() { this.nodes.forEach((n) => { if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n); }); return this; }
  contents() { return new Coll(this.nodes.flatMap((n) => n.children || [])); }
}

export function load(html) {
  const xmlMode = arguments[1]?.xmlMode;
  const root = parse(String(html), xmlMode);
  const $ = (arg) => {
    if (typeof arg === "string") {
      const out = []; const chains = parseSelector(arg);
      walk(root, (n) => { if (chains.some((c) => chainMatches(n, c, c.length - 1))) out.push(n); });
      return new Coll(out);
    }
    return arg instanceof Coll ? arg : new Coll([arg]);
  };
  return $;
}
