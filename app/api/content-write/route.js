import { normalizeCountry } from "../../../lib/market";
import { guardJson } from "../../../lib/apiGuard";
import { callOpenRouterJson } from "../../../lib/openrouter";
import { cleanWriteInput, buildWritePrompt, normalizePart1, normalizePart2 } from "../../../lib/articleWriter";

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel Hobby plan max

// Writes ONE half of an article draft per request (part 1: plan + first half; part 2: the rest + FAQ + conclusion), so each call fits
// the time limit and a long piece stays coherent. Facts come only from the source excerpts and the owner's first-hand input sent in
// the body; see lib/articleWriter.js for the rules. Returns { part, draft }.
export async function POST(req) {
  const guard = await guardJson(req, "aiLight");
  if (!guard.ok) return guard.response;
  const country = normalizeCountry(guard.body?.country); // validated against the fixed list: never free text into a prompt
  const input = cleanWriteInput(guard.body);
  if (!input) return Response.json({ error: "A topic is required." }, { status: 400 });
  const { system, prompt } = buildWritePrompt(input, country);
  try {
    const raw = await callOpenRouterJson({ system, prompt, maxTokens: 2800, temperature: 0.55, perModelTimeoutMs: 45000, overallBudgetMs: 55000 });
    return Response.json({ part: input.part, draft: input.part === 1 ? normalizePart1(raw) : normalizePart2(raw) });
  } catch (err) {
    return Response.json({ error: err.message || "The article couldn't be written. Try again." }, { status: 502 });
  }
}
