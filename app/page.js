import fs from "node:fs";
import path from "node:path";
import Script from "next/script";

// Reads the pre-built landing page HTML (header, hero, steps, modules, FAQ,
// footer) and JSON-LD produced by the design tool. Keeping this as a static
// HTML string means the exact, browser-tested markup and CSS classes ship
// unchanged — nothing is hand-retyped into JSX.
const html = fs.readFileSync(
  path.join(process.cwd(), "content/landing/home-body.html"),
  "utf8"
);
const jsonLd = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "content/landing/home-jsonld.json"), "utf8")
);
const meta = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "content/landing/home-meta.json"), "utf8")
);

// CHANGE THIS to your real deployed domain before going live — it drives the
// canonical URL and the Open Graph / Twitter image URLs below.
const SITE = "https://vertexrank.vercel.app";
const OG_IMAGE = `${SITE}/assets/img/og-image.png`;

export const metadata = {
  title: meta.title,
  description: meta.description,
  alternates: { canonical: SITE + "/" },
  openGraph: {
    type: "website",
    siteName: "VertexRank",
    title: meta.title,
    description: meta.description,
    url: SITE + "/",
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: "VertexRank: rank higher in search and get cited by AI answers" }],
  },
  twitter: {
    card: "summary_large_image",
    title: meta.title,
    description: meta.description,
    images: [OG_IMAGE],
  },
};

export default function LandingPage() {
  return (
    <>
      {/* Next.js App Router hoists any <link> tag found here into <head> */}
      <link rel="stylesheet" href="/assets/css/style.css" />
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {/* Raw <script src> tags inserted via dangerouslySetInnerHTML never
          execute (browsers treat innerHTML scripts as inert), so the mobile
          menu / scrollspy / score-ring script is loaded via next/script instead. */}
      <Script src="/assets/js/main.js" strategy="afterInteractive" />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </>
  );
}
