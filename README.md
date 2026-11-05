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
- `VR_GLOBAL_DAILY_SERP`: total live-search requests per day across all visitors (see Live search results below). Set this below your SerpApi allowance divided by 30.

## Live search results (SerpApi)

The **Keyword Intelligence → Live Results** tab shows the top organic Google results for one query, in your website's target country, on desktop or mobile, and where your website appears in them. It is observed data from a search provider, labeled with its source, country, device and time. It is not a search volume and not a guaranteed rank (results vary by person and location). For your own site's averaged positions use Search Data (Search Console).

Setup:

1. Create a SerpApi account (the free plan includes 250 searches per month) and copy your API key from its dashboard.
2. Set `SERPAPI_KEY` as an environment variable on your host (Vercel: Project → Settings → Environment Variables), then redeploy. Never commit it.

**Several keys.** To get more searches, add more keys and they rotate: `SERPAPI_KEY_1`, `SERPAPI_KEY_2`, `SERPAPI_KEY_3`, … (up to 50; gaps are fine), or one `SERPAPI_KEYS` variable with keys separated by commas, spaces or new lines. `SERPAPI_KEY` still works and can be mixed in; duplicates are ignored. Searches are spread round-robin across the keys. If a key is rejected, used up or rate-limited, that same search moves on to the next key and the bad key is left alone for a while (1 hour for a rejected key, 6 hours for a used-up allowance, 1 minute for a rate limit); if every key is down you get one clear message. Network and provider outages are not retried on other keys. The tracked-keyword budget defaults scale with the number of keys (200 searches and a 50-search manual reserve per key); set `SERP_MONTHLY_BUDGET` / `SERP_MANUAL_RESERVE` to override. Rank History shows how many keys are rotating. Cool-down memory is per server instance, which only means an instance may retry a spent key once (failed calls aren't billed).
3. Recommended: set `VR_GLOBAL_DAILY_SERP` (for example `8`) so the whole app can never spend more than your plan allows. Without `SERPAPI_KEY` the tab explains that live results aren't set up and nothing else is affected.

Notes:

- Each fresh search spends one search from your plan. Repeating the same query, country and device is reused for six hours (per server instance); the Refresh button forces a new search. Searches only run when you click.
- Only the first page of organic results (up to 10) is fetched.
- The provider sits behind `lib/serpProvider.js`. `SERP_PROVIDER` defaults to `serpapi`; another provider means adding one module there. The API key is only read on the server and is never returned, logged or included in an error. Code: `lib/serpProvider.js`, `lib/serpApi.js`, `lib/serpMatch.js`, `app/api/serp/search/route.js`.

**Using live results elsewhere in the app.** Every search you run in Live Results is saved with the website (the latest 40, in your browser, included in backups; each one can be removed). Two things use them:

- **Competitors → "Found in live search results"** lists sites that keep appearing in your saved searches (most frequent first), with a one-click Add. Big general platforms such as Wikipedia, YouTube, social networks and marketplaces are left out. You can also click "Track as competitor" on any result.
- **Opportunity Queue**: for each saved search where your site isn't in the top 3, one item is added, either "ranks #N, with room to climb" or "not in the top 10". The evidence is observed (who ranks above you, and your crawl's check of whether any page already has every word of the query in its title or H1). Priority is raised when Search Console shows real impressions for the query or it's one of your tracked keywords. Confidence is never above Medium (one snapshot from one provider), and searches older than two weeks are demoted and labelled. They map onto the Action Center like every other source. Code: `lib/serpInsights.js`.

## Rank history and daily checks (Supabase + Vercel Cron)

The **Keyword Intelligence → Rank History** tab keeps the positions of the keywords you track, so you can see movement over weeks. It needs a small Postgres database (positions must survive refreshes and redeploys), and a daily job re-checks keywords for you. Without these variables the tab just explains the setup and nothing else changes.

Setup:

1. Create a free Supabase project. In its SQL editor, paste and run `db/serp_history.sql`. It creates three tables and turns on Row Level Security with no policies, so the public key can access nothing.
2. In Supabase → Project Settings → API, copy the project URL and the **service_role** key. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on your host. The service_role key is a server secret: never commit it and never expose it to the browser.
3. For the daily job, set `CRON_SECRET` to a random string of 16+ characters (Vercel → Settings → Environment Variables). `vercel.json` already schedules `/api/cron/serp` once a day (05:00 UTC); Vercel sends the secret as a Bearer header. Cron runs only on production deployments.
4. Redeploy, open Rank History, and track a keyword (type it, or use "Track this query" in Live Results).

How it behaves:

- **Manual first.** "Check rankings" checks up to 3 tracked keywords now (the ones you pick, or the least recently checked). Adding a keyword never searches by itself. A Live Results search for a keyword you already track is saved as a snapshot too, since it was paid for anyway.
- **Daily job.** Each run checks the active keywords that are due, oldest first. Defaults: a keyword is re-checked about every 7 days, up to 5 per run, with a monthly budget of 200 tracked-keyword searches (manual and scheduled together) of which 50 are kept for manual checks. Tune them with `SERP_CHECK_INTERVAL_DAYS`, `SERP_CRON_MAX_PER_RUN`, `SERP_MONTHLY_BUDGET` and `SERP_MANUAL_RESERVE`. Keep the budget below your SerpApi plan (250/month on the free plan); the count is per calendar month and approximate, and untracked Live Results searches aren't in it (`VR_GLOBAL_DAILY_SERP` covers those).
- **Safe by design.** The job claims the day first, so a duplicated cron delivery can't spend twice. It stops on errors that would repeat (rejected key, used-up allowance, rate limit), leaves failed keywords due for the next run, and records what happened in the `job_runs` table, shown at the top of the tab. It always touches the database, which also keeps a free Supabase project from pausing (free projects pause after 7 days without activity; if that happens, resume it in the Supabase dashboard).
- **Vercel Hobby limits.** Cron runs at most once a day and can fire anywhere within its hour; Vercel doesn't retry a failed run. The route is exempt from the password gate only for a request carrying the exact `CRON_SECRET` bearer token.
- **Who sees what.** The app has one shared password, so history is stored per website host, not per user. If you ever make it multi-user, add an owner column in `lib/serpStore.js` first.
- **What the numbers are.** Each point is an observed snapshot of the first page of results for one query, country, device and moment. It will differ from Search Console's averaged position and from what a particular person sees. At most 25 keywords per website, and the chart shows up to the latest 1,000 snapshots per request.

Code: `lib/rankHistory.js`, `lib/serpStore.js`, `lib/serpJob.js`, `lib/cronAuth.js`, `app/api/serp/{tracked,history,check}/route.js`, `app/api/cron/serp/route.js`.

## Generate fix on every recommendation

Every recommendation in the tool now has a **Generate fix** button next to Add to Action Center: Dashboard and Opportunity Queue cards, Keyword Intelligence (opportunities and cannibalization), AEO (pages and questions), GEO, the AI Visibility Simulator, Competitors (gaps, AEO/GEO differences, backlink prospects), Backlinks, Internal Links, Content Planner topics and each Action Center row. The SEO audit keeps its own before/after fixer.

It produces the actual deliverable for that kind of finding, from your real crawled pages: new title and meta options, a ready-to-paste FAQ answer plus FAQPage JSON-LD, Organization/Article schema, the exact internal-link sentence with the right anchor, an outreach email, a rewritten section, or a config snippet. It never invents facts: anything only you can supply is left as **[ADD: …]** (counted in a banner), and any link to a page that isn't in your crawl is flagged. Reopening the same recommendation reuses its fix instead of spending another AI call. Code: `lib/fixKinds.js`, `lib/recommendationFix.js`, `lib/fixContext.js`, `app/api/recommendation-fix/route.js`.

## 30-day content calendar and article writer

**Content Planner → Generate 30-day calendar** builds a month of one-topic-a-day content from what VertexRank has actually measured: Search Console queries, keyword gaps, unanswered AEO questions, GEO gaps, live-search checks and your tracked keywords (run those analyses first for a stronger calendar). Three AI passes propose candidates and **code decides what is good enough**: each topic must cite a real data item by id (invented grounding is rejected), have a specific title containing its primary keyword (no "ultimate guide" or hype), state an original angle, and not duplicate your existing pages or another topic. You may therefore get fewer than 30 rather than padding. Topics show on a month grid and in a list, each with *why this topic*, intent, funnel stage, format, cluster and pages to link to. Topics enter the Opportunity Queue only in the week before their date. Code: `lib/contentCalendar.js`, `lib/calendarContext.js`, `app/api/content-calendar/route.js`.

**Write the article** (on any topic): you choose real sources (found with one live search, or pasted URLs), the server reads their text with the same SSRF-safe fetcher as the crawler, and a two-pass writer drafts the article citing a source only for what its text says. You can add your own first-hand input (used as fact). The draft has an automatic checklist that updates as you edit: title and meta length, headings, topic early, no keyword stuffing, depth, citations that point at real sources, internal links that exist, unfilled `[ADD: …]` spots, readability, filler, FAQ. It also generates Article + FAQ JSON-LD. Code: `lib/sourceTools.js`, `lib/articleWriter.js`, `lib/articleChecks.js`, `app/api/content-{sources,extract,write}/route.js`.

Be clear-eyed about what this is. The checklist covers Google's published on-page basics and helpful-content guidance; it cannot judge accuracy or originality, and nothing can guarantee indexing or rankings. Google allows AI-assisted content that is helpful and made for people, but its spam policy targets many pages made mainly to rank without added value (scaled content abuse). Use drafts as a starting point: add real experience and data, verify every claim against its source, fill in the author and review date, and publish only what you'd stand behind. Writing runs as two ~60-second AI passes, so each article takes about a minute; sources found with "Find sources" use one search from your SerpApi allowance.

## Competitor intelligence

Competitor crawls are now stored (compactly: titles, outline, questions, schema types, size and outside links; **no page text**) and used in three ways. Competitors analysed before this update need their site-wide analysis run once more to capture it. The **Competitor intelligence** card at the top of the Competitors tab has three views:

- **Questions**: every question the competitors' pages ask (from FAQPage markup, question-style headings and page text), kept exactly as written and counted across competitors, each marked *You don't answer this / Partly covered / You answer this* against your own crawl and AEO analysis. Filter, copy the list, **Generate fix** to write your own answer from your own facts, or add to the Action Center. Questions that name a competitor's brand are skipped.
- **Content gaps**: a page of yours that lacks sections a competitor's matching page has, or a topic several competitors cover that you have no page for, with the section headings they use as research. Generate fix or add to the Action Center.
- **Sources they cite**: outside pages competitors link to (deep links only, no social/ads/marketplaces, authoritative first). They also appear as source candidates in the article writer.

They also feed the rest of the tool: unanswered competitor questions, competitor-only topics and missing-page topics become grounded items (ids `C…`, labelled "Competitor crawl") for the 30-day calendar, and the article writer receives the section topics competitors cover on the same subject as research.

What is and isn't reused: questions are reused as asked (short, generic labels of reader intent); headings are shown as research, never as text to publish; source links are pointers you check yourself; competitor **answers and body text are never extracted or reused**. Copying or lightly rewording a competitor's copy is a copyright problem and the kind of scraped, stitched content Google's spam policies target, so every tool that follows tells the AI to answer from your facts in your own words. The crawler also now records every H2–H4, question-style headings and FAQ-schema questions on each page (additive: existing fields are unchanged); your own site needs a re-crawl to pick these up, though the tools work with older crawls. Code: `lib/faqSchema.js`, `lib/competitorIntel.js`.

## Keyword ideas, competitor keywords and who ranks

VertexRank cannot see the full list of keywords a competitor ranks for (that needs a paid keyword index such as Semrush, Ahrefs or DataForSEO). It uses what is actually observable, labelled as observed, with no search volume or difficulty:

- **Competitor page phrases.** The 2–4 word phrases competitors' pages are built around, taken from their titles, H1s and headings in the stored competitor crawls. A phrase counts once per page; brand names, generic words, utility pages and shorter phrases that only repeat a longer one are removed. Each is marked *You target this / Mentioned, not targeted / Not targeted* against your own crawl. This shows what their pages target, not what they rank for.
- **Google's own suggestions.** Every live search already returns Google's *related searches* and *people also ask* questions. They are now kept (questions only, never the answer snippets, which are other sites' content), saved with the search and, for tracked keywords, with each rank snapshot, at no extra search cost.
- **Who ranks for your tracked keywords.** Each rank check already saved the top 10; it now shows who ranks for each keyword, how they moved since the previous check (▲/▼, new in the top 10, dropped out), and a *Who ranks across your tracked keywords* card of the sites that keep appearing, which are your real search competitors. Any host can be added to Competitors in one click.

The **Keyword Ideas** tab (Keyword Intelligence) merges these into one filterable list (keywords or questions, by source, hide already tracked), flags ideas you already track or already get impressions for, and lets you **Track** a keyword (or the top 5) in one click. Tracked keywords are re-checked about weekly, so they spend search allowance. Questions can become a Generate fix or an Action Center task. Ideas also feed the 30-day calendar as grounded items (ids `R…` for Google suggestions; competitor phrases you don't target join the `C…` items). No database change is needed: the extra data is stored inside the existing `top_results` column, and older snapshots still read. Code: `lib/keywordIntel.js`.

## How structured data is detected

The crawler reads the HTML each page sends and finds structured data in all three formats Google supports: **JSON-LD** (including the very common `{"@graph": [...]}` wrapper used by Yoast, Rank Math, Next.js and most generators), **Microdata** (`itemscope`/`itemtype`) and **RDFa** (`typeof`). The page's entity types come from its top-level nodes and every `@graph` member, with `@type` arrays and full `https://schema.org/…` types normalised; details such as an address or a Question inside a FAQPage are not listed as page types. JSON-LD wrapped in HTML comments or CDATA is accepted, and a block with broken JSON is reported as **"Structured data has invalid JSON"** rather than as missing. Earlier versions only read the top-level `@type`, so any page using `@graph` was wrongly flagged "No structured data found" (and its FAQ/Organization schema was missed by the AEO and GEO signals); re-crawl a site to refresh its results.

One limit remains: markup that a site adds only with JavaScript after the page loads isn't in the HTML the server sends, so it isn't seen. If a page shows its schema in Google's Rich Results Test but not here, that is the likely reason. Code: `lib/structuredData.js`.

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

## Access control (password gate)

The API routes spend your LLM credits and, in a later step, will be able to open pull requests on your repositories, so the whole app (pages and API) sits behind one shared password using HTTP Basic Auth (`middleware.js`, rules in `lib/accessControl.js`). The browser shows its own login prompt and then sends the credentials with every request, including the app's own calls, so there is no login screen to maintain.

- Set `VR_ACCESS_PASSWORD` (a long random value; see `.env.example`). Optionally set `VR_ACCESS_USER` to require a username as well.
- If it is **not** set: production is **locked** (503 with an explanation) rather than silently open; development is open so `npm run dev` needs no setup.
- `VR_ACCESS_DISABLED=1` is an explicit opt-out for deployments protected another way (VPN, Vercel password protection, localhost only).
- The API guard (`lib/apiGuard.js`) checks access again, so the routes stay protected even if the middleware is removed or its matcher changes. Repeated wrong passwords against the API are throttled.
- Responses carry `X-Robots-Tag: noindex, nofollow`. Next's static build assets are excluded from the gate (they contain no data).
- The gate cannot rate-limit guesses made at the middleware itself, so use a long random password.

## Backups

Your workspace (websites, crawls, analyses, Action Center, everything) lives only in this browser's localStorage. The sidebar has **Export backup** (downloads `vertexrank-backup-YYYY-MM-DD.json`) and **Import backup**, and shows when you last exported. Importing offers **Add missing websites** (nothing existing is overwritten; websites are matched by URL) or **Replace everything**. Backups contain crawled page text, so treat the file as private; they never contain API keys (those are server environment variables). An imported file goes through the same validation as data loaded from the browser. (`lib/workspaceBackup.js`)

## Stack detection

Each crawl fingerprints what the site is built with (`lib/stackDetector.js`): CMS/builder (WordPress, Shopify, Wix, Squarespace, Webflow, Ghost), framework (Next.js, Nuxt, SvelteKit, Remix, Angular, React, Vue), static site generator (Hugo, Jekyll, Eleventy, Astro, Gatsby, Docusaurus, MkDocs, Hexo), common libraries, and hosting (GitHub Pages, Netlify, Vercel, Cloudflare, AWS). Every detection lists its evidence and a confidence, and "unknown" is a valid answer. The result is shown on each website card:

- **Rendering:** it flags sites whose pages are empty shells that fill in with JavaScript. VertexRank reads the HTML as served and does not run JavaScript, so findings for those pages may be incomplete or wrong. The card says so and lists the affected pages.
- **GitHub fix suitability:** High for plain HTML (direct file edits), Medium for frameworks and static generators (edits live in templates or metadata config), Low for CMS and builders (content isn't in a repository).

## GitHub pull requests (plain-HTML sites)

VertexRank can turn certain audit findings into a **pull request** on your site's GitHub repository. It never pushes to your main branch: it commits to a new branch (`vertexrank/fixes-…`) and opens a PR for you to review and merge.

**Setup**
1. **One token per GitHub owner.** A fine-grained token belongs to a single owner (your personal account or one organization), so if your site repositories live under several owners, create one token per owner. For each: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token; set the **Resource owner** to that account/organization (an organization admin may need to allow fine-grained tokens first), **Only select repositories** (tick that owner's site repos), and permissions **Contents: Read and write** and **Pull requests: Read and write** (Metadata: Read is automatic). Copy the token when it is shown; it appears only once.
2. **Name the environment variable after the owner.** The token for owner `acme-org` goes in `GITHUB_TOKEN_ACME_ORG` (uppercase the name and turn `-` into `_`); for `jane`, `GITHUB_TOKEN_JANE`. `GITHUB_TOKEN` still works as a default for any owner without its own variable. In Vercel: Project → Settings → Environment Variables → add each variable (mark it Sensitive; select Production, and Preview if you use previews) → redeploy. If a repository's owner has no token configured, the error names the exact variable to add. A token is only ever sent for repositories owned by its own owner.
3. On the **Websites** page, click **Connect** under a website, enter `owner/repo` and the branch, and click **Inspect repository**. VertexRank checks whether the repo really is a plain-HTML site, suggests the folder that is the web root, and tells you which environment variable supplied the token. Save.
4. In the **SEO Audit**, findings that can be fixed show **Create pull request**. Edit any values (titles, descriptions, alt text), click **Preview changes** to see exactly what will change, then **Create pull request**. The Action Center item switches to **PR Open**; use **Check status** after you merge (a merged PR becomes Applied), then re-crawl to verify.

**What it can fix:** missing page titles, meta descriptions and canonical tags; the `<html lang>` attribute; image alt text (only images with no alt attribute; `alt=""` marks an image decorative and is left alone); schema.org JSON-LD; removing `noindex` from the HTML; pointing internal links at their final URLs or at a replacement you supply; creating `robots.txt` and `sitemap.xml` when missing.

**Safety, because a site may not be 100% plain HTML**
- **The repo is inspected first.** Frameworks (React, Vue, Next, Astro…), static-site generators (Jekyll, Hugo, Eleventy…), WordPress and PHP projects are refused with an explanation: in those, the HTML visitors see is generated output, so editing it would be overwritten or wrong. HTML with build tooling is allowed with a warning.
- **Every fix is verified against the file before editing.** Each fix carries what the crawler saw on the live page. If the file disagrees (for example the crawler saw a title but the file has none), the page is being changed by JavaScript or a build step and the fix is **blocked with the reason**, never forced. The same applies to ambiguous cases: several `<title>` tags, a URL that could map to two files, links that are relative.
- **Minimal edits.** Changes are exact text splices, so formatting, indentation and line endings elsewhere are untouched and the PR diff shows only the real change.
- **Nothing is overwritten.** New files are only created when they don't exist.
- **The server recomputes everything.** The browser sends only the intent (kind, page, values); file contents and diffs are produced on the server from the repository, so the browser can't inject an edit. Creating a PR requires explicit confirmation, a read-only preview is available first, and all of it sits behind the password gate and rate limits.
- Reading is pinned to one commit, so the preview and the PR come from a consistent snapshot. Fixes that can't be applied are listed in the PR description.

Not yet supported: frameworks and generators, and fixing external-link problems. Code: `lib/htmlScan.js`, `lib/htmlFixes.js`, `lib/repoInspect.js`, `lib/github.js`, `lib/prBuilder.js`, `lib/fixPlanner.js`, `app/api/github/*`.

### AI-suggested titles and descriptions

In the pull-request dialog, title and meta-description rows have a **Suggest with AI** button, and **Suggest for N unedited rows** drafts them in batches. It covers missing, too-long and duplicate titles and descriptions. Suggestions are drafted from each page's own crawled content (`lib/seoSuggestions.js`, route `app/api/seo-suggest`) and land in the editable box; nothing is applied until you preview and create the pull request.

- **Grounded.** The model is told to use only facts present in the page content and never to invent products, prices, places, awards or claims. Afterwards every suggestion is checked for words that appear nowhere on the page and flagged ("contains words that don't appear on the page") so you can verify it.
- **Untrusted input and output.** Page text is fenced as data and the model is told never to follow instructions inside it. Its answer is parsed strictly, stripped of HTML, markdown and "Title:" labels, and length-capped.
- **Honest quality checks, live as you type:** character count (titles about 50-60, descriptions about 130-160), too long or short, ALL CAPS, unchanged from the current value, and duplicates of other pages' titles or descriptions on the site (including the other suggestions in the same pull request).
- **Market-aware.** The website's selected country is applied (language, spelling, currency) the same way as the other AI analyses.
- It uses the same rate limits as the other AI features.

## Search Console (real search data, free)

VertexRank can read your real search performance from Google Search Console: clicks, impressions, click-through rate (CTR) and average position, by query and page. It uses a Google Cloud **service account** (read-only), so there is no OAuth screen, no tokens to store and nothing to encrypt. The Search Console API itself is free.

**One-time setup (about 10 minutes)**
1. In Google Cloud Console, create or pick a project and enable the **Google Search Console API**.
2. Create a **service account** (IAM & Admin → Service Accounts) and add a **JSON key**. The key file downloads once, so keep it somewhere safe.
3. Set the whole JSON as the `GOOGLE_SERVICE_ACCOUNT_JSON` environment variable on your host (raw JSON or its base64) and redeploy. Never commit it.
4. In Search Console, open each property → **Settings → Users and permissions → Add user**, and add the service account's e-mail (it ends in `.iam.gserviceaccount.com`) with **Restricted** permission. Do this once per property.
5. In VertexRank: **Websites** → **Search Console: Connect** under a website (or the **Search data** page), choose the property (a suggestion is highlighted), then **Load report**.

**What you get**
- **Search data page:** totals with change versus the previous equal period, daily clicks and impressions, top queries, top pages, devices and countries, a Markdown export, and a note of what the data can't tell you. Reports are cached for 10 minutes; "Refresh" fetches fresh numbers.
- **New opportunities in the Opportunity Queue** (type "Search data"), computed from your own numbers, no AI involved:
  - *Low click-through rate:* pages that rank (position 20 or better) with a CTR well below what your own queries typically get at that position. The estimate of extra clicks is labelled as an estimate. A **Create pull request** button opens the GitHub flow with AI title/description suggestions that already know which queries the page ranks for.
  - *Striking distance:* queries stuck at positions 8-20 with real demand, with the page that ranks for them.
  - *Competing pages:* several of your pages appearing for the same queries.
  - *Declining pages:* pages that lost 30% or more of their clicks versus the previous period (with a seasonality caveat), and a site-wide trend alert.
  - *Crawled pages with no impressions:* indexable pages Search Console has shown no impressions for (it can mean they aren't indexed).
- Thresholds scale with the report length (7, 28, 90 or 180 days), and a report older than two weeks is kept but demoted and labelled.

**Honesty and limits**
- Position is Google's **average** position over the period, not a live rank; the last three days are skipped because that data is incomplete; Google omits anonymised and very rare queries, so rows won't add up to the totals; search volume and keyword difficulty are not part of Search Console.
- A domain property (`sc-domain:`) includes all subdomains; opportunities only consider pages on the website's own host.
- A report is stored in your browser with the website (roughly 100 KB) and included in backups. Google keeps about 16 months of history, so you can always reload past periods.
- The routes sit behind the password gate and rate limits; the service account key is only read on the server and is never returned, logged or included in an error. Code: `lib/gscAuth.js`, `lib/gscClient.js`, `lib/gscReport.js`, `lib/gscAnalysis.js`, `app/api/gsc/*`.
