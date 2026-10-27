// Orchestrates the pull-request flow on top of a GitHub client (lib/github.js) and the pure pieces
// (repoInspect, htmlFixes, diff). Two operations:
//
//   planChanges        read-only: inspect the repo, map each fix to a file, verify and apply it IN MEMORY, return
//                      per-fix results and diffs. This is the preview. Nothing is written anywhere.
//   createPullRequest  runs planChanges again on the server (the browser never supplies diffs or file contents, so it
//                      can't smuggle in an edit), then writes ONE commit on a NEW branch and opens a pull request.
//
// Guarantees: the default/base branch is never written to; all files are read at one pinned commit so the plan is a
// consistent snapshot; unsupported repos are refused before any fix runs; fixes that fail verification are skipped and
// reported, never forced.

import { analyzeTree, pageUrlToFile, unsupportedAdvice } from "./repoInspect.js";
import { applyHtmlFix, buildFileFix, validateFix, PAGE_FIX_KINDS } from "./htmlFixes.js";
import { unifiedDiff } from "./diff.js";
import { GitHubError, isValidBranch, isValidRepoPath } from "./github.js";

export const LIMITS = { fixes: 40, files: 25, fileBytes: 1_000_000 };

const normRoot = (r) => String(r ?? "").trim().replace(/^\/+|\/+$/g, "");
const joinRoot = (root, p) => (root ? `${root}/${p}` : p);
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

const planError = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });

/**
 * Read-only plan. Returns { ok:true, baseSha, baseTreeSha, analysis, results[], edits[], creates[], canCreate } or { ok:false, error }.
 *   edits:   [{ path, before, after, diff, stats, fixIds }]
 *   creates: [{ path, content, diff, stats, fixIds }]
 */
export async function planChanges({ client, owner, repo, branch, siteRoot, siteUrl, fixes }) {
  if (!isValidBranch(branch)) return planError("INVALID", "That isn't a valid branch name.");
  const root = normRoot(siteRoot);
  if (root && !isValidRepoPath(root)) return planError("INVALID", "The site folder isn't a valid path.");
  if (!Array.isArray(fixes) || fixes.length === 0) return planError("INVALID", "Add at least one fix.");
  if (fixes.length > LIMITS.fixes) return planError("TOO_MANY", `At most ${LIMITS.fixes} fixes per pull request.`);

  const head = await client.getBranchHead(owner, repo, branch);
  const tree = await client.getTree(owner, repo, head.treeSha);
  if (tree.truncated) return planError("TOO_LARGE", "This repository is too large to inspect through the GitHub API.");
  const analysis = analyzeTree(tree.entries);
  if (!analysis.allowed) {
    return planError("UNSUPPORTED_REPO", unsupportedAdvice(analysis.verdict) || analysis.reasons.join(" "), { analysis });
  }

  const blobs = new Set(tree.entries.filter((e) => e.type === "blob").map((e) => e.path));
  const htmlFiles = new Set([...blobs].filter((p) => /\.html?$/i.test(p)));
  if (root && ![...htmlFiles].some((p) => p.startsWith(`${root}/`))) {
    return planError("BAD_ROOT", `No HTML files were found under "${root}/". Pick the folder that contains your site's index.html.`, { analysis });
  }

  const files = new Map(); // path -> { before, current, fixIds }
  const creates = new Map(); // path -> { content, note, fixIds }
  const results = [];

  async function load(path) {
    if (files.has(path)) return files.get(path);
    const f = await client.getFile(owner, repo, path, head.sha);
    if (!f) return null;
    if (f.size > LIMITS.fileBytes) throw new GitHubError("TOO_LARGE", `${path} is too large to edit (over 1 MB).`);
    const entry = { before: f.text, current: f.text, fixIds: [] };
    files.set(path, entry);
    return entry;
  }

  for (const raw of fixes) {
    const v = validateFix(raw, { siteUrl });
    if (!v.ok) { results.push({ id: String(raw?.id ?? "?").slice(0, 80), kind: String(raw?.kind ?? "?").slice(0, 40), ok: false, code: "INVALID", message: v.error }); continue; }
    const fix = v.fix;
    const base = { id: fix.id, kind: fix.kind, ...(fix.pageUrl ? { pageUrl: fix.pageUrl } : {}) };

    if (PAGE_FIX_KINDS.includes(fix.kind)) {
      const target = pageUrlToFile({ pageUrl: fix.pageUrl, siteRoot: root, htmlFiles });
      if (!target.ok) { results.push({ ...base, ok: false, code: target.code, message: target.message }); continue; }
      let entry;
      try { entry = await load(target.path); } catch (e) {
        if (e instanceof GitHubError && ["TOO_LARGE", "NOT_UTF8", "NOT_A_FILE"].includes(e.code)) { results.push({ ...base, file: target.path, ok: false, code: e.code, message: e.message }); continue; }
        throw e;
      }
      if (!entry) { results.push({ ...base, file: target.path, ok: false, code: "NOT_FOUND", message: `${target.path} couldn't be read.` }); continue; }
      const r = applyHtmlFix(entry.current, fix, { pageUrl: fix.pageUrl });
      if (!r.ok) { results.push({ ...base, file: target.path, ok: false, code: r.code, message: r.message }); continue; }
      entry.current = r.html;
      entry.fixIds.push(fix.id);
      results.push({ ...base, file: target.path, ok: true, ...(r.note ? { note: r.note } : {}) });
      continue;
    }

    // new file (robots.txt / sitemap.xml)
    const built = buildFileFix(fix, { siteUrl });
    if (!built.ok) { results.push({ ...base, ok: false, code: built.code, message: built.message }); continue; }
    const path = joinRoot(root, built.path);
    if (!isValidRepoPath(path)) { results.push({ ...base, ok: false, code: "INVALID", message: "The target path isn't valid." }); continue; }
    if (blobs.has(path)) { results.push({ ...base, file: path, ok: false, code: "ALREADY_EXISTS", message: `${path} already exists, so it won't be overwritten.` }); continue; }
    if (creates.has(path)) { results.push({ ...base, file: path, ok: false, code: "DUPLICATE", message: `${path} is already being created by another fix in this pull request.` }); continue; }
    creates.set(path, { content: built.content, fixIds: [fix.id] });
    results.push({ ...base, file: path, ok: true, note: built.note });
  }

  const edits = [];
  for (const [path, e] of files) {
    if (e.current === e.before) continue;
    const { diff, stats } = unifiedDiff(e.before, e.current, path);
    edits.push({ path, before: e.before, after: e.current, diff, stats, fixIds: e.fixIds });
  }
  const createList = [...creates].map(([path, c]) => ({ path, content: c.content, ...unifiedDiff("", c.content, path), fixIds: c.fixIds }));
  if (edits.length + createList.length > LIMITS.files) return planError("TOO_MANY", `This would change ${edits.length + createList.length} files; at most ${LIMITS.files} per pull request.`);

  return {
    ok: true, baseSha: head.sha, baseTreeSha: head.treeSha, analysis, results, edits, creates: createList,
    canCreate: edits.length + createList.length > 0,
  };
}

/* ------------------------------------------------------------------ */
/* pull request                                                       */
/* ------------------------------------------------------------------ */

const mdCell = (s, max = 120) => clean(s, max).replace(/\|/g, "\\|").replace(/`/g, "'").replace(/</g, "&lt;");

const KIND_LABEL = {
  set_title: "Page title", set_meta_description: "Meta description", set_canonical: "Canonical URL", set_lang: "Page language",
  add_image_alt: "Image alt text", add_jsonld: "Structured data", remove_noindex: "Remove noindex", replace_href: "Update link",
  create_robots_txt: "Create robots.txt", create_sitemap_xml: "Create sitemap.xml",
};

export function buildPrBody({ siteUrl, plan, context = {} }) {
  const applied = plan.results.filter((r) => r.ok);
  const skipped = plan.results.filter((r) => !r.ok);
  const lines = [];
  lines.push(`## SEO fixes for ${mdCell(siteUrl, 200)}`, "");
  lines.push(`Prepared by VertexRank${context.findingTitle ? ` for: **${mdCell(context.findingTitle, 200)}**` : ""}. Please review every diff before merging.`, "");
  lines.push("| Fix | Page / file | What changed |", "|---|---|---|");
  for (const r of applied) lines.push(`| ${mdCell(KIND_LABEL[r.kind] || r.kind)} | ${mdCell(r.pageUrl ? `${r.pageUrl} → ${r.file}` : r.file, 200)} | ${mdCell(r.note || "Updated")} |`);
  lines.push("", "### Safety checks", "");
  lines.push("- Each edit was checked against the file's current contents **and** against what VertexRank's crawler saw on the live page. A fix that didn't match (a sign the page is built or changed by JavaScript or a build step) was skipped, not forced.");
  lines.push("- Edits are minimal text changes: formatting, indentation and line endings elsewhere in each file are untouched.");
  lines.push(`- Changed files: ${[...plan.edits, ...plan.creates].map((f) => `\`${f.path}\``).join(", ")}.`);
  if (plan.analysis.warnings.length) lines.push("", "### Heads-up", "", ...plan.analysis.warnings.map((w) => `- ${mdCell(w, 400)}`));
  if (skipped.length) {
    lines.push("", "### Skipped (not changed)", "");
    for (const r of skipped.slice(0, 20)) lines.push(`- ${mdCell(KIND_LABEL[r.kind] || r.kind)}${r.pageUrl ? ` on ${mdCell(r.pageUrl, 200)}` : ""}: ${mdCell(r.message, 300)}`);
    if (skipped.length > 20) lines.push(`- …and ${skipped.length - 20} more.`);
  }
  lines.push("", "### After merging", "", "Once the site is deployed, re-crawl it in VertexRank to confirm the findings are gone.");
  return lines.join("\n").slice(0, 60000);
}

function branchName(now = new Date(), rand = Math.random) {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `vertexrank/fixes-${stamp}-${Math.floor(rand() * 0xffff).toString(16).padStart(4, "0")}`;
}

/**
 * Plans (again, server-side), then writes one commit on a new branch and opens the pull request.
 * Returns { ok:true, pr:{number,url}, branch, plan } or { ok:false, error }.
 * Only fixes that passed verification are included; skipped ones are listed in the PR description.
 */
export async function createPullRequest({ client, owner, repo, branch, siteRoot, siteUrl, fixes, draft = false, context = {}, now = new Date(), rand = Math.random }) {
  const plan = await planChanges({ client, owner, repo, branch, siteRoot, siteUrl, fixes });
  if (!plan.ok) return plan;
  if (!plan.canCreate) return planError("NOTHING_TO_DO", "None of the fixes could be applied, so there is nothing to put in a pull request. See the reasons for each fix.", { results: plan.results });

  const changed = [...plan.edits.map((e) => ({ path: e.path, content: e.after })), ...plan.creates.map((c) => ({ path: c.path, content: c.content }))];
  const nApplied = plan.results.filter((r) => r.ok).length;
  const title = clean(context.findingTitle ? `${context.findingTitle} (VertexRank)` : `SEO fixes from VertexRank (${nApplied} change${nApplied === 1 ? "" : "s"})`, 200);
  const message = `${title}\n\nAutomated SEO fixes prepared by VertexRank. Review before merging.`;

  const commit = await client.createCommit(owner, repo, { baseSha: plan.baseSha, baseTreeSha: plan.baseTreeSha, files: changed, message });

  let name = branchName(now, rand);
  if (name === branch) name += "-new"; // can never equal the base branch
  try {
    await client.createBranch(owner, repo, name, commit.sha);
  } catch (e) {
    if (!(e instanceof GitHubError) || e.code !== "UNPROCESSABLE") throw e;
    name = branchName(now, rand) + "-b"; // name collision: one retry with a different suffix
    await client.createBranch(owner, repo, name, commit.sha);
  }

  const pr = await client.createPull(owner, repo, { title, body: buildPrBody({ siteUrl, plan, context }), head: name, base: branch, draft });
  return { ok: true, pr, branch: name, plan };
}
