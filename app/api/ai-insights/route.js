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

  const { meta, issues, positives } = body || {};
  if (!meta?.domain) {
    return Response.json({ error: "Scan data is required. Run a scan first." }, { status: 400 });
  }

  const issuesList = (issues || [])
    .slice(0, 12)
    .map((i) => `- [${i.severity}] ${i.title} — ${i.why}`)
    .join("\n") || "(none found)";
  const positivesList = (positives || [])
    .map((p) => `- ${p.title}: ${p.detail}`)
    .join("\n") || "(none recorded)";
  const h2List = (meta.h2Texts || []).join(" | ") || "(none found)";

  const system = `You are VertexRank AI, a precise, detail-oriented SEO analyst. You write about the specific website you were given real data for — you never invent facts, features, prices, statistics, traffic numbers, or search volumes that aren't grounded in the provided content. If the provided content doesn't tell you something, say so plainly instead of guessing. Your tone is direct, specific, and opinionated like a consultant who actually read the page, not a generic template.`;

  const prompt = `Website: ${meta.domain}
Page title: "${meta.title || "(missing)"}"
Meta description: "${meta.metaDescription || "(missing)"}"
Main heading (H1): "${meta.h1Text || "(missing)"}"
Other headings on the page: ${h2List}
Visible page text (first part of the page, verbatim): "${meta.bodySnippet || "(page has very little visible text)"}"
Word count: ${meta.wordCount ?? "unknown"}

Audit issues found:
${issuesList}

What's already working well:
${positivesList}

Do three things:

1. SUMMARY: In 2-4 sentences, describe what this website/business actually does and who it's for, based only on the title, description, headings, and text above. If there isn't enough here to say something specific, say that honestly instead of inventing details.

2. QUICK WINS: Pick the 2-4 most impactful issues from the list above and write a concrete fix for each. Reference the REAL current text shown above where relevant as "before" (quote it or closely paraphrase it — don't invent a fictional "before"). Write a complete, ready-to-use "after" replacement that actually fits this specific business as described in the text above — not a generic template like "Our Services".

3. STRATEGIC INSIGHT: One paragraph, 120-180 words, direct and opinionated ("I'd start with...", "The biggest gap here is..."), based on the actual issues and positives above. Do NOT invent numbers — no traffic estimates, no search volume figures, no ranking positions, no percentages you can't support from what's given. You can recommend general content or topic directions grounded in what the site appears to be about.

Respond with ONLY a JSON object, no markdown code fences, no commentary before or after, in exactly this shape:
{
  "summary": "string",
  "quickWins": [
    { "title": "string", "category": "string", "severity": "string", "why": "string", "before": "string", "after": "string" }
  ],
  "strategicInsight": "string"
}`;

  try {
    const insights = await callOpenRouterJson({ system, prompt, maxTokens: 2000, temperature: 0.55 });
    if (!insights.summary || !Array.isArray(insights.quickWins) || !insights.strategicInsight) {
      throw new Error("VertexRank AI's response was missing required fields.");
    }
    return Response.json({ insights });
  } catch (err) {
    return Response.json({ error: err.message || "VertexRank AI couldn't generate insights. Try again." }, { status: 502 });
  }
}
