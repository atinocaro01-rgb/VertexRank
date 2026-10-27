// Shared helpers for the /api/github/* routes: client creation from the environment, input parsing, error mapping.
// Kept out of the route files so the rules live in one tested place.

import { createGithubClient, GitHubError, isValidOwner, isValidRepo, isValidBranch, parseRepoUrl } from "./github.js";

export function clientFromEnv(env = process.env, fetchImpl) {
  return createGithubClient({ token: env.GITHUB_TOKEN, fetchImpl });
}

/** { ok:true, owner, repo, branch|null } from either { repoUrl } or { owner, repo } (+ optional branch). */
export function parseTarget(body) {
  let owner = body?.owner, repo = body?.repo, branch = body?.branch ?? null;
  if (body?.repoUrl) {
    const p = parseRepoUrl(body.repoUrl);
    if (!p) return { ok: false, error: "That doesn't look like a GitHub repository. Use owner/repo or a github.com URL." };
    owner = p.owner; repo = p.repo; branch = branch || p.branch;
  }
  if (!isValidOwner(owner) || !isValidRepo(repo)) return { ok: false, error: "Enter a valid GitHub owner and repository." };
  if (branch !== null && branch !== undefined && branch !== "" && !isValidBranch(branch)) return { ok: false, error: "That isn't a valid branch name." };
  return { ok: true, owner, repo, branch: branch || null };
}

/** The website's address as an absolute URL ("example.com" -> "https://example.com"). */
export function siteUrlOf(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 2048) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return null; // ftp://, file://… (not "host:port")
  try { const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; }
}

const STATUS = { NO_TOKEN: 503, BAD_TOKEN: 502, RATE_LIMIT: 429, FORBIDDEN: 403, NOT_FOUND: 404, INVALID: 400, TOO_LARGE: 413, NOT_UTF8: 422, NETWORK: 502, CONFLICT: 409, UNPROCESSABLE: 422 };

/** Turns anything thrown into a JSON Response. Only GitHubError messages (written for people, never containing the token) are shown. */
export function errorResponse(err) {
  if (err instanceof GitHubError) return Response.json({ error: err.message, code: err.code }, { status: STATUS[err.code] || 502 });
  console.error("[github] unexpected error:", err?.name, err?.message); // message only: never the request, never the token
  return Response.json({ error: "Something went wrong while talking to GitHub. Try again." }, { status: 500 });
}

/** A plan with the heavy fields removed: the browser gets diffs and stats, never whole files. */
export function summarizePlan(plan) {
  const slim = (f) => ({ path: f.path, diff: f.diff, stats: f.stats, fixIds: f.fixIds });
  return {
    results: plan.results, edits: plan.edits.map(slim), creates: plan.creates.map(slim), canCreate: plan.canCreate,
    analysis: { verdict: plan.analysis.verdict, warnings: plan.analysis.warnings, reasons: plan.analysis.reasons },
  };
}
