import { isCronRequest } from "../../../../lib/cronAuth";
import { serpStoreFromEnv } from "../../../../lib/serpStoreEnv";
import { serpFromEnv } from "../../../../lib/serpApi";
import { runScheduledChecks } from "../../../../lib/serpJob";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Daily scheduled rank checks, called by Vercel Cron (see vercel.json). Not behind the password: Vercel can't send one, so the
// middleware lets this single path through ONLY for a request carrying `Authorization: Bearer <CRON_SECRET>`, and this handler
// checks that again. Responds 200 with a status for everything that isn't a crash, so a missing database doesn't look like an outage.
export async function GET(req) {
  if (!isCronRequest(req.headers.get("authorization"), process.env)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const store = serpStoreFromEnv();
    if (!store.configured()) return Response.json({ status: "not_configured", note: "Rank history isn't set up (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)." });
    const result = await runScheduledChecks({ store, serp: serpFromEnv() });
    return Response.json(result);
  } catch (err) {
    console.error("[serp-cron] failed:", err?.name, err?.code, err?.message); // message only
    return Response.json({ status: "failed", note: err?.code ? String(err.message).slice(0, 200) : "The scheduled check failed. See the logs." }, { status: 500 });
  }
}
