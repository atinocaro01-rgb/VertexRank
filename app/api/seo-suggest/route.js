import { guardJson } from "../../../lib/apiGuard";
import { callOpenRouterJson } from "../../../lib/openrouter";
import { generateSuggestions, MAX_ITEMS_PER_CALL } from "../../../lib/seoSuggestions";
import { normalizeCountry } from "../../../lib/market";

export const runtime = "nodejs";
export const maxDuration = 60;

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

// Drafts titles / meta descriptions for the pull-request dialog from the page content VertexRank already crawled.
// Nothing is applied here: the person reviews and edits each suggestion, previews the diff, and only then creates a PR.
export async function POST(req) {
  const guard = await guardJson(req, "aiLight");
  if (!guard.ok) return guard.response;
  const body = guard.body;

  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_ITEMS_PER_CALL) {
    return Response.json({ error: `Send between 1 and ${MAX_ITEMS_PER_CALL} items.` }, { status: 400 });
  }
  const items = [];
  for (const it of body.items) {
    if (!it || typeof it !== "object" || !str(it.id, 80) || !["title", "description"].includes(it.kind)) {
      return Response.json({ error: "Each item needs an id and a kind (title or description)." }, { status: 400 });
    }
    items.push({
      id: str(it.id, 80), kind: it.kind, url: str(it.url, 2048), title: str(it.title, 300), metaDescription: str(it.metaDescription, 600),
      h1Text: str(it.h1Text, 300), h2Texts: Array.isArray(it.h2Texts) ? it.h2Texts.slice(0, 6).map((h) => str(h, 150)) : [], snippet: str(it.snippet, 2000),
    });
  }
  const avoid = Array.isArray(body.avoid) ? body.avoid.slice(0, 80).map((a) => str(a, 300)).filter(Boolean) : [];

  try {
    const result = await generateSuggestions({
      items, avoid, domain: str(body.domain, 200), country: normalizeCountry(body.country),
      callModel: (args) => callOpenRouterJson(args),
    });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err.message || "Suggestions couldn't be generated. Try again." }, { status: 502 });
  }
}
