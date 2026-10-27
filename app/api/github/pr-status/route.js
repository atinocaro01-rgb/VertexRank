import { guardJson } from "../../../../lib/apiGuard";
import { clientFromEnv, parseTarget, errorResponse } from "../../../../lib/githubApi";

export const runtime = "nodejs";
export const maxDuration = 30;

// Is a pull request still open, merged, or closed without merging? Used to keep the Action Center honest.
export async function POST(req) {
  const guard = await guardJson(req, "github");
  if (!guard.ok) return guard.response;
  const target = parseTarget(guard.body);
  if (!target.ok) return Response.json({ error: target.error }, { status: 400 });
  const number = guard.body.number;
  if (!Number.isInteger(number) || number < 1) return Response.json({ error: "A pull request number is required." }, { status: 400 });
  try {
    const pr = await clientFromEnv().getPull(target.owner, target.repo, number);
    return Response.json({ number: pr.number, state: pr.state, merged: pr.merged, mergedAt: pr.mergedAt, closedAt: pr.closedAt, url: pr.url });
  } catch (err) {
    return errorResponse(err);
  }
}
