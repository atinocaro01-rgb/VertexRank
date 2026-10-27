import { guardJson } from "../../../../lib/apiGuard";
import { planChanges } from "../../../../lib/prBuilder";
import { clientFromEnv, parseTarget, siteUrlOf, errorResponse, summarizePlan } from "../../../../lib/githubApi";

export const runtime = "nodejs";
export const maxDuration = 60;

// Read-only preview: which fixes can be applied, which are blocked and why, and the exact diffs. Writes nothing.
export async function POST(req) {
  const guard = await guardJson(req, "github");
  if (!guard.ok) return guard.response;
  const body = guard.body;
  const target = parseTarget(body);
  if (!target.ok) return Response.json({ error: target.error }, { status: 400 });
  const siteUrl = siteUrlOf(body.siteUrl);
  if (!siteUrl) return Response.json({ error: "The website address isn't valid." }, { status: 400 });
  if (!target.branch) return Response.json({ error: "A branch is required." }, { status: 400 });
  try {
    const plan = await planChanges({ client: clientFromEnv(), ...target, siteRoot: body.siteRoot, siteUrl, fixes: body.fixes });
    if (!plan.ok) return Response.json({ error: plan.error.message, code: plan.error.code, analysis: plan.error.analysis ? { verdict: plan.error.analysis.verdict, reasons: plan.error.analysis.reasons } : undefined }, { status: 422 });
    return Response.json(summarizePlan(plan));
  } catch (err) {
    return errorResponse(err);
  }
}
