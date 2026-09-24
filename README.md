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

## Copying results

Every page with analysis has a **Copy all** button in the top bar that copies everything on that page (analyses, recommendations, scores) as Markdown, ready to paste into a doc, ticket, or chat. The Dashboard also has **Copy full report**, which combines every page into one document. Individual cards (AI Insights, Unified AI Recommendations, Entities, Keyword Opportunity Analysis, each recommendation, competitor, content idea, audit issue, and action) have their own smaller Copy buttons.

The text is built in `lib/copyExport.js`.

## Notes

- All data in the app (websites, scores, issues, keywords, etc.) is mock data held in memory. It resets on page refresh — there is no database yet.
- Font is Open Sans, loaded via `next/font/google` in `app/layout.js`.
