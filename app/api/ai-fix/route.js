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

  const issue = body?.issue;
  const meta = body?.meta || {};
  if (!issue?.title) {
    return Response.json({ error: "An issue is required." }, { status: 400 });
  }

  const system = `You are VertexRank AI, a precise SEO engineer fixing a real, specific issue on a real website. You use the real page content you're given — the actual current title, description, headings, and text — rather than inventing a generic fictional business. If the issue already includes the real current text as "before", reuse it exactly rather than making up a different one.`;

  const prompt = `Website: ${meta.domain || "(unknown)"}
Page title: "${meta.title || "(missing)"}"
Meta description: "${meta.metaDescription || "(missing)"}"
Main heading (H1): "${meta.h1Text || "(missing)"}"
Visible page text (first part of the page): "${meta.bodySnippet ? meta.bodySnippet.slice(0, 500) : "(not available)"}"

Issue to fix: ${issue.title}
Category: ${issue.category || "General"}
Severity: ${issue.severity || "Medium"}
Why it matters: ${issue.why || "Not specified."}
Recommended direction: ${issue.fix || "Not specified."}
Real current content related to this issue: ${issue.before || "(not available — infer from the page content above)"}

Write a specific, realistic fix for this exact issue on this exact website. Respond with ONLY a JSON object — no markdown code fences, no commentary before or after — in exactly this shape:
{
  "before": "the real current code/content this issue refers to — reuse the 'real current content' above if given, otherwise describe the real absence (e.g. 'no <title> tag found')",
  "after": "a complete, ready-to-use replacement that fits THIS specific website's actual business, under 40 words",
  "explanation": "2-3 sentences explaining what changed and why it resolves the issue for this specific page"
}`;

  try {
    const fix = await callOpenRouterJson({ system, prompt, maxTokens: 700, temperature: 0.4 });
    if (!fix.before || !fix.after || !fix.explanation) {
      throw new Error("VertexRank AI's response was missing required fields.");
    }
    return Response.json({ fix });
  } catch (err) {
    return Response.json({ error: err.message || "The AI fix couldn't be generated. Try again." }, { status: 502 });
  }
}
