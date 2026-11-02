import { normalizeCountry } from "../../../lib/market";
import { guardJson } from "../../../lib/apiGuard";
import { callOpenRouterJson } from "../../../lib/openrouter";
import { cleanCalendarInput, buildLanePrompt, assembleCalendar, LANES, CALENDAR_SIZE } from "../../../lib/contentCalendar";

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel Hobby plan max

const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

// A 30-topic monthly calendar. Three model calls run in parallel (one "lane" each, 12 candidates per lane) so the whole thing fits
// in one request; code then validates, quality-gates, de-duplicates and schedules them. Returns fewer than 30 rather than padding
// with weak topics. Returns { calendar: { topics, rejectedCount, warnings, startDate, generatedAt } }.
export async function POST(req) {
  const guard = await guardJson(req, "aiHeavy");
  if (!guard.ok) return guard.response;
  const country = normalizeCountry(guard.body?.country); // validated against the fixed list: never free text into a prompt
  const input = cleanCalendarInput(guard.body);
  if (!input.site.domain) return Response.json({ error: "Run a full-site crawl first: the calendar is built from your real pages and data." }, { status: 400 });
  const startDate = input.startDate || tomorrow();

  const settled = await Promise.allSettled(LANES.map(async (lane) => {
    const { system, prompt } = buildLanePrompt(input, lane, country);
    const raw = await callOpenRouterJson({ system, prompt, maxTokens: 3000, temperature: 0.7, perModelTimeoutMs: 40000, overallBudgetMs: 54000 });
    return { laneId: lane.id, raw };
  }));
  const ok = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  if (ok.length === 0) return Response.json({ error: settled[0]?.reason?.message || "VertexRank AI couldn't build the calendar. Try again." }, { status: 502 });
  const warnings = settled.filter((s) => s.status === "rejected").map(() => "One part of the calendar couldn't be generated, so it has fewer topics. Run it again to fill the gaps.");

  const { topics, rejected } = assembleCalendar(ok, input, startDate);
  if (topics.length < CALENDAR_SIZE && warnings.length === 0) warnings.push(`Only ${topics.length} topics met the quality bar; weaker ones were dropped instead of padding the calendar. Generate again for more.`);
  return Response.json({ calendar: { topics, rejectedCount: rejected.length, warnings, startDate, generatedAt: new Date().toISOString() } });
}
