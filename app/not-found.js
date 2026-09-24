import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(
  path.join(process.cwd(), "content/landing/notfound-body.html"),
  "utf8"
);

// Next.js renders this automatically for any unmatched route, and
// automatically serves it with a 404 status and noindex — no meta tag needed.
export default function NotFound() {
  return (
    <>
      <link rel="stylesheet" href="/assets/css/style.css" />
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}
