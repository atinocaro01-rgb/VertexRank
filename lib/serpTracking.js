// When a live search matches a keyword that is already tracked, keep the result as a snapshot too: the search was paid for
// either way. Best effort and silent — storage trouble must never fail or slow the search the person asked for.

import { hostOf } from "./serpMatch.js";
import { positionOf } from "./rankHistory.js";
import { isSiteHost } from "./serpStore.js";

export async function recordIfTracked({ store, siteHost, result }) {
  try {
    const host = hostOf(typeof siteHost === "string" ? siteHost : "");
    if (!host || !isSiteHost(host) || !store?.configured?.()) return false;
    const k = await store.findKeyword({ siteHost: host, query: result.query.toLowerCase(), country: result.country, device: result.device });
    if (!k || !k.active) return false;
    const { position, rankingUrl } = positionOf(result.results, host);
    await store.insertSnapshot({ keywordId: k.id, checkedAt: result.observedAt, position, rankingUrl, provider: result.source, trigger: "manual", topResults: result.results.map((x) => ({ rank: x.rank, title: x.title, url: x.url })) });
    return true;
  } catch {
    return false;
  }
}
