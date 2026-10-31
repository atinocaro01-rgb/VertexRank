import { guardJson } from "../../../../lib/apiGuard";
import { gscFromEnv, errorResponse } from "../../../../lib/gscApi";

export const runtime = "nodejs";
export const maxDuration = 30;

// Which Search Console properties can the configured service account see? (Read-only.)
// Also reports whether Search Console is configured at all, and the e-mail to add under Settings → Users and permissions.
export async function POST(req) {
  const guard = await guardJson(req, "gsc");
  if (!guard.ok) return guard.response;
  try {
    const { auth, client } = gscFromEnv();
    if (!auth.configured()) {
      return Response.json({
        configured: false, properties: [],
        message: "Search Console isn't set up yet. Create a Google Cloud service account, enable the Search Console API, add the service account's key as GOOGLE_SERVICE_ACCOUNT_JSON, and add its e-mail to each Search Console property (see the README).",
      });
    }
    const properties = await client.listSites({ fresh: true });
    return Response.json({ configured: true, serviceAccountEmail: auth.serviceAccountEmail(), properties });
  } catch (err) {
    return errorResponse(err);
  }
}
