import { normalizeCountry } from "../../../lib/market";
import { guardJson } from "../../../lib/apiGuard";
import { callOpenRouterJson } from "../../../lib/openrouter";
import { cleanFixInput, buildFixPrompt, normalizeFix } from "../../../lib/recommendationFix";

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel Hobby plan max

// "Generate fix" for ANY recommendation (keyword, AEO, GEO, competitor, internal links, backlinks, action center, ...).
// Returns { fix: { headline, artifacts[], steps[], checks[], assumptions[], placeholders, unknownLinks[] }, kind }.
export async function POST(req) {
  const guard = await guardJson(req, "aiLight");
  if (!guard.ok) return guard.response;
  const country = normalizeCountry(guard.body?.country); // validated against the fixed list: never free text into a prompt
  const input = cleanFixInput(guard.body);
  if (!input) return Response.json({ error: "A recommendation is required." }, { status: 400 });
  const { kind, system, prompt } = buildFixPrompt(input, country);
  try {
    const raw = await callOpenRouterJson({ system, prompt, maxTokens: 2200, temperature: 0.35, perModelTimeoutMs: 30000, overallBudgetMs: 52000 });
    return Response.json({ fix: normalizeFix(raw, input.knownUrls), kind });
  } catch (err) {
    return Response.json({ error: err.message || "The fix couldn't be generated. Try again." }, { status: 502 });
  }
}
