import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(
  path.join(process.cwd(), "content/landing/terms-body.html"),
  "utf8"
);
const jsonLd = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "content/landing/terms-jsonld.json"), "utf8")
);
const meta = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "content/landing/terms-meta.json"), "utf8")
);

const SITE = "https://vertexrank.vercel.app"; // match app/page.js

export const metadata = {
  title: meta.title,
  description: meta.description,
  alternates: { canonical: SITE + "/terms" },
};

export default function TermsPage() {
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
