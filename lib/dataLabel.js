// Feature ⑤: a shared, explicit convention for labeling every piece of data
// shown in the UI as one of three kinds, so users never have to guess
// whether something is a hard fact, an AI's read of that fact, or a
// prediction:
//
//   observed    — directly read from the website or a connected data
//                 source. Not generated, not inferred. e.g. "12 internal
//                 links", "missing meta description", "wordCount: 480".
//   ai_analysis — a conclusion an AI model drew FROM observed evidence.
//                 Should always be traceable to specific observed data.
//                 e.g. "internal linking is weak" (drawn from the observed
//                 link count/graph).
//   ai_estimate — a prediction/scored judgment produced by this app's own
//                 scoring logic or an AI model, without a single directly
//                 observable ground truth. e.g. "high opportunity",
//                 "likely to rank within 3 months".
//
// This file is intentionally framework-agnostic (no React import) so API
// route handlers can also tag response fields with these kinds — e.g.
// { value: 12, kind: "observed" } — and the UI component just renders
// whatever kind is present, rather than each route inventing its own
// wording. See components/DataLabel.jsx for the matching badge component.
//
// Colors intentionally reuse the app's existing BRAND palette
// (components/VertexRank.jsx) rather than introducing new ones:
//   observed    -> the same neutral gray used for "New"/"Low" (a plain fact
//                  isn't inherently good or bad news)
//   ai_analysis -> the app's primary indigo (this IS the app's own
//                  intelligence at work)
//   ai_estimate -> the same amber used for "Medium"/"Pending" (a prediction
//                  deserves a little more scrutiny than a stated fact)
// If VertexRank.jsx's BRAND palette ever changes, update the three hex
// pairs below to match — they're duplicated rather than imported so this
// file has no dependency on that 3,000+ line component.

export const DATA_LABEL_KINDS = {
  observed: {
    id: "observed",
    label: "Observed",
    description: "Read directly from the website or a connected data source — not generated or inferred.",
    color: { fg: "#4C5468", bg: "#EEEFF3" },
  },
  ai_analysis: {
    id: "ai_analysis",
    label: "AI Analysis",
    description: "A conclusion an AI model drew from the observed evidence above.",
    color: { fg: "#3C2FD9", bg: "#EDEBFC" },
  },
  ai_estimate: {
    id: "ai_estimate",
    label: "AI Estimate",
    description: "A prediction or opportunity score — not a directly observed fact.",
    color: { fg: "#C97A1E", bg: "#FBEFDF" },
  },
};

export function isDataLabelKind(value) {
  return Object.prototype.hasOwnProperty.call(DATA_LABEL_KINDS, value);
}

/** Wraps a value with its provenance kind — the shape every API route
 * should use when returning a field that needs labeling in the UI.
 * Throws early (at write time, not render time) if a route passes a typo'd
 * kind, rather than silently rendering nothing. */
export function withLabel(kind, value, extra) {
  if (!isDataLabelKind(kind)) {
    throw new Error(`Unknown data label kind "${kind}". Must be one of: ${Object.keys(DATA_LABEL_KINDS).join(", ")}`);
  }
  return { kind, value, ...extra };
}
