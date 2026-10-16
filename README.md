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
