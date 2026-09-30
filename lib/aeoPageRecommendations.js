// Turns a page's failed AEO signals into concrete, page-specific fixes.
//
// This is the deterministic (no-AI) half of "weak page recommendations":
// every item here is derived from a signal the crawl actually found missing,
// and carries the exact number of points fixing it would add to that page's
// score (the AEO weights sum to 100, so weight === points). The AI layer in
// app/api/site-aeo-analysis/route.js only adds page-specific wording on top
// (suggested questions, rewrite tips) and can fail without losing any of this.

/** Utility pages exist to be complete and correct, not to be cited as an
 *  "answer". A low AEO score there is expected — we still give useful fixes,
 *  but tell the user not to over-invest. */
const PAGE_TYPE_RULES = [
  ["contact", /(^|[\/\-_])(contact|get-in-touch|support)([\/\-_.]|$)|contact us/i],
  ["legal", /privacy|terms|cookie|refund|disclaimer|legal|gdpr/i],
  ["about", /(^|[\/\-_])about([\/\-_.\s:]|$)|about us|our story/i],
  ["blog-index", /(^|\/)blog\/?$|^blog\b/i],
  ["article", /\/blog\/|\/articles?\/|\/news\/|\/guides?\/|\/resources?\/|\/posts?\//i],
];

export function inferPageType(page) {
  const url = String(page?.url || "");
  const title = String(page?.title || "");
  let path = url;
  try { path = new URL(url).pathname; } catch { /* keep raw url */ }
  for (const [type, re] of PAGE_TYPE_RULES) {
    if (re.test(path) || (type !== "article" && re.test(title.split(/[—|–-]/)[0] || ""))) return type;
  }
  if (/\bblog\b/i.test(title) && (page?.wordCount || 0) > 600) return "article";
  return path === "/" || path === "" ? "home" : "content";
}

export const UTILITY_TYPES = new Set(["contact", "legal"]);

const PAGE_TYPE_LABEL = {
  contact: "Contact page", legal: "Legal / policy page", about: "About page", "blog-index": "Blog index",
  article: "Article", home: "Homepage", content: "Content page",
};

// Which signals make sense to ask for on which page type. Anything not listed
// for a type is asked for normally.
const NOT_APPLICABLE = {
  contact: ["hasTableMarkup", "hasDirectAnswerParagraph", "hasHowToSchema", "hasQaSchema", "hasListMarkup", "contentDepthOk"],
  legal: ["hasTableMarkup", "hasDirectAnswerParagraph", "hasHowToSchema", "hasQaSchema", "hasFaqSchema", "hasExistingQuestionsInBody", "contentDepthOk"],
  "blog-index": ["hasTableMarkup", "hasDirectAnswerParagraph", "hasHowToSchema", "hasQaSchema", "hasFaqSchema", "hasExistingQuestionsInBody", "contentDepthOk"],
  about: ["hasTableMarkup", "hasHowToSchema", "hasQaSchema"],
  home: ["hasHowToSchema", "hasQaSchema"],
  article: [],
  content: ["hasQaSchema"],
};

const NAME = (page) => (page?.title || "this page").split(/\s[—|–]\s/)[0].trim() || "this page";

// One fix per signal. `text` may be page-type specific.
function fixFor(key, type, page) {
  const wc = page?.wordCount || 0;
  const subject = NAME(page);
  switch (key) {
    case "hasFaqSchema":
      return {
        label: "Add FAQ schema",
        action: type === "contact"
          ? "Add a short FAQ block (response time, opening hours, how to reach support, where you operate) and mark it up as FAQPage JSON-LD so answer engines can quote it directly."
          : `Add a 4–6 question FAQ section to \"${subject}\" answering what a buyer would ask next, then mark it up as FAQPage JSON-LD. Keep each answer to 1–3 sentences and identical to the visible text.`,
      };
    case "hasHowToSchema":
      return { label: "Add HowTo schema", action: "If the page walks through steps, wrap them in a numbered list and add HowTo JSON-LD (name, step[].name, step[].text). Skip this if the page isn't procedural." };
    case "hasQaSchema":
      return { label: "Add Q&A schema", action: "Only relevant if the page shows a single question with community/expert answers. Otherwise prefer FAQPage schema and leave this one." };
    case "hasAnySchema":
      return {
        label: "Add structured data",
        action: type === "contact" ? "Add ContactPage + Organization JSON-LD with your email, phone, address and opening hours."
          : type === "about" ? "Add Organization JSON-LD (name, logo, url, sameAs profiles, foundingDate) plus AboutPage."
          : type === "article" ? "Add Article/BlogPosting JSON-LD with headline, author, datePublished, dateModified and image."
          : type === "legal" ? "Add WebPage JSON-LD with name and dateModified so the policy's last-updated date is machine-readable."
          : "Add JSON-LD that matches the page (WebPage at minimum; Product/Service/SoftwareApplication if it describes an offering).",
      };
    case "hasListMarkup":
      return { label: "Use real lists", action: "Turn comma-separated or paragraph-buried points into <ul>/<ol> lists (3+ items). Lists are the format answer engines lift most easily — e.g. steps, features, requirements." };
    case "hasTableMarkup":
      return { label: "Add a comparison table", action: "Add a <table> that compares options, plans or before/after (e.g. features by plan, or old vs new approach). Only add it where a comparison genuinely exists." };
    case "hasMultipleHeadings":
      return { label: "Break into headed sections", action: `Split the content into at least two H2/H3 sections with descriptive headings so each part can be cited on its own${wc ? ` (currently ${wc} words with too few headings)` : ""}.` };
    case "hasQuestionHeading":
      return {
        label: "Phrase a heading as a question",
        action: type === "legal" ? "Rename key section headings as questions, e.g. \"What data do we collect?\", \"How long do we keep it?\", \"How do I delete my account?\", and put the plain answer in the first sentence beneath each."
          : type === "contact" ? "Add headings such as \"How can I contact us?\" and \"How quickly do you respond?\" with the answer directly underneath."
          : `Turn at least one H2 on \"${subject}\" into the exact question a buyer would type (\"How does … work?\", \"What is …?\") and answer it in the first sentence under it.`,
      };
    case "hasDirectAnswerParagraph":
      return { label: "Add a direct-answer paragraph", action: `Open with a 1–2 sentence definition or answer near the top, written as a full statement (\"${subject} is a … that helps … to …\"). This is the passage answer engines most often quote.` };
    case "hasExistingQuestionsInBody":
      return { label: "Write questions into the body", action: "Include the questions your customers actually ask as literal sentences ending in \"?\" followed by the answer (an FAQ, a \"Common questions\" block, or a Q&A section)." };
    case "contentDepthOk":
      return { label: "Add depth", action: `The page has ${wc} words; pages under 300 rarely give enough context to cite. Add concrete detail — examples, numbers, who it's for, and what to do next — rather than filler.` };
    default:
      return { label: key, action: "Improve this signal." };
  }
}

const IMPACT_ORDER = ["hasFaqSchema", "hasMultipleHeadings", "hasQuestionHeading", "hasListMarkup", "hasDirectAnswerParagraph", "hasAnySchema", "hasExistingQuestionsInBody", "contentDepthOk", "hasTableMarkup", "hasHowToSchema", "hasQaSchema"];

/**
 * @param page    crawled page object
 * @param flags   computeAeoSignals(page)
 * @param weights AEO_WEIGHTS
 * @param score   the page's current score (0-100)
 */
export function buildPageRecommendations(page, flags, weights, score) {
  const type = inferPageType(page);
  const skip = new Set(NOT_APPLICABLE[type] || []);
  const missing = Object.keys(weights).filter((k) => !flags[k]);

  const fixes = missing
    .filter((k) => !skip.has(k))
    .map((k) => ({ key: k, points: weights[k], ...fixFor(k, type, page) }))
    .sort((a, b) => b.points - a.points || IMPACT_ORDER.indexOf(a.key) - IMPACT_ORDER.indexOf(b.key));

  const skipped = missing.filter((k) => skip.has(k));
  const gain = fixes.reduce((sum, f) => sum + f.points, 0);
  const potentialScore = Math.min(100, score + gain);

  const utility = UTILITY_TYPES.has(type) || type === "blog-index";
  const note = utility
    ? `${PAGE_TYPE_LABEL[type]}s aren't usually where answer engines look for answers, so a low score here is normal. The fixes below are light-touch; put your effort into content pages first.`
    : null;

  return {
    pageType: type,
    pageTypeLabel: PAGE_TYPE_LABEL[type],
    wordCount: page?.wordCount || 0,
    priority: utility ? "Low" : score < 40 ? "High" : score < 70 ? "Medium" : "Low",
    potentialScore,
    fixes,
    notApplicableCount: skipped.length,
    note,
  };
}
