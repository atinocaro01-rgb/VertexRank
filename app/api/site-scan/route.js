import { crawlSite } from "../../../lib/siteCrawler";

// Crawls up to maxPages pages of a site (not just one), bounded by an
// internal time budget — see lib/siteCrawler.js for why both bounds exist.
// maxDuration matches the other multi-step routes in this app (aeo-analysis,
// geo-analysis, etc.), all of which use the Vercel Hobby plan's 60s ceiling;
// crawlSite's own default timeBudgetMs (45s) leaves real margin under it.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const url = body?.url;
  if (!url || typeof url !== "string") {
    return Response.json({ error: "That doesn't look like a valid URL." }, { status: 400 });
  }

  // Optional overrides, clamped to sane limits so a client can't request a
  // crawl that blows past the function's own time ceiling.
  const maxPages = Math.max(1, Math.min(Number(body?.maxPages) || 30, 60));

  const result = await crawlSite(url, { maxPages });

  if (result.error) {
    return Response.json({ error: result.error }, { status: 400 });
  }
  if (result.pagesCrawled === 0) {
    return Response.json(
      { error: "Couldn't reach any pages on that site. Check the URL and try again." },
      { status: 502 }
    );
  }

  return Response.json(result);
}
