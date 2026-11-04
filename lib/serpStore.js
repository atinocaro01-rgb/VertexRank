// Rank-history storage on Supabase Postgres, through its REST API (PostgREST) with fetch — no extra dependency.
// Server-only: it uses SUPABASE_SERVICE_ROLE_KEY, which bypasses Row Level Security, so it must never reach the browser.
// The tables are created by db/serp_history.sql. `fetch` is injectable (tests/serpStore.test.mjs).
//
// Identity: VertexRank sits behind one shared password (a personal, single-owner deployment), so data is keyed by the
// website's host, not by a user. If this ever becomes multi-user, add an owner column and filter on it here.

export class StoreError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "StoreError";
    this.code = code; // NOT_CONFIGURED | BAD_CONFIG | BAD_REQUEST | LIMIT | AUTH_FAILED | NO_TABLES | UNREACHABLE | DB
    this.status = status;
  }
}

export const MAX_TRACKED_PER_SITE = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === "string" && UUID.test(v);
export const isSiteHost = (v) => typeof v === "string" && /^[a-z0-9.-]{1,253}$/.test(v) && !v.startsWith(".") && !v.includes("..");
const enc = encodeURIComponent;

const camelKeyword = (r) => ({ id: r.id, siteHost: r.site_host, query: r.query, country: r.country, device: r.device, active: !!r.active, lastCheckedAt: r.last_checked_at || null, createdAt: r.created_at });
const camelSnapshot = (r) => ({ keywordId: r.keyword_id, checkedAt: r.checked_at, position: r.position ?? null, rankingUrl: r.ranking_url || null, provider: r.provider, trigger: r.trigger });

export function createStore({ env = process.env, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const rawUrl = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.trim().replace(/\/+$/, "") : "";
  const key = typeof env.SUPABASE_SERVICE_ROLE_KEY === "string" ? env.SUPABASE_SERVICE_ROLE_KEY.trim() : "";
  const configured = () => !!(rawUrl && key);

  async function rest(method, path, { body, prefer, headers = {}, raw = false } = {}) {
    if (!configured()) throw new StoreError("NOT_CONFIGURED", "Rank history isn't set up yet. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server, then run db/serp_history.sql in Supabase.", 503);
    if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(rawUrl)) throw new StoreError("BAD_CONFIG", "SUPABASE_URL should look like https://your-project.supabase.co.", 503);
    let res;
    try {
      res = await doFetch(`${rawUrl}/rest/v1/${path}`, {
        method,
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(prefer ? { Prefer: prefer } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new StoreError("UNREACHABLE", "Couldn't reach the database. A free Supabase project pauses after 7 days without activity: open the Supabase dashboard and resume it.", 502);
    }
    if (res.status === 401 || res.status === 403) throw new StoreError("AUTH_FAILED", "The database rejected the key. Check SUPABASE_SERVICE_ROLE_KEY (the service_role key, not the anon key).", 502);
    if (!res.ok) {
      let code = ""; try { code = (await res.json())?.code || ""; } catch { /* no body */ }
      if (res.status === 404 || code === "PGRST205" || code === "42P01") throw new StoreError("NO_TABLES", "The rank-history tables don't exist yet. Run db/serp_history.sql in the Supabase SQL editor.", 503);
      if (res.status === 503 || res.status === 522 || res.status === 544) throw new StoreError("UNREACHABLE", "The database isn't responding. If the project is paused, resume it in the Supabase dashboard.", 502);
      throw new StoreError("DB", `The database returned an error (${res.status}). Try again.`, 502);
    }
    if (raw) return res;
    if (res.status === 204) return [];
    try { return await res.json(); } catch { return []; }
  }

  return {
    configured,

    async listKeywords(siteHost) {
      if (!isSiteHost(siteHost)) throw new StoreError("BAD_REQUEST", "That isn't a valid website.", 400);
      return (await rest("GET", `tracked_keywords?site_host=eq.${enc(siteHost)}&order=created_at.asc&limit=100`)).map(camelKeyword);
    },
    async listActiveKeywords(limit = 500) {
      return (await rest("GET", `tracked_keywords?active=eq.true&order=last_checked_at.asc.nullsfirst&limit=${Math.min(1000, limit)}`)).map(camelKeyword);
    },
    async findKeyword({ siteHost, query, country, device }) {
      if (!isSiteHost(siteHost)) return null;
      const rows = await rest("GET", `tracked_keywords?site_host=eq.${enc(siteHost)}&query=eq.${enc(query)}&country=eq.${enc(country)}&device=eq.${enc(device)}&limit=1`);
      return rows[0] ? camelKeyword(rows[0]) : null;
    },
    async getKeywords(ids) {
      const good = (Array.isArray(ids) ? ids : []).filter(isUuid).slice(0, 25);
      if (!good.length) return [];
      return (await rest("GET", `tracked_keywords?id=in.(${good.join(",")})&limit=25`)).map(camelKeyword);
    },
    /** Adds a keyword. { created: false } when the same siteHost/query/country/device is already tracked. */
    async addKeyword({ siteHost, query, country, device }) {
      if (!isSiteHost(siteHost)) throw new StoreError("BAD_REQUEST", "That isn't a valid website.", 400);
      const existing = await this.listKeywords(siteHost);
      if (existing.length >= MAX_TRACKED_PER_SITE) throw new StoreError("LIMIT", `You can track up to ${MAX_TRACKED_PER_SITE} keywords per website. Remove one first.`, 400);
      const rows = await rest("POST", "tracked_keywords?on_conflict=site_host,query,country,device", { body: { site_host: siteHost, query, country, device }, prefer: "return=representation,resolution=ignore-duplicates" });
      return rows[0] ? { created: true, keyword: camelKeyword(rows[0]) } : { created: false, keyword: existing.find((k) => k.query === query && k.country === country && k.device === device) || null };
    },
    async setActive(id, active) {
      if (!isUuid(id)) throw new StoreError("BAD_REQUEST", "Unknown keyword.", 400);
      await rest("PATCH", `tracked_keywords?id=eq.${id}`, { body: { active: !!active }, prefer: "return=minimal" });
    },
    async removeKeyword(id) {
      if (!isUuid(id)) throw new StoreError("BAD_REQUEST", "Unknown keyword.", 400);
      await rest("DELETE", `tracked_keywords?id=eq.${id}`, { prefer: "return=minimal" });
    },

    /** The most recent snapshots (Supabase returns at most 1000 rows per request) for these keywords since `sinceIso`. */
    async snapshots(ids, sinceIso, limit = 1000) {
      const good = (Array.isArray(ids) ? ids : []).filter(isUuid).slice(0, 100);
      if (!good.length) return [];
      const rows = await rest("GET", `rank_snapshots?keyword_id=in.(${good.join(",")})&checked_at=gte.${enc(sinceIso)}&order=checked_at.desc&limit=${Math.min(1000, limit)}&select=keyword_id,checked_at,position,ranking_url,provider,trigger`);
      return rows.map(camelSnapshot);
    },
    /** The stored first-page results (and related suggestions) of the most recent snapshots for these keywords, newest first. */
    async recentTopResults(ids, sinceIso, limit = 300) {
      const good = (Array.isArray(ids) ? ids : []).filter(isUuid).slice(0, 100);
      if (!good.length) return [];
      const rows = await rest("GET", `rank_snapshots?keyword_id=in.(${good.join(",")})&checked_at=gte.${enc(sinceIso)}&order=checked_at.desc&limit=${Math.min(1000, limit)}&select=keyword_id,checked_at,top_results`);
      return rows.map((r) => ({ keywordId: r.keyword_id, checkedAt: r.checked_at, topResults: r.top_results ?? null }));
    },
    async insertSnapshot({ keywordId, checkedAt, position, rankingUrl, provider, trigger, topResults }) {
      if (!isUuid(keywordId)) throw new StoreError("BAD_REQUEST", "Unknown keyword.", 400);
      await rest("POST", "rank_snapshots", { body: { keyword_id: keywordId, checked_at: checkedAt, position, ranking_url: rankingUrl, provider, trigger, top_results: topResults || null }, prefer: "return=minimal" });
      await rest("PATCH", `tracked_keywords?id=eq.${keywordId}`, { body: { last_checked_at: checkedAt }, prefer: "return=minimal" });
    },
    /** Number of snapshots (every trigger) since an instant — what the search allowance has been spent on. */
    async countSnapshotsSince(sinceIso) {
      const res = await rest("GET", `rank_snapshots?checked_at=gte.${enc(sinceIso)}&select=id`, { raw: true, headers: { Prefer: "count=exact", Range: "0-0" } });
      const total = Number(/\/(\d+)$/.exec(res.headers.get("content-range") || "")?.[1]);
      return Number.isFinite(total) ? total : 0;
    },

    /** Claims today's scheduled run. null when another run already claimed it (a duplicated cron delivery). */
    async claimRun(job, day) {
      const rows = await rest("POST", "job_runs?on_conflict=job,run_day", { body: { job, run_day: day }, prefer: "return=representation,resolution=ignore-duplicates" });
      return rows[0]?.id ?? null;
    },
    async finishRun(id, { status, checked, errors, note }) {
      await rest("PATCH", `job_runs?id=eq.${Number(id)}`, { body: { finished_at: new Date().toISOString(), status, checked, errors: errors?.length ? errors : null, note: note || null }, prefer: "return=minimal" });
    },
    async releaseRun(id) { await rest("DELETE", `job_runs?id=eq.${Number(id)}`, { prefer: "return=minimal" }); },
    async lastRuns(job, limit = 3) {
      return (await rest("GET", `job_runs?job=eq.${enc(job)}&order=started_at.desc&limit=${Math.min(10, limit)}`)).map((r) => ({ day: r.run_day, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, checked: r.checked, errors: r.errors || [], note: r.note || "" }));
    },
  };
}
