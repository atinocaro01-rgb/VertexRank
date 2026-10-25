// Module-resolution hooks for the crawler end-to-end test: swaps in a tiny cheerio stand-in and an
// in-memory fake web (so the REAL crawlSite control flow runs without npm packages or a network).
export async function resolve(specifier, context, next) {
  if (specifier === "cheerio") return { url: new URL("./stubs/cheerio.mjs", import.meta.url).href, shortCircuit: true };
  if (specifier.endsWith("/safeFetch.js") && String(context.parentURL).endsWith("/lib/siteCrawler.js")) {
    return { url: new URL("./stubs/safeFetch.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
