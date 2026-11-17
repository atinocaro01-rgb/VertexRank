// Content-idea tracking helpers (pure, client-safe). Tests: tests/contentIdeas.test.mjs.
//
// Colour/stage model used by the calendar and the list: blue = idea, amber = draft written, green = published.
// The stage comes ONLY from the idea's `status`, so you can mark any topic yourself, including content you wrote outside the tool.
// (The article writer still moves an "Idea" to "Drafting" when it saves a draft.)

export const STATUSES = ["Idea", "Drafting", "Ready", "Published"];
export const STAGES = [
  { id: "idea", label: "Idea", status: "Idea", tone: "primary" },
  { id: "draft", label: "Draft written", status: "Drafting", tone: "amber" },
  { id: "published", label: "Published", status: "Published", tone: "visibility" },
];

/** idea | draft | published. "Ready" counts as a written draft. Anything unknown is an idea. */
export function ideaStage(c) {
  if (c?.status === "Published") return "published";
  if (c?.status === "Drafting" || c?.status === "Ready") return "draft";
  return "idea";
}

/** True when the owner has moved the topic past "idea", has a saved article draft, or added the topic themselves: regenerating never touches these. */
export const USER_SOURCES = ["Added by you", "Search Console query", "Content refresh"]; // topics you chose to add yourself
export const isMarked = (c) => ideaStage(c) !== "idea" || !!c?.draft || USER_SOURCES.includes(c?.source);

/** Splits ideas for a regenerate: `kept` (marked) stay as they are; `replace` (still plain blue ideas) are swapped for fresh ones. */
export function splitForRegenerate(ideas) {
  const kept = [], replace = [];
  for (const c of Array.isArray(ideas) ? ideas : []) (isMarked(c) ? kept : replace).push(c);
  return { kept, replace };
}

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

/** Adds titles to the "I don't want these" list (newest first, no repeats, capped) so a regenerate won't bring them back. */
export function rememberRejected(list, titles, cap = 80) {
  const out = [], seen = new Set();
  for (const t of [...(Array.isArray(titles) ? titles : [titles]), ...(Array.isArray(list) ? list : [])]) {
    const v = norm(t).slice(0, 160); const k = v.toLowerCase();
    if (v && !seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out.slice(0, cap);
}

/** How many new topics to ask for: a month's worth minus what is already kept on the calendar. Never fewer than 6. */
export function regenerateSize(keptCount, total = 30) {
  return Math.max(6, Math.min(total, total - (Number(keptCount) || 0)));
}

/** Days (YYYY-MM-DD) already taken by kept topics, so fresh topics are scheduled around them. */
export function occupiedDays(kept) {
  return [...new Set((Array.isArray(kept) ? kept : []).map((c) => c?.scheduledFor).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "")))];
}
