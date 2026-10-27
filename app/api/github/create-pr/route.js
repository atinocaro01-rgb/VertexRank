import { guardJson } from "../../../../lib/apiGuard";
import { createPullRequest } from "../../../../lib/prBuilder";
import { clientFromEnv, parseTarget, siteUrlOf, errorResponse, summarizePlan } from "../../../../lib/githubApi";

export const runtime = "nodejs";
export const maxDuration = 60;

// Re-plans on the server (the browser never supplies file contents or diffs), then writes one commit on a NEW branch and
// opens a pull request. The base branch is never written to.
export async function POST(req) {
  const guard = await guardJson(req, "github");
  if (!guard.ok) return guard.response;
  const body = guard.body;
  const target = parseTarget(body);
  if (!target.ok) return Response.json({ error: target.error }, { status: 400 });
  const siteUrl = siteUrlOf(body.siteUrl);
  if (!siteUrl) return Response.json({ error: "The website address isn't valid." }, { status: 400 });
  if (!target.branch) return Response.json({ error: "A branch is required." }, { status: 400 });
  if (body.confirm !== true) return Response.json({ error: "Confirmation is required to create a pull request." }, { status: 400 });
  try {
    const res = await createPullRequest({
      client: clientFromEnv(), ...target, siteRoot: body.siteRoot, siteUrl, fixes: body.fixes, draft: body.draft === true,
      context: { findingTitle: typeof body.findingTitle === "string" ? body.findingTitle.slice(0, 200) : undefined },
    });
    if (!res.ok) return Response.json({ error: res.error.message, code: res.error.code, results: res.error.results }, { status: 422 });
    return Response.json({ pr: res.pr, branch: res.branch, ...summarizePlan(res.plan) });
  } catch (err) {
    return errorResponse(err);
  }
}
