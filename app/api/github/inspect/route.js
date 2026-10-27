import { guardJson } from "../../../../lib/apiGuard";
import { analyzeTree, unsupportedAdvice } from "../../../../lib/repoInspect";
import { clientFromEnv, parseTarget, errorResponse } from "../../../../lib/githubApi";

export const runtime = "nodejs";
export const maxDuration = 60;

// Reads a repository's file listing and says whether it is a plain-HTML site this tool can safely fix, and where its web root is.
export async function POST(req) {
  const guard = await guardJson(req, "github");
  if (!guard.ok) return guard.response;
  const target = parseTarget(guard.body);
  if (!target.ok) return Response.json({ error: target.error }, { status: 400 });
  try {
    const client = clientFromEnv();
    const repo = await client.getRepo(target.owner, target.repo);
    const branch = target.branch || repo.defaultBranch;
    const head = await client.getBranchHead(target.owner, target.repo, branch);
    const tree = await client.getTree(target.owner, target.repo, head.treeSha);
    const analysis = analyzeTree(tree.entries);
    const warnings = [...analysis.warnings];
    if (tree.truncated) warnings.push("This repository is very large; the file listing was truncated, so the analysis may be incomplete.");
    if (repo.archived) warnings.push("This repository is archived (read-only), so a pull request can't be opened.");
    if (repo.canPush === false) warnings.push("The token can't push to this repository, so a pull request can't be opened until it has write access.");
    return Response.json({
      repo: { owner: target.owner, name: target.repo, defaultBranch: repo.defaultBranch, branch, private: repo.private, archived: repo.archived, canPush: repo.canPush },
      analysis: { ...analysis, warnings, advice: analysis.allowed ? "" : unsupportedAdvice(analysis.verdict) },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
