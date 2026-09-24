// Next.js App Router convention: this file generates /robots.txt automatically.
const SITE = "https://vertexrank.vercel.app"; // keep in sync with app/page.js etc

const AI_BOTS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User",
  "Claude-SearchBot", "PerplexityBot", "Perplexity-User", "Google-Extended",
  "Applebot-Extended",
];

export default function robots() {
  return {
    rules: [
      { userAgent: "*", allow: "/" },
      // AI search / answer-engine crawlers explicitly welcomed: VertexRank is
      // a GEO/AEO product, so being crawlable by them is the point.
      ...AI_BOTS.map((ua) => ({ userAgent: ua, allow: "/" })),
    ],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
