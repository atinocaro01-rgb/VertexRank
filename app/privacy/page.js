import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(
  path.join(process.cwd(), "content/landing/privacy-body.html"),
  "utf8"
);
const jsonLd = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "content/landing/privacy-jsonld.json"), "utf8")
);
const meta = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "content/landing/privacy-meta.json"), "utf8")
);

const SITE = "https://vertexrank.vercel.app"; // match app/page.js

export const metadata = {
  title: meta.title,
  description: meta.description,
  alternates: { canonical: SITE + "/privacy" },
};

export default function PrivacyPage() {
  return (
    <>
      <link rel="stylesheet" href="/assets/css/style.css" />
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </>
  );
}
