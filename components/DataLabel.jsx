import { DATA_LABEL_KINDS } from "../lib/dataLabel";

/**
 * Renders one of the three data-provenance badges (see lib/dataLabel.js).
 * Deliberately mirrors the existing, unexported `Badge` component in
 * components/VertexRank.jsx exactly (same className, same inline
 * {fg,bg} color pattern) so it's visually indistinguishable from the
 * severity/status/priority badges already throughout the app — this is a
 * new label *kind*, not a new visual language.
 *
 * Usage:
 *   <DataLabel kind="observed">12 internal links</DataLabel>
 *   <DataLabel kind="ai_analysis">Internal linking is weak</DataLabel>
 *   <DataLabel kind="ai_estimate">High opportunity</DataLabel>
 *
 * Or, paired with lib/dataLabel.js's withLabel() on the API side, render
 * straight from a labeled API field without repeating the kind string:
 *   <DataLabel kind={field.kind}>{field.value}</DataLabel>
 *
 * To show the three-step chain from the feature spec ("Observed: 12
 * internal links → AI Analysis: internal linking is weak → AI Estimate:
 * high opportunity"), compose them with <DataLabelChain>:
 *   <DataLabelChain items={[
 *     { kind: "observed", text: "12 internal links" },
 *     { kind: "ai_analysis", text: "Internal linking is weak" },
 *     { kind: "ai_estimate", text: "High opportunity" },
 *   ]} />
 */
export function DataLabel({ kind, children, title }) {
  const meta = DATA_LABEL_KINDS[kind];
  if (!meta) return null; // fail quiet in the UI; withLabel() already fails loud at write time
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ color: meta.color.fg, background: meta.color.bg }}
      title={title || meta.description}
    >
      <span className="font-semibold">{meta.label}:</span>
      {children}
    </span>
  );
}

export function DataLabelChain({ items }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-gray-300" aria-hidden="true">→</span>}
          <DataLabel kind={item.kind}>{item.text}</DataLabel>
        </span>
      ))}
    </div>
  );
}
