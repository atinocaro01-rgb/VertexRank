// Next.js App Router convention: this file generates /sitemap.xml automatically.
// Update SITE once you have your real domain (keep in sync with app/page.js etc).
const SITE = "https://vertexrank.vercel.app";

export default function sitemap() {
  const now = new Date().toISOString().slice(0, 10);
  return [
    { url: `${SITE}/`, lastModified: now, changeFrequency: "weekly", priority: 1.0 },
    { url: `${SITE}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    // Add dashboard routes here ONLY if you want them publicly indexed.
    // Most SaaS dashboards are left out of the sitemap and set to noindex instead
    // (see app/app/layout.js robots note below).
  ];
}
