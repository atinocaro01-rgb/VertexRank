# What was added to this repo

This is your original VertexRank repo with the marketing landing page
merged in. Summary of the change:

- `app/page.js` — now the new landing homepage (was the dashboard entry)
- `app/app/page.js` — the dashboard, moved here from the old `app/page.js`
  (import path updated: `../components/VertexRank` → `../../components/VertexRank`)
- `app/privacy/`, `app/terms/`, `app/not-found.js`, `app/sitemap.js`,
  `app/robots.js` — new
- `content/landing/` — the landing page's HTML/JSON-LD content, read by
  `app/page.js`, `app/privacy/page.js`, `app/terms/page.js`, `app/not-found.js`
- `public/assets/`, `public/favicon.ico`, `public/site.webmanifest`,
  `public/llms.txt` — new static assets for the landing page

Everything else — `app/layout.js`, `app/globals.css`, `app/api/*`,
`components/VertexRank.jsx`, `lib/`, `package.json`, and the config files —
is byte-for-byte identical to your original zip. Nothing about the
dashboard's behavior changed, only where its entry file lives.

## Before deploying

The domain constant defaults to `https://vertexrank.vercel.app` in five
files: `app/page.js`, `app/privacy/page.js`, `app/terms/page.js`,
`app/sitemap.js`, `app/robots.js`. Update it there if the final domain is
different.

## To use this

```bash
npm install
npm run build   # confirm it builds clean
npm run dev     # check localhost:3000/ and /app
```

Then either push this as a new commit/branch to your existing
`atinocaro01-rgb/VertexRank` repo, or use it to replace the repo's contents
entirely — it's the same repo, just with these additions applied.
