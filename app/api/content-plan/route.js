import { callOpenRouterJson } from "../../../lib/openrouter";

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel Hobby plan max

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const { title, primaryKeyword, intent } = body || {};
  if (!title?.trim()) {
    return Response.json({ error: "A title is required." }, { status: 400 });
  }

  const system = `You are VertexRank AI, planning real, specific SEO content. Ground every suggestion in the title and keyword actually given — write like a strategist who understands this specific topic, not a generic template.`;

  const prompt = `Title: ${title}
Primary keyword: ${primaryKeyword?.trim() || "(not specified — infer one from the title)"}
Search intent: ${intent || "Informational"}

Respond with ONLY a JSON object — no markdown code fences, no commentary before or after — in exactly this shape:
{
  "secondaryKeywords": ["3 to 5 realistic related keyword phrases, each a short string"],
  "questions": ["3 to 5 real questions a reader or buyer would want this piece to answer"],
  "outline": ["4 to 6 section headings, in a logical reading order"],
  "aeoRecs": "1-2 concrete sentences of advice for making this page directly answerable by AI assistants",
  "geoRecs": "1-2 concrete sentences of advice for making this page well-cited by AI systems"
}`;

  try {
    const plan = await callOpenRouterJson({ system, prompt, maxTokens: 1000, temperature: 0.65 });
    return Response.json({ plan });
  } catch (err) {
    return Response.json({ error: err.message || "The content plan couldn't be generated. Try again." }, { status: 502 });
  }
}
