// Deterministic, non-AI extraction over real crawled page data.
//
// This is the "crawl-first" evidence layer required by the Keyword
// Intelligence / AEO / GEO modules: every candidate keyword, entity,
// question, and signal flag produced here comes directly from counting
// and pattern-matching the actual HTML/text VertexRank crawled — nothing
// here is invented. AI is only ever handed this evidence and asked to
// classify/enrich/reason over it (see app/api/*-analysis routes), never
// asked to "analyze this website" cold.

const STOPWORDS = new Set([
  "a","an","the","and","or","but","if","then","so","of","to","in","on","for","with","at","by","from",
  "up","down","out","about","into","over","after","is","are","was","were","be","been","being","this",
  "that","these","those","it","its","as","we","you","your","our","us","i","they","he","she","them",
  "his","her","their","not","no","yes","can","will","would","should","could","may","might","must",
  "do","does","did","have","has","had","also","just","than","too","very","more","most","some","any",
  "all","each","other","such","only","own","same","so","s","t","don","now","here","there","when",
  "where","why","how","what","which","who","whom","get","got","using","use","used","new"
]);

const QUESTION_STARTERS = ["what","how","why","where","which","who","when","is","are","can","does","do","should","will"];
const COMMERCIAL_WORDS = ["price","pricing","cost","cheap","affordable","discount","deal","buy","order","quote","plan","plans","package","packages"];
const TRANSACTIONAL_WORDS = ["buy","order","purchase","sign up","signup","get started","book","hire","request demo","free trial","subscribe"];
const LOCAL_WORDS = ["near me","in kenya","nairobi","location","branch","locations","service area","delivery area"];
const NAVIGATIONAL_HINTS = ["login","log in","sign in","dashboard","careers","contact us"];

function clean(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function tokenize(text) {
  return clean(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s\-']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function isStopToken(tok) {
  return STOPWORDS.has(tok) || tok.length < 2;
}

/** Build weighted n-gram frequency candidates (1-3 words) from a token stream,
 *  dropping phrases that start or end on a stopword (keeps real phrases like
 *  "point of sale software" out of fragments like "of sale"). */
function ngramCounts(tokens, weight, into) {
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const slice = tokens.slice(i, i + n);
      if (isStopToken(slice[0]) || isStopToken(slice[slice.length - 1])) continue;
      if (n === 1 && isStopToken(slice[0])) continue;
      const phrase = slice.join(" ");
      if (phrase.length < 3) continue;
      into.set(phrase, (into.get(phrase) || 0) + weight);
    }
  }
}

/** Returns true if `haystack` contains `needle` as a whole-ish phrase (case-insensitive). */
function textIncludes(haystack, needle) {
  if (!haystack || !needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0, idx = 0;
  while (true) {
    const found = h.indexOf(n, idx);
    if (found === -1) break;
    count++;
    idx = found + n.length;
  }
  return count;
}

function classifyIntent(phrase) {
  const p = phrase.toLowerCase();
  if (QUESTION_STARTERS.some((q) => p.startsWith(q + " "))) return "Informational";
  if (TRANSACTIONAL_WORDS.some((w) => p.includes(w))) return "Transactional";
  if (COMMERCIAL_WORDS.some((w) => p.includes(w))) return "Commercial";
  if (NAVIGATIONAL_HINTS.some((w) => p.includes(w))) return "Navigational";
  if (LOCAL_WORDS.some((w) => p.includes(w))) return "Commercial";
  return "Informational";
}

function classifyType(phrase, wordCount) {
  const p = phrase.toLowerCase();
  if (QUESTION_STARTERS.some((q) => p.startsWith(q + " "))) return "Question";
  if (LOCAL_WORDS.some((w) => p.includes(w))) return "Local";
  if (TRANSACTIONAL_WORDS.some((w) => p.includes(w))) return "Transactional";
  if (COMMERCIAL_WORDS.some((w) => p.includes(w))) return "Commercial";
  if (wordCount === 1) return "Primary";
  if (wordCount === 2) return "Secondary";
  return "Long-tail";
}

/**
 * Extract ranked keyword candidates directly from crawled page fields.
 * `crawl` is the shape returned by app/api/scan (meta object).
 */
export function extractKeywordCandidates(crawl, limit = 60) {
  const title = clean(crawl.title);
  const metaDescription = clean(crawl.metaDescription);
  const h1 = clean(crawl.h1Text);
  const h2h3 = clean([...(crawl.h2Texts || []), ...(crawl.h3Texts || [])].join(" . "));
  const alt = clean((crawl.altTexts || []).join(" . "));
  const body = clean(crawl.fullText || crawl.bodySnippet);
  const schemaText = clean(JSON.stringify(crawl.schemaRaw || crawl.schemaTypes || ""));

  const scores = new Map();
  ngramCounts(tokenize(title), 6, scores);
  ngramCounts(tokenize(h1), 5, scores);
  ngramCounts(tokenize(h2h3), 3, scores);
  ngramCounts(tokenize(metaDescription), 2, scores);
  ngramCounts(tokenize(alt), 2, scores);
  ngramCounts(tokenize(body), 1, scores);

  const candidates = [...scores.entries()]
    .filter(([phrase]) => phrase.split(" ").length <= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([phrase, score]) => {
      const wc = phrase.split(" ").length;
      const bodyOccurrences = countOccurrences(body, phrase);
      return {
        keyword: phrase,
        score: Math.round(score),
        wordCount: wc,
        type: classifyType(phrase, wc),
        intent: classifyIntent(phrase),
        usage: {
          title: textIncludes(title, phrase),
          metaDescription: textIncludes(metaDescription, phrase),
          h1: textIncludes(h1, phrase),
          h2h3: textIncludes(h2h3, phrase),
          body: bodyOccurrences,
          alt: textIncludes(alt, phrase),
          schema: textIncludes(schemaText, phrase),
        },
      };
    })
    .filter((k) => k.usage.body > 0 || k.usage.title || k.usage.h1 || k.usage.h2h3 || k.usage.alt);

  return candidates;
}

/** Rough proper-noun / entity phrase extraction (brands, products, places,
 *  people) from the crawled title/headings/body — capitalized sequences
 *  that aren't just a sentence starting a new line. */
export function extractEntityCandidates(crawl, limit = 25) {
  const source = [crawl.title, crawl.h1Text, ...(crawl.h2Texts || []), crawl.bodySnippet || crawl.fullText]
    .filter(Boolean)
    .join(" . ");
  const regex = /\b([A-Z][a-zA-Z0-9&']*(?:\s+[A-Z][a-zA-Z0-9&']*){0,3})\b/g;
  const counts = new Map();
  let m;
  while ((m = regex.exec(source))) {
    const phrase = m[1].trim();
    const words = phrase.split(/\s+/);
    if (words.length === 1 && words[0].length < 3) continue;
    if (STOPWORDS.has(phrase.toLowerCase())) continue;
    counts.set(phrase, (counts.get(phrase) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([entity, count]) => ({ entity, occurrences: count }));
}

/** Pull real questions the page already asks/answers verbatim (sentences
 *  ending in "?" inside the visible body text) — genuine crawled evidence
 *  of existing AEO coverage, not a guess. */
export function extractExistingQuestions(crawl) {
  const body = clean(crawl.fullText || crawl.bodySnippet);
  const sentences = body.split(/(?<=[.?!])\s+/);
  return sentences.filter((s) => s.trim().endsWith("?") && s.trim().length > 8).slice(0, 20);
}

/** Deterministic AEO readiness signal checklist — every flag is a direct
 *  fact about the crawled page, so the resulting score is fully explainable. */
export function computeAeoSignals(crawl) {
  const schemaTypes = crawl.schemaTypes || [];
  const body = clean(crawl.fullText || crawl.bodySnippet).toLowerCase();
  const h2h3 = [...(crawl.h2Texts || []), ...(crawl.h3Texts || [])];
  const flags = {
    hasFaqSchema: schemaTypes.includes("FAQPage"),
    hasHowToSchema: schemaTypes.includes("HowTo"),
    hasQaSchema: schemaTypes.includes("QAPage"),
    hasAnySchema: schemaTypes.length > 0,
    hasListMarkup: (crawl.listItemCount || 0) >= 3,
    hasTableMarkup: (crawl.tableCount || 0) >= 1,
    hasMultipleHeadings: h2h3.length >= 2,
    hasQuestionHeading: h2h3.some((h) => /^(what|how|why|where|which|who|when|is|are|can|does|do)\b/i.test(h.trim())),
    hasDirectAnswerParagraph: /\b(is a|refers to|means|is defined as|is the process of)\b/.test(body),
    hasExistingQuestionsInBody: extractExistingQuestions(crawl).length > 0,
    contentDepthOk: (crawl.wordCount || 0) >= 300,
  };
  return flags;
}

/** Deterministic GEO / entity-clarity + authority signal checklist. */
export function computeGeoSignals(crawl) {
  const schemaTypes = crawl.schemaTypes || [];
  const body = clean(crawl.fullText || crawl.bodySnippet);
  const bodyLower = body.toLowerCase();
  const title = (crawl.title || "").toLowerCase();
  const h1 = (crawl.h1Text || "").toLowerCase();
  const emailRegex = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  const phoneRegex = /(\+?\d[\d\s().-]{7,}\d)/;
  return {
    hasOrganizationSchema: schemaTypes.some((t) => ["Organization", "LocalBusiness", "Corporation"].includes(t)),
    hasProductOrServiceSchema: schemaTypes.some((t) => ["Product", "Service", "Offer"].includes(t)),
    hasArticleOrAuthorSchema: schemaTypes.some((t) => ["Article", "Person", "BlogPosting", "NewsArticle"].includes(t)),
    hasContactSignal: /contact us|contact form|get in touch/.test(bodyLower) || emailRegex.test(body) || phoneRegex.test(body),
    hasAboutSignal: /about us|our story|who we are|our mission/.test(bodyLower) || /about/.test(title) || /about/.test(h1),
    hasLocationSignal: /located in|based in|headquartered|address|nairobi|kenya|our office/.test(bodyLower),
    hasAudienceSignal: /for small businesses|for startups|for teams|for enterprises|designed for|built for/.test(bodyLower),
    hasCredentialSignal: /certified|licensed|accredited|award|years of experience|trusted by/.test(bodyLower),
    hasSocialProofSignal: /testimonial|review|case study|client says|customers say|rated/.test(bodyLower),
    hasPolicySignal: /privacy policy|terms of service|refund policy|terms and conditions/.test(bodyLower),
    hasClearProductNaming: !!(crawl.title && crawl.h1Text),
  };
}

/** Turn a boolean-flag object into a transparent, additive 0-100 score plus
 *  a human-readable breakdown — used for every "explainable" score in the
 *  Keyword/AEO/GEO modules instead of asking AI to invent a number. */
export function scoreFromFlags(flags, weights) {
  let total = 0, max = 0;
  const breakdown = [];
  for (const [key, weight] of Object.entries(weights)) {
    max += weight;
    const hit = !!flags[key];
    if (hit) total += weight;
    breakdown.push({ key, weight, hit });
  }
  const score = max > 0 ? Math.round((total / max) * 100) : 0;
  return { score, breakdown };
}

export function truncate(text, max) {
  const t = String(text || "");
  return t.length > max ? t.slice(0, max) + "…" : t;
}
