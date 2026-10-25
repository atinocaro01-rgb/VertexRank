# VertexRank

A Next.js project, ready to push to GitHub and deploy on Vercel.

## Run it locally (optional)

You only need this if you want to preview changes on your own computer before deploying.

```bash
npm install
npm run dev
```

Then open http://localhost:3000

## Deploy to Vercel

1. Push this folder to a new GitHub repository.
2. Go to vercel.com, sign in with GitHub, and click "Add New Project."
3. Select the repository. Vercel will auto-detect Next.js — no configuration needed.
4. Click Deploy.

Every time you push a change to the `main` branch on GitHub, Vercel will automatically redeploy the site.

## AI providers (environment variables)

All AI calls go through `lib/openrouter.js`. Which providers are active is controlled by the `PROVIDERS` switches near the top of that file (currently only **Token Harbor** is `true`). Disabled providers are skipped, but their code and Vercel environment variables stay untouched. To re-enable one, change its value to `true`.

**Manus (trial):** set `MANUS_API_KEY` (or `MANUS_API_KEYS` with several keys, comma or new-line separated). Optional: `MANUS_AGENT_PROFILE` (default `lite`), `MANUS_TIMEOUT_MS` (default `50000`). Manus is an asynchronous agent API: each request creates a task and polls for the answer, spends Manus credits, and accepts roughly 5,000 tokens of input.

When more than one provider is enabled, they are tried in this order, and any provider without a key is skipped:

1. **Manus** (trial): `MANUS_API_KEY`
2. **Token Harbor** (free models): `TOKENHARBOR_API_KEYS`
3. **LLMsRelay**: `LLMSRELAY_API_KEY`
4. **OpenRouter** (free-model fallback): `OPENROUTER_API_KEYS`

Add as many Token Harbor keys as you like, separated by commas or new lines:

```
TOKENHARBOR_API_KEYS=th_key_one,th_key_two,th_key_three
```

(`TOKENHARBOR_API_KEY` with a single key also works.) Keys are rotated per request. A key that returns 429 (rate limit) or 401/403 is skipped for a while so the other keys keep working.

Optional settings:

- `TOKENHARBOR_MODELS`: comma-separated model ids, in priority order. Default: `claude-haiku-5.5:free,deepseek-v4.1-flash:free,mimo-v2.6-flash:free`
- `TOKENHARBOR_BASE_URL`: override the endpoint (default `https://tokenharbor.ai/v1/chat/completions`)

Add these in Vercel under Project Settings, then Environment Variables, and redeploy.

## Copying results

Every page with analysis has a **Copy all** button in the top bar that copies everything on that page (analyses, recommendations, scores) as Markdown, ready to paste into a doc, ticket, or chat. The Dashboard also has **Copy full report**, which combines every page into one document. Individual cards (AI Insights, Unified AI Recommendations, Entities, Keyword Opportunity Analysis, each recommendation, competitor, content idea, audit issue, and action) have their own smaller Copy buttons.

The text is built in `lib/copyExport.js`.

## Notes

- All data in the app (websites, scores, issues, keywords, etc.) is mock data held in memory. It resets on page refresh — there is no database yet.
- Font is Open Sans, loaded via `next/font/google` in `app/layout.js`.

## Security and usage limits

**Outbound requests (SSRF protection).** Every request VertexRank makes to a user-supplied URL (site crawl, robots.txt, sitemaps, competitor crawl) goes through `lib/safeFetch.js`, never bare `fetch()`. It blocks private, loopback, link-local and cloud-metadata addresses (IPv4 and IPv6), checks the IP at connection time (so DNS rebinding can't bypass it), re-validates every redirect hop, only follows redirects within the same site, allows ports 80/443 only, and caps response size (after decompression), content type and total time. Run the tests with `npm test`.

**Rate limits and usage controls.** Every API route is wrapped by `lib/apiGuard.js`: request-size cap, per-client rate limits, and optional global daily caps. Limits are defined in one place (`POLICIES` in that file).

For limits to hold on Vercel you need a shared store. Add an **Upstash Redis** database (Vercel Marketplace → Storage) and set the REST variables it gives you (`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`; Vercel KV's `KV_REST_API_URL` / `KV_REST_API_TOKEN` also work). Without one, limits fall back to per-instance memory, which is only a weak brake on serverless.

Optional environment variables:

- `VR_RATE_LIMIT_MULTIPLIER`: scale every per-client limit (e.g. `2` for twice as generous).
- `VR_GLOBAL_DAILY_AI_CALLS`: total LLM-spending calls per day across all visitors; over it, AI features return a "daily capacity" message.
- `VR_GLOBAL_DAILY_CRAWLS`: total site crawls per day across all visitors.

## Crawl identity and stale-data protection

Every crawl gets a `crawlId` (minted in `lib/siteCrawler.js`). Analyses (AEO, GEO, keyword clusters, internal links, AI insights, competitor comparison, AI visibility) are stamped with the `crawlId` they were computed from, and an async result is only applied if that crawl is still the current one. The logic lives in `lib/crawlState.js` (unit-tested in `tests/crawlState.test.mjs`):

- A re-crawl clears everything derived from the old crawl; late responses from the old crawl are discarded.
- If the same analysis is started twice, the older request can't overwrite the newer one.
- Editing a website's URL cancels anything in flight, clears the old crawl and its analyses (your keywords, actions, content ideas, backlinks and competitor list are kept) and starts a new crawl.
- Deleting a website while something is running can't bring it back.
- Changing the country clears the AI Visibility Simulation (it is written for one market).
- Workspaces saved before this change are migrated automatically and are not treated as stale.

## Technical SEO checks

Each crawl records, for every URL it requests, the HTTP status and redirect chain, `noindex` (meta robots and `X-Robots-Tag`), and every `rel=canonical` tag. Near the end of the time budget it also makes header-only status checks (no page download) of up to 40 internal link targets, canonical targets and sitemap URLs it hasn't fetched. `lib/technicalChecks.js` turns those facts into findings that appear in the SEO Audit, the Dashboard and the exports:

- **Indexability:** homepage `noindex`, other `noindex` pages, robots.txt blocking Googlebot site-wide, internal links to robots-blocked URLs, missing robots.txt.
- **Broken links and errors:** internal links to 404/410 and other 4xx, 5xx errors, unreachable URLs, and 401/403 (low severity, since these are often bot-blocking). Timeouts and rate limits are never reported as broken.
- **Redirects:** internal links to redirecting URLs, chains of 2+ hops, loops, https→http downgrades, off-site redirects, trailing-slash-only redirects (low).
- **Canonicals:** multiple, invalid, protocol/host mismatches, cross-domain, targets that are broken / redirecting / `noindex`, canonical chains, `noindex` + canonical conflicts.
- **Sitemap consistency:** no sitemap, unparsable sitemap, host mismatch (www vs apex), URLs that error / redirect / are `noindex` / are non-canonical / are blocked by robots.txt, and linked pages missing from a complete sitemap.

The Site Technical score is the average of the pages' technical scores minus a capped deduction for these site-level findings (Critical 11, High 7, Medium 4, Low 2 points each, 35 max); the Audit page shows the breakdown. Coverage is shown honestly: link and sitemap checks are a bounded sample, and the audit says how many URLs were and weren't checked.

The crawler respects robots.txt using `lib/robotsTxt.js` (user-agent groups, `*` and `$` wildcards, longest-match precedence). If robots.txt blocks the page you enter, the crawl stops with an explanation instead of returning nothing. If your URL redirects (http→https, apex→www), the crawl follows it once and audits the host the site actually serves.

Tests: `npm test` runs the unit tests plus `tests/e2e/crawler.e2e.mjs`, which runs the real crawler over a fake website. That test swaps in a small stand-in for cheerio and an in-memory network, so it checks the crawler's logic, not real HTML parsing or real HTTP.

## Opportunity Queue and country targeting

**Opportunity Queue** (sidebar → Opportunities, and the Dashboard's "Top opportunities"). One ranked list of everything found for a website: technical findings, market (country) checks, keyword, AEO, GEO / AI visibility, internal links, competitor gaps and content ideas (`lib/opportunityQueue.js`). Each item has a type, evidence, a recommended action, a priority and a confidence, and a transparent score: **priority points (Critical 100, High 75, Medium 50, Low 25) × confidence (High 1, Medium 0.85, Low 0.7) + up to 10 for how many URLs a technical finding affects**. Hover a score to see the arithmetic.

- Every opportunity has one canonical id. The old per-screen "Add to Action Center" buttons used different ids, so the same item could be added twice; the queue also recognises those older ids, so existing Action Center items still show as added.
- The same opportunity reported by two modules is shown once (the higher-scoring one) and notes which other module flagged it.
- Opportunities map to the Action Center: not added → in the Action Center → done/rejected. You can filter by type, priority, status and text, and add the top Critical/High items in one click.
- Ideas still in the "Idea" status become opportunities; internal-link opportunities are one per target page and show as done once all suggested links are applied.
- Opportunities from a comparison made against an earlier crawl of your site, or from AI analyses written for a different market than the one now selected, are kept but ranked lower and labelled.

**Country targeting.** The country selected for a website is now used in three ways:
1. **AI analyses.** AEO, GEO, keyword, content ideas, competitor suggestions and comparison, insights, content plans and backlink prospecting all receive the country (validated against `lib/market.js`, so free text can never reach a prompt) and are told to tailor what's location-sensitive — languages, currency, spelling, local directories and entities — without guessing about local specifics they're unsure of. "Worldwide" explicitly forbids assuming a market.
2. **Deterministic market checks** (`lib/marketChecks.js`) against the crawl: page language vs the market's languages, missing `lang`, hreflang problems (malformed, relative, no self-reference, no x-default, or none targeting the market), schema address country and currency vs the market, phone country code, and absence of local-business signals. These run in the browser, so changing the country updates them instantly, and they appear in the SEO Audit and the queue.
3. **Re-running on change.** Changing a website's country clears the AI results written for the old market and re-runs AEO, GEO and keyword analysis for the new one.

`lib/market.js` holds the country list and per-market reference data (languages, currency, English spelling, calling code). It is reference data for hints and consistency checks, not authority — review it for the markets you care about most.
