import * as cheerio from "cheerio";

const USER_AGENT = "Mozilla/5.0 (compatible; VertexRankBot/1.0; +https://vertexrank.app/bot)";

export function normalizeUrl(input) {
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
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: "", error: err.name === "AbortError" ? "The request timed out." : "Could not connect to that site." };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch and extract the same shape of structured page data as app/api/scan,
 *  used for lightweight, publicly-crawlable competitor comparison. Only
 *  reads what's already publicly served by the page — no login, no
 *  simulated data. */
export async function crawlPage(rawUrl) {
  const target = normalizeUrl(rawUrl);
  if (!target) return { error: "That doesn't look like a valid URL." };

  const page = await fetchWithTimeout(target.toString());
  if (!page.ok || !page.text) {
    return { error: page.error || `The site responded with a ${page.status} status and returned no readable content.` };
  }

  const $ = cheerio.load(page.text);
  const title = $("title").first().text().trim();
  const metaDescription = $('meta[name="description"]').attr("content")?.trim() || "";
  const h1Text = $("h1").first().text().trim();
  const h2Texts = $("h2").slice(0, 6).map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const h3Texts = $("h3").slice(0, 10).map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const altTexts = $("img").map((_, el) => $(el).attr("alt")?.trim()).get().filter(Boolean).slice(0, 40);

  const bodyClone = $("body").clone();
  bodyClone.find("script,style,noscript").remove();
  const bodyText = bodyClone.text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(" ").filter(Boolean).length : 0;
  const fullText = bodyText.slice(0, 6000);
  const bodySnippet = bodyText.slice(0, 900);

  const jsonLdBlocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { jsonLdBlocks.push(JSON.parse($(el).contents().text())); } catch {}
  });
  const schemaTypes = [...new Set(jsonLdBlocks.flatMap((b) => (Array.isArray(b) ? b : [b])).map((x) => x?.["@type"]).filter(Boolean))];

  return {
    domain: target.host,
    title, metaDescription, h1Text, h2Texts, h3Texts, altTexts,
    wordCount, fullText, bodySnippet, schemaTypes, schemaRaw: jsonLdBlocks.slice(0, 10),
    listItemCount: $("ul li, ol li").length,
    tableCount: $("table").length,
  };
}
