// Builds the Search Console report VertexRank shows and mines for opportunities: totals (with the previous equal period
// for comparison), a daily series, top queries, top pages, query+page pairs (for cannibalisation), and device/country splits.
// Pure given a client (lib/gscClient.js), so it's tested with a fake one (tests/gscReport.test.mjs).
//
// Honest by construction: every report records its source, property, date range, fetch time and limitations. Search
// Console's "position" is an AVERAGE position, not a live rank; recent days can be incomplete (hence the 3-day lag);
// anonymised and very rare queries are left out by Google, so rows won't add up to the totals.

export const ALLOWED_DAYS = [7, 28, 90, 180];
export const DATA_LAG_DAYS = 3; // the most recent days are incomplete; end the range three days ago
export const LIMITS = { queries: 200, pages: 200, queryPages: 500, daily: 200, small: 10 };

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Current and previous equal-length ranges, ending DATA_LAG_DAYS before today (UTC). */
export function resolveRanges({ days = 28, nowMs = Date.now() } = {}) {
  const n = ALLOWED_DAYS.includes(Number(days)) ? Number(days) : 28;
  const today = Date.parse(`${iso(nowMs)}T00:00:00Z`);
  const end = today - DATA_LAG_DAYS * DAY;
  const start = end - (n - 1) * DAY;
  const prevEnd = start - DAY;
  const prevStart = prevEnd - (n - 1) * DAY;
  return { days: n, current: { startDate: iso(start), endDate: iso(end) }, previous: { startDate: iso(prevStart), endDate: iso(prevEnd) } };
}

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const metrics = (r) => ({ clicks: r.clicks, impressions: r.impressions, ctr: round(r.ctr, 4), position: round(r.position, 1) });
const empty = () => ({ clicks: 0, impressions: 0, ctr: 0, position: 0 });

const LIMITATIONS = [
  "Position is Google's average position over the period, not a live ranking: it varies by location, device and time.",
  "The most recent days are left out because Search Console data is incomplete for them.",
  "Google omits anonymised and very rare queries, so query and page rows won't add up to the totals.",
  "Search volume and keyword difficulty are not part of Search Console data.",
];

/**
 * Fetches everything for one property and period. `client` is a lib/gscClient.js client (or a fake with the same query()).
 * Requests run with limited concurrency to stay polite with Google's quotas.
 */
export async function buildReport({ client, siteUrl, days = 28, nowMs = Date.now() }) {
  const { current, previous, days: n } = resolveRanges({ days, nowMs });
  const jobs = {
    totals: () => client.query(siteUrl, { ...current, dimensions: [], rowLimit: 1 }),
    prevTotals: () => client.query(siteUrl, { ...previous, dimensions: [], rowLimit: 1 }),
    daily: () => client.query(siteUrl, { ...current, dimensions: ["date"], rowLimit: LIMITS.daily }),
    queries: () => client.query(siteUrl, { ...current, dimensions: ["query"], rowLimit: LIMITS.queries }),
    pages: () => client.query(siteUrl, { ...current, dimensions: ["page"], rowLimit: LIMITS.pages }),
    prevPages: () => client.query(siteUrl, { ...previous, dimensions: ["page"], rowLimit: LIMITS.pages }),
    queryPages: () => client.query(siteUrl, { ...current, dimensions: ["query", "page"], rowLimit: LIMITS.queryPages }),
    devices: () => client.query(siteUrl, { ...current, dimensions: ["device"], rowLimit: LIMITS.small }),
    countries: () => client.query(siteUrl, { ...current, dimensions: ["country"], rowLimit: LIMITS.small }),
  };
  const names = Object.keys(jobs);
  const out = {};
  let cursor = 0;
  async function worker() {
    while (cursor < names.length) {
      const name = names[cursor++];
      out[name] = await jobs[name]();
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));

  const one = (rows) => (rows[0] ? metrics(rows[0]) : empty());
  return {
    source: "Google Search Console",
    property: siteUrl,
    fetchedAt: new Date(nowMs).toISOString(),
    days: n, range: current, previousRange: previous,
    totals: one(out.totals), previousTotals: one(out.prevTotals),
    daily: out.daily.map((r) => ({ date: r.keys[0], ...metrics(r) })).sort((a, b) => (a.date < b.date ? -1 : 1)),
    queries: out.queries.map((r) => ({ query: r.keys[0], ...metrics(r) })),
    pages: out.pages.map((r) => ({ page: r.keys[0], ...metrics(r) })),
    previousPages: out.prevPages.map((r) => ({ page: r.keys[0], ...metrics(r) })),
    queryPages: out.queryPages.map((r) => ({ query: r.keys[0], page: r.keys[1], ...metrics(r) })),
    devices: out.devices.map((r) => ({ device: r.keys[0], ...metrics(r) })),
    countries: out.countries.map((r) => ({ country: r.keys[0], ...metrics(r) })),
    truncated: { queries: out.queries.length >= LIMITS.queries, pages: out.pages.length >= LIMITS.pages, queryPages: out.queryPages.length >= LIMITS.queryPages },
    limitations: LIMITATIONS,
  };
}

/**
 * Which Search Console property most likely belongs to a website URL? Prefers an exact URL-prefix property for the same
 * host (www or not), then a domain property for that exact domain, then one for a parent domain. Returns the property id or null.
 * It is only a suggestion: the person picks.
 */
export function suggestProperty(properties, websiteUrl) {
  let host;
  try { host = new URL(/^https?:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
  let best = null;
  for (const p of properties || []) {
    const id = p?.siteUrl;
    if (typeof id !== "string") continue;
    let rank = 0;
    if (id.startsWith("sc-domain:")) {
      const d = id.slice("sc-domain:".length).toLowerCase();
      rank = d === host ? 2 : host.endsWith(`.${d}`) ? 1 : 0;
    } else {
      try { rank = new URL(id).hostname.toLowerCase().replace(/^www\./, "") === host ? 3 : 0; } catch { rank = 0; }
    }
    if (rank > 0 && (!best || rank > best.rank)) best = { id, rank };
  }
  return best?.id ?? null;
}
