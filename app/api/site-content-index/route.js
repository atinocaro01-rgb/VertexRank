import { guardJson } from "../../../lib/apiGuard";
import { fetchContentIndex } from "../../../lib/contentIndexServer";

export const runtime = "nodejs";
export const maxDuration = 60;

// Lists what a site has already published (WordPress API, RSS/Atom feed, sitemap) so the content calendar can avoid repeating it.
// No AI involved. Returns { index: { posts: [{ title, url, date, source, titleFromSlug }], counts, notes, scannedAt } }.
export async function POST(req) {
  const guard = await guardJson(req, "contentIndex");
  if (!guard.ok) return guard.response;
  const url = guard.body?.url;
  if (!url || typeof url !== "string" || url.length > 2048) return Response.json({ error: "That doesn't look like a valid URL." }, { status: 400 });
  const result = await fetchContentIndex(url);
  if (result.error) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ index: result });
}
