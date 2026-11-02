import { guardJson } from "../../../../lib/apiGuard";
import { serpStoreFromEnv } from "../../../../lib/serpStoreEnv";
import { errorResponse, siteHostFrom, keywordFrom } from "../../../../lib/serpRoutes";
import { StoreError, isUuid } from "../../../../lib/serpStore";

export const runtime = "nodejs";
export const maxDuration = 30;

// Manage the keywords tracked for one website: add, pause, resume, remove. (Listing with history is /api/serp/history.)
export async function POST(req) {
  const guard = await guardJson(req, "serpData");
  if (!guard.ok) return guard.response;
  const { action, id } = guard.body;
  try {
    const store = serpStoreFromEnv();
    if (action === "add") {
      const result = await store.addKeyword({ siteHost: siteHostFrom(guard.body), ...keywordFrom(guard.body) });
      return Response.json(result);
    }
    if (!isUuid(id)) throw new StoreError("BAD_REQUEST", "Unknown keyword.", 400);
    if (action === "pause" || action === "resume") { await store.setActive(id, action === "resume"); return Response.json({ ok: true }); }
    if (action === "remove") { await store.removeKeyword(id); return Response.json({ ok: true }); }
    throw new StoreError("BAD_REQUEST", "Unknown action.", 400);
  } catch (err) {
    return errorResponse(err);
  }
}
