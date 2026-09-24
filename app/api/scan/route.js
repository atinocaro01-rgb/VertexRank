import * as cheerio from "cheerio";

export const runtime = "nodejs";
export const maxDuration = 30;

const USER_AGENT =
  "Mozilla/5.0 (compatible; VertexRankBot/1.0; +https://vertexrank.app/bot)";

const SEVERITY_PENALTY = { Critical: 22, High: 14, Medium: 8, Low: 3 };

function clampScore(n) {
  return Math.max(5, Math.min(100, Math.round(n)));
}

function normalizeUrl(input) {
  let value = String(input || "").trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = "https://" + value;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml,text/plain",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, finalUrl: res.url, ms: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: "",
      ms: Date.now() - start,
      error: err.name === "AbortError" ? "The request timed out." : "Could not connect to that site.",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const target = normalizeUrl(body?.url);
  if (!target) {
    return Response.json({ error: "That doesn't look like a valid URL." }, { status: 400 });
  }

  const page = await fetchWithTimeout(target.toString());
  if (!page.ok || !page.text) {
    return Response.json(
      { error: page.error || `The site responded with a ${page.status} status and returned no readable content.` },
      { status: 502 }
    );
  }

  const origin = `${target.protocol}//${target.host}`;
  const [robots, sitemap] = await Promise.all([
    fetchWithTimeout(`${origin}/robots.txt`, 5000),
    fetchWithTimeout(`${origin}/sitemap.xml`, 5000),
  ]);

  const $ = cheerio.load(page.text);

  const title = $("title").first().text().trim();
  const metaDescription = $('meta[name="description"]').attr("content")?.trim() || "";
  const canonical = $('link[rel="canonical"]').attr("href") || "";
  const h1s = $("h1");
  const h1Text = h1s.first().text().trim();
  const h1Texts = h1s.map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const h2Count = $("h2").length;
  const h2Texts = $("h2").slice(0, 6).map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const h3Texts = $("h3").slice(0, 10).map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const images = $("img");
  const imagesMissingAlt = images.filter((_, el) => !$(el).attr("alt")?.trim()).length;
  const altTexts = images.map((_, el) => $(el).attr("alt")?.trim()).get().filter(Boolean).slice(0, 40);
  const listItemCount = $("ul li, ol li").length;
  const tableCount = $("table").length;
  const anchorTexts = [
    ...new Set(
      $("a[href]").map((_, el) => $(el).text().trim()).get().filter((t) => t && t.length > 1 && t.length < 80)
    ),
  ].slice(0, 40);

  const bodyClone = $("body").clone();
  bodyClone.find("script,style,noscript").remove();
  const bodyText = bodyClone.text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(" ").filter(Boolean).length : 0;
  const bodySnippet = bodyText.slice(0, 900);
  // A larger, still-bounded slice of real page text for the keyword/AEO/GEO
  // intelligence pipelines, which need more than the dashboard's 900-char
  // preview to find real candidate phrases, entities, and questions.
  const fullText = bodyText.slice(0, 6000);

  let internalLinks = 0;
  let externalLinks = 0;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    try {
      const linkUrl = new URL(href, target);
      if (linkUrl.host === target.host) internalLinks++;
      else externalLinks++;
    } catch {
      /* ignore unparsable hrefs */
    }
  });

  const jsonLdBlocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      jsonLdBlocks.push(JSON.parse($(el).contents().text()));
    } catch {
      /* ignore malformed JSON-LD */
    }
  });
  const schemaTypes = [
    ...new Set(
      jsonLdBlocks
        .flatMap((b) => (Array.isArray(b) ? b : [b]))
        .map((x) => x?.["@type"])
        .filter(Boolean)
    ),
  ];

  const htmlSizeKb = Math.round(Buffer.byteLength(page.text, "utf8") / 1024);

  const issues = [];
  const addIssue = (category, severity, title, why, fix, affectedUrls = 1, before = null) =>
    issues.push({ category, severity, title, why, fix, affectedUrls, before });

  const positives = [];
  const addPositive = (category, title, detail) => positives.push({ category, title, detail });

  if (!title) {
    addIssue("On-Page", "Critical", "Missing page title",
      "The title tag is the first thing a searcher reads in results, and a missing one lets the system generate a weaker, less relevant one instead.",
      "Add a unique, descriptive <title> tag under 60 characters.", 1, "(no <title> tag found)");
  } else if (title.length > 60) {
    addIssue("On-Page", "Low", `Title tag is ${title.length} characters (recommended under 60)`,
      "Long titles get truncated in search results, hiding the end of your message.",
      "Shorten the title to the most important keyword and brand name.", 1, title);
  } else {
    addPositive("On-Page", "Title tag is present and well-sized",
      `The current title — "${title}" — is ${title.length} characters, within Google's typical display limit.`);
  }

  if (!metaDescription) {
    addIssue("On-Page", "Medium", "Missing meta description",
      "Without a description, search engines write their own snippet, which is often less compelling and less relevant to the searcher.",
      "Write a unique 150–160 character description that summarizes the page and gives a reason to click.", 1, "(no meta description tag found)");
  } else if (metaDescription.length > 160) {
    addIssue("On-Page", "Low", `Meta description is ${metaDescription.length} characters (recommended under 160)`,
      "Long descriptions get cut off in search results.",
      "Trim the description down to the essential value proposition.", 1, metaDescription);
  } else {
    addPositive("On-Page", "Meta description is present and well-sized",
      `The current description is ${metaDescription.length} characters, within the range search engines typically display in full.`);
  }

  if (h1s.length === 0) {
    addIssue("On-Page", "High", "Missing H1 heading",
      "The H1 tells both readers and search engines what the page is about at a glance.",
      "Add a single, descriptive H1 that matches the page's primary topic.", 1, "(no H1 tag found on the page)");
  } else if (h1s.length > 1) {
    addIssue("On-Page", "Low", `Page has ${h1s.length} H1 tags (recommended: 1)`,
      "Multiple H1s dilute the page's topical signal and can confuse the heading hierarchy.",
      "Keep one H1 and demote the others to H2 or H3.", 1, `First H1: "${h1Text}" (plus ${h1s.length - 1} more)`);
  } else {
    addPositive("On-Page", "Single, clear H1 heading", `The page has exactly one H1: "${h1Text}".`);
  }

  if (!canonical) {
    addIssue("Technical", "Medium", "Missing canonical tag",
      "Without a canonical signal, search engines may index the wrong version of a page or split ranking signals across duplicates.",
      "Add a self-referencing canonical tag to this page.", 1, "(no <link rel=\"canonical\"> tag found)");
  } else {
    addPositive("Technical", "Canonical tag set", `Canonical points to ${canonical}.`);
  }

  if (imagesMissingAlt > 0) {
    addIssue("On-Page", "Medium", `${imagesMissingAlt} image${imagesMissingAlt > 1 ? "s" : ""} missing ALT text`,
      "Alt text is the only description of an image available to assistive technology, and it also gives search engines extra topical context.",
      "Add concise, descriptive alt text to every content image.", imagesMissingAlt, `${imagesMissingAlt} of ${images.length} images have no alt attribute`);
  } else if (images.length > 0) {
    addPositive("On-Page", "All images have ALT text", `All ${images.length} images on the page have alt attributes set.`);
  }

  if (wordCount > 0 && wordCount < 300) {
    addIssue("Content", "High", `Thin content: only ${wordCount} words on the page`,
      "Pages under 300 words rarely provide enough context for a reader or a search engine to judge relevance.",
      "Expand the page with concrete detail, examples, and answers to real buyer questions.", 1, `Page currently has ${wordCount} words`);
  } else if (wordCount >= 300) {
    addPositive("Content", "Content depth looks healthy", `The page has ${wordCount} words, past the thin-content threshold.`);
  }

  if (schemaTypes.length === 0) {
    addIssue("Schema", "High", "No structured data (schema.org) found",
      "Structured data helps search and AI systems understand exactly what the page is about and confirms key facts with confidence.",
      "Add relevant JSON-LD schema, such as Organization, Product, Article, or FAQPage.", 1, "(no JSON-LD script tags found)");
  } else {
    addPositive("Schema", "Structured data found", `Found ${schemaTypes.join(", ")} schema on the page.`);
  }

  if (!robots.ok) {
    addIssue("Indexing", "Medium", "robots.txt not found or unreachable",
      "Without a robots.txt file, you lose an easy way to guide crawlers and point them to your sitemap.",
      "Add a robots.txt file at the site root.");
  } else if (/disallow:\s*\/\s*$/im.test(robots.text)) {
    addIssue("Indexing", "Critical", "robots.txt is blocking the entire site",
      "A blanket disallow rule prevents search engines from crawling any page on the site.",
      "Remove the sitewide disallow rule from robots.txt.", 1, "Disallow: /");
  } else {
    addPositive("Indexing", "robots.txt found and not blocking the site", "A robots.txt file exists and doesn't disallow the whole site.");
  }

  if (!sitemap.ok) {
    addIssue("Indexing", "Low", "sitemap.xml not found at the default location",
      "Search engines discover URLs faster through a sitemap; without one at the standard path, discovery relies entirely on crawling links.",
      "Generate a sitemap.xml and reference it from robots.txt.");
  } else {
    addPositive("Indexing", "sitemap.xml found", "A sitemap exists at the default location, helping search engines discover your pages.");
  }

  if (page.ms > 3000) {
    addIssue("Technical", "Medium", `Page took ${(page.ms / 1000).toFixed(1)}s to respond`,
      "A slow server response delays everything else on the page and can cause visitors to leave before it loads.",
      "Investigate server response time — check hosting, caching, and any blocking server-side work.", 1, `Server responded in ${page.ms}ms`);
  } else {
    addPositive("Technical", "Fast server response", `The page responded in ${page.ms}ms.`);
  }

  const technicalIssues = issues.filter((i) => ["Technical", "Indexing", "Schema"].includes(i.category));
  const onPageIssues = issues.filter((i) => ["On-Page", "Content"].includes(i.category));
  const technicalScore = clampScore(100 - technicalIssues.reduce((s, i) => s + (SEVERITY_PENALTY[i.severity] || 0), 0));
  const contentScore = clampScore(100 - onPageIssues.reduce((s, i) => s + (SEVERITY_PENALTY[i.severity] || 0), 0));

  return Response.json({
    url: target.toString(),
    finalUrl: page.finalUrl,
    statusCode: page.status,
    loadTimeMs: page.ms,
    htmlSizeKb,
    fetchedAt: new Date().toISOString(),
    meta: {
      title, titleLength: title.length, metaDescription, metaDescriptionLength: metaDescription.length,
      canonical, h1Text, h1Texts, h1Count: h1s.length, h2Count, h2Texts, h3Texts,
      imagesTotal: images.length, imagesMissingAlt, altTexts, wordCount,
      bodySnippet, fullText, internalLinks, externalLinks, schemaTypes, schemaRaw: jsonLdBlocks.slice(0, 10),
      listItemCount, tableCount, anchorTexts,
      robotsFound: robots.ok, sitemapFound: sitemap.ok,
      domain: target.host,
    },
    issues,
    positives,
    scores: { technical: technicalScore, content: contentScore },
  });
}
