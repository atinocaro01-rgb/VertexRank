// What a "Generate fix" should PRODUCE for a given recommendation. A recommendation says what is wrong and what direction to go;
// the fix is the actual deliverable the person can paste or hand to someone: new title/meta text, an FAQ answer, JSON-LD, an
// internal-link sentence, an outreach email, a rewritten section, a config snippet. The kind picks the instructions the model
// gets, so the output is concrete for that kind of finding. Pure (no I/O); client-safe; tests/recommendationFix.test.mjs.

const RULES = [
  ["schema", /schema|structured data|json-?ld|rich result|markup/i],
  ["entity", /geo\b|entity|about page|contact page|credential|testimonial|authority signal|e-e-a-t|trust/i],
  ["aeo_answer", /\baeo\b|\bfaq\b|answer|question|people also ask|featured snippet|ai visibility|simulator/i],
  ["internal_link", /internal link|anchor text|orphan|weakly linked|inbound link|link to this page/i],
  ["outreach", /backlink|outreach|link building|guest post|citation|mention/i],
  ["competitor_response", /competitor|content gap|they rank|outrank/i],
  ["metadata", /meta description|title tag|\btitle\b.*(long|short|missing|duplicate)|\bh1\b|heading|open graph|snippet/i],
  ["technical", /redirect|canonical|robots|sitemap|hreflang|noindex|status code|404|speed|core web|alt text|alt attribute|https|viewport|crawl|index/i],
  ["content_update", /keyword|content|cannibal|rewrite|\bthin\b|ranks? #|room to climb|top 10|impressions|search console|page two|position/i],
];

/** One of: schema, entity, aeo_answer, internal_link, outreach, competitor_response, metadata, technical, content_update, general. */
export function fixKindFor(rec) {
  // URLs are removed first: "https://…" in the text must not look like a technical finding.
  const text = `${rec?.module || ""} ${rec?.actionType || ""} ${rec?.title || ""} ${rec?.recommendedAction || ""}`.replace(/https?:\/\/\S+/g, " ");
  for (const [kind, re] of RULES) if (re.test(text)) return kind;
  return "general";
}

const ARTIFACT = "Each artifact is { label, format, where, content }: `format` is one of text, html, json, markdown, email; `where` says exactly where it goes (the URL or page and the spot on it).";

export const KIND_GUIDANCE = {
  schema: `Produce the complete JSON-LD <script type="application/ld+json"> block for the right schema.org type(s), using ONLY facts present in the context. Missing required values become [ADD: …]. Also say where to place it and how to test it (Google's Rich Results Test).`,
  entity: `Produce the actual text to add: for an About/Contact/credentials gap, a ready-to-publish section (headline + 80–150 words) built only from facts in the context, with [ADD: …] for every fact you don't have (founding year, credentials, address, team names, awards). Never invent testimonials, awards, numbers or names. Add a matching Organization/LocalBusiness JSON-LD artifact when it fits.`,
  aeo_answer: `Produce the actual answer content: a direct 40–60 word answer that opens with the answer, then a 100–200 word supporting section, as markdown ready to paste under an H2 phrased as the question; plus a FAQPage JSON-LD artifact for the same Q&A. Use only facts from the context; mark missing specifics [ADD: …].`,
  internal_link: `Produce the exact edit: the sentence (or two) to add or change on the source page, with the link written as HTML (<a href="…">anchor</a>) using ONLY URLs from "Known site URLs". Anchor text must be descriptive and natural, not "click here". Say which page it goes on and where in the copy. Give 2–3 alternatives if several source pages fit.`,
  outreach: `Produce a short, specific outreach email (subject + body under 130 words) that offers the recipient a concrete reason to link or mention (what the page gives their readers), written for the site in the context. No flattery filler, no false claims about having read their work unless the context says so; use [ADD: …] for names and specifics you don't have.`,
  competitor_response: `Produce the content that closes the gap: a page outline (H1, H2s with a one-line purpose each) and the opening 120–180 words, written for the site's real business, plus the unique angle (first-hand data, examples, tools) the site can add that a competitor can't copy. Use [ADD: …] where only the site owner can supply a real fact.`,
  metadata: `Produce 3 options for the title tag (≤60 characters) and 3 for the meta description (120–155 characters), plus the H1 if relevant, each containing the page's primary topic naturally, honestly describing the page, and distinct from one another. Show the current value first when it is in the context.`,
  technical: `Produce the exact change: the code, config or markup to apply (HTML, a redirect rule, robots.txt/sitemap line, header, attribute) for the platform in the context when it is known, otherwise a platform-neutral version plus a note on where it goes in WordPress, Next.js and Shopify. Then how to verify it worked.`,
  content_update: `Produce the rewrite: the revised section(s) (markdown) for the page named in the context, improving how well it satisfies the query — direct answer first, covered subtopics, clear headings — while keeping every existing true fact. Include the revised title tag and meta description if they should change. Mark anything only the owner can supply [ADD: …].`,
  general: `Produce the concrete deliverable that carries out the recommended action (text, markup or a checklist the person can use as-is), specific to this website. If the action is a task rather than content, produce the step-by-step brief with exact wording where wording is needed.`,
};

export function kindInstructions(kind) {
  return `${KIND_GUIDANCE[kind] || KIND_GUIDANCE.general} ${ARTIFACT}`;
}
