"use client";

import React, { useState, useContext, createContext, useEffect, useMemo, useRef } from "react";
import {
  LayoutDashboard, Globe2, ListChecks, ClipboardCheck, KeyRound, MessageCircleQuestion,
  Radar as RadarIcon, Users, FileText, Link2, Rss, Plus, Pencil, Trash2, X, Check,
  ChevronDown, ChevronLeft, ChevronRight, Loader2, AlertTriangle, CheckCircle2,
  RefreshCw, Wand2, Zap, Search,
  SlidersHorizontal, ArrowUpDown, Info, Sparkles, ChevronUp, Building2, Newspaper,
  Podcast, Handshake, BookOpen, MapPin, Bot, Target, ShieldCheck, ListPlus, Copy
} from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import {
  GEO_FACTORS, AEO_SIGNAL_LABELS, GEO_AUTHORITY_LABELS, PAGE_EXPORTERS, exportFullReport, buildUnifiedRecs,
  formatRecommendation, formatCompetitor, formatContentIdea, formatIssue, formatAction,
  sectionUnifiedRecs, sectionAiInsights, sectionEntities, sectionKeywordOpportunities, sectionKeywordTable,
  sectionAeoRecommendations, sectionAeoQuestions, sectionGeoOpportunities, sectionSimulator, copyTextToClipboard,
} from "../lib/copyExport";

/* ============================== helpers ============================== */

let idCounter = 1000;
const uid = (p = "id") => `${p}_${(idCounter++).toString(36)}`;

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = Math.imul(31, h) + s.charCodeAt(i) | 0; }
  return h;
}
function rngFor(seedStr) { return mulberry32(hashStr(seedStr) >>> 0); }
function randInt(rng, min, max) { return Math.floor(rng() * (max - min + 1)) + min; }
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function pickN(rng, arr, n) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) {
    const i = Math.floor(rng() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}
function fmtDate(d) {
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtTime(d) {
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function cx(...a) { return a.filter(Boolean).join(" "); }

/** POST JSON to one of our API routes, tolerating a non-JSON response (a
 * platform timeout or crash page instead of our own error JSON) instead of
 * letting a raw "Unexpected token" parse error leak to the user. */
async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("Couldn't reach VertexRank AI — check your connection and try again.");
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(
      res.status === 504
        ? "VertexRank AI took too long to respond that time. Try again — it usually works on a retry."
        : "VertexRank AI ran into an unexpected error. Try again."
    );
  }
  if (!res.ok) throw new Error(data.error || "VertexRank AI couldn't complete this request.");
  return data;
}

const PRIORITY_WEIGHT = { Critical: 20, High: 12, Medium: 6, Low: 2 };
const PRIORITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

/** Transparent, explainable "how much untapped opportunity is left" score:
 *  start at 100 and subtract weighted penalties for each open opportunity,
 *  worst-first. This is computed in the browser from the AI's grounded
 *  opportunity list — never a number the AI invents directly. */
function computeOpportunityScore(opportunities) {
  if (!opportunities || opportunities.length === 0) return null;
  const sorted = [...opportunities].sort((a, b) => (PRIORITY_WEIGHT[b.priority] || 0) - (PRIORITY_WEIGHT[a.priority] || 0));
  let score = 100;
  sorted.slice(0, 10).forEach((o) => { score -= PRIORITY_WEIGHT[o.priority] || 4; });
  return clamp(Math.round(score), 5, 100);
}

function sortByPriority(list) {
  return [...list].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 4) - (PRIORITY_RANK[b.priority] ?? 4));
}

/* ============================== constants ============================== */

const COUNTRIES = ["United States", "United Kingdom", "Canada", "Australia", "Germany", "France", "India", "Kenya", "Brazil", "Japan"];
const INTENTS = ["Informational", "Commercial", "Transactional", "Navigational"];
const ISSUE_CATEGORIES = ["Technical", "Content", "On-Page", "Schema", "Internal Linking", "Indexing"];
const SEVERITIES = ["Critical", "High", "Medium", "Low"];
const ISSUE_STATUSES = ["New", "Pending Approval", "Approved", "Rejected", "Applied", "Verified"];
const ACTION_TYPES = ["Meta Fix", "Content Update", "Schema Markup", "Internal Link", "Technical Fix", "FAQ Addition"];
const PRIORITIES = ["Critical", "High", "Medium", "Low"];

const BRAND = {
  ink: "#161A23",
  inkSoft: "#4C5468",
  canvas: "#F5F6F9",
  surface: "#FFFFFF",
  line: "#E4E6ED",
  primary: "#3C2FD9",
  primarySoft: "#EDEBFC",
  visibility: "#0E9C86",
  visibilitySoft: "#E3F5F1",
  amber: "#C97A1E",
  amberSoft: "#FBEFDF",
  red: "#C7413A",
  redSoft: "#FAEAE9",
};

const SEVERITY_COLOR = {
  Critical: { fg: BRAND.red, bg: BRAND.redSoft },
  High: { fg: "#B4611A", bg: "#FCEEDD" },
  Medium: { fg: BRAND.amber, bg: BRAND.amberSoft },
  Low: { fg: "#4C5468", bg: "#EEEFF3" },
};
const STATUS_COLOR = {
  New: { fg: "#4C5468", bg: "#EEEFF3" },
  "Pending Approval": { fg: BRAND.amber, bg: BRAND.amberSoft },
  Approved: { fg: "#2B60C9", bg: "#E7EFFC" },
  Rejected: { fg: BRAND.red, bg: BRAND.redSoft },
  Applied: { fg: BRAND.visibility, bg: BRAND.visibilitySoft },
  Verified: { fg: "#1F7A46", bg: "#E4F5EA" },
};
const PRIORITY_COLOR = {
  Critical: { fg: BRAND.red, bg: BRAND.redSoft },
  High: { fg: "#B4611A", bg: "#FCEEDD" },
  Medium: { fg: BRAND.amber, bg: BRAND.amberSoft },
  Low: { fg: "#4C5468", bg: "#EEEFF3" },
};
function PriorityBadge({ priority }) { return <Badge color={PRIORITY_COLOR[priority] || PRIORITY_COLOR.Medium}>{priority || "Medium"}</Badge>; }

const NAV = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "scanner", label: "Websites", icon: Globe2 },
  { id: "audit", label: "SEO Audit", icon: ListChecks },
  { id: "actions", label: "Action Center", icon: ClipboardCheck },
  { id: "keywords", label: "Keyword Intelligence", icon: KeyRound },
  { id: "aeo", label: "AEO", icon: MessageCircleQuestion },
  { id: "geo", label: "GEO / AI Visibility", icon: RadarIcon },
  { id: "competitors", label: "Competitors", icon: Users },
  { id: "content", label: "Content Planner", icon: FileText },
  { id: "links", label: "Internal Links", icon: Link2 },
  { id: "backlinks", label: "Backlink Radar", icon: Rss },
];

/* ============================== reference data (not mock content) ============================== */
// These are category/label definitions the UI needs regardless of data source —
// not simulated numbers or fabricated names.

const LOCATIONS = ["Title", "Meta", "H1", "Headings", "Body", "ALT", "FAQ", "Schema"];

const BACKLINK_ICONS = {
  "Business Directory": Building2,
  "Industry Association": Handshake,
  "Resource Page": BookOpen,
  "Publication": Newspaper,
  "Relevant Blog": Rss,
  "Podcast / Interview": Podcast,
};
const BACKLINK_CATEGORIES = Object.keys(BACKLINK_ICONS);
const BACKLINK_DIFFICULTIES = ["Easy", "Moderate", "Competitive"];
const BACKLINK_STATUSES = ["Not started", "In progress", "Submitted"];

/** Maps lib/backlinkClassifier.js's coarse destinationType values (Directory,
 *  Association/Publication, Partner mention, Other) onto this app's existing
 *  backlink-tracker categories, so an auto-discovered prospect lands in a
 *  sensible bucket instead of always falling back to one default. */
function mapBacklinkDestinationType(destinationType) {
  switch (destinationType) {
    case "Directory": return "Business Directory";
    case "Association/Publication": return "Industry Association";
    case "Partner mention": return "Relevant Blog";
    default: return "Resource Page";
  }
}

/** A clean, empty per-website bundle. Technical/Content scores and issues get
 *  filled in from a real scan (see app/api/scan/route.js). AEO, GEO, and Keyword
 *  scores stay null — there's no free source for those yet — and every list
 *  starts empty so users build real data through the CRUD tools instead of
 *  seeing fabricated placeholders. */
function emptyBundle() {
  return {
    scores: { overall: null, aeo: null, geo: null, technical: null, keyword: null, content: null },
    issues: [],
    positives: [],
    aiInsights: null,
    keywords: [],
    aeoQuestions: [],
    geoFactors: {},
    // Crawl-grounded AI intelligence modules (null until the user runs each
    // analysis). Kept separate from the manual `keywords` / `aeoQuestions`
    // trackers above so existing manually-entered data is never touched.
    keywordIntel: null,
    aeoAnalysis: null,
    geoAnalysis: null,
    aiVisibility: null,
    competitorSuggestions: [],
    competitors: [],
    contentIdeas: [],
    internalLinks: [],
    backlinks: [],
    actions: [],
    scanMeta: { live: false },
    // Site-wide (full-crawl) intelligence — all null/empty until the user runs
    // a full-site crawl from Websites, then each module below. Kept separate
    // from the single-page modules above so neither overwrites the other.
    siteCrawl: null, // raw multi-page crawl (lib/siteCrawler.js output) — the shared input every site-wide module below reads from
    siteKeywordClusters: null,
    siteAeoAnalysis: null,
    siteGeoAnalysis: null,
    internalLinkRecs: null,
    siteInsights: null,
  };
}

function initialState() {
  return { websites: [], bundles: {} };
}

/* ============================== persistence (localStorage) ==============================
 * Keeps the workspace (websites, their scan results, and everything built on
 * top — keywords, content ideas, AI insights, etc.) around across a page
 * refresh. This is per-browser storage, not a real database: it doesn't
 * sync across devices or browsers, and clearing browser data wipes it. If
 * you want data to follow a logged-in user across devices, that needs a real
 * backend (a database + accounts) — a separate, bigger step.
 */
const STORAGE_KEY = "vertexrank:v1";
// The app used to be called RankPilot and saved under this key. We still read
// it (once) so nobody loses their workspace in the rename, then move it over.
const LEGACY_STORAGE_KEY = "rankpilot:v1";

function loadPersistedState() {
  if (typeof window === "undefined") return null;
  try {
    let raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    // Analyses saved before the rename carry the old brand in their source
    // labels ("RankPilot AI Analysis", …). Relabel them so nothing old shows.
    const parsed = JSON.parse(raw.replace(/RankPilot AI/g, "VertexRank AI"));
    if (!parsed || typeof parsed !== "object") return null;

    const websites = Array.isArray(parsed.websites) ? parsed.websites.filter((w) => w && w.id) : [];

    // Merge every saved bundle over a fresh emptyBundle() so a field added
    // to the app after some data was saved (or missing/malformed for any
    // other reason) falls back to a safe default instead of `undefined` —
    // that mismatch is a common cause of a render crashing after reload.
    const rawBundles = parsed.bundles && typeof parsed.bundles === "object" ? parsed.bundles : {};
    const bundles = {};
    for (const site of websites) {
      const b = rawBundles[site.id];
      const base = emptyBundle();
      bundles[site.id] = {
        ...base,
        ...(b && typeof b === "object" ? b : {}),
        scores: { ...base.scores, ...(b && typeof b.scores === "object" ? b.scores : {}) },
        scanMeta: { ...base.scanMeta, ...(b && typeof b.scanMeta === "object" ? b.scanMeta : {}) },
        issues: Array.isArray(b?.issues) ? b.issues : [],
        positives: Array.isArray(b?.positives) ? b.positives : [],
        keywords: Array.isArray(b?.keywords) ? b.keywords : [],
        aeoQuestions: Array.isArray(b?.aeoQuestions) ? b.aeoQuestions : [],
        competitors: Array.isArray(b?.competitors) ? b.competitors : [],
        contentIdeas: Array.isArray(b?.contentIdeas) ? b.contentIdeas : [],
        internalLinks: Array.isArray(b?.internalLinks) ? b.internalLinks : [],
        backlinks: Array.isArray(b?.backlinks) ? b.backlinks : [],
        actions: Array.isArray(b?.actions) ? b.actions : [],
        contentRoadmap: Array.isArray(b?.contentRoadmap) ? b.contentRoadmap : null,
      };
    }

    const currentWebsiteId = websites.some((w) => w.id === parsed.currentWebsiteId) ? parsed.currentWebsiteId : (websites[0]?.id ?? null);
    return { websites, bundles, currentWebsiteId };
  } catch {
    return null; // corrupted or inaccessible (e.g. private browsing) — fall back to empty
  }
}

function savePersistedState(state) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    window.localStorage.removeItem(LEGACY_STORAGE_KEY); // migration complete
  } catch {
    // Storage full or unavailable — silently skip rather than crash the app.
  }
}

/* ============================== context ============================== */

const AppCtx = createContext(null);
const useApp = () => useContext(AppCtx);

/* ============================== small UI atoms ============================== */

function GlobalStyle() {
  return (
    <style>{`
      .vr-root { color: ${BRAND.ink}; background: ${BRAND.canvas}; }
      .vr-display { font-weight: 600; }
      .vr-mono { font-variant-numeric: tabular-nums; font-weight: 600; }
      .vr-scrollbar::-webkit-scrollbar { width: 8px; height: 8px; }
      .vr-scrollbar::-webkit-scrollbar-thumb { background: ${BRAND.line}; border-radius: 8px; }
      .vr-fade-in { animation: vrFadeIn .25s ease both; }
      @keyframes vrFadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
      .vr-spin { animation: vrSpin 1s linear infinite; }
      @keyframes vrSpin { to { transform: rotate(360deg); } }
      .vr-btn-primary { background: ${BRAND.primary}; color: white; }
      .vr-btn-primary:hover { background: #322398; }
      .vr-row:hover { background: #FAFAFC; }
      .vr-focus:focus-visible { outline: 2px solid ${BRAND.primary}; outline-offset: 2px; }
    `}</style>
  );
}

function Badge({ color, children, icon: Icon }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ color: color.fg, background: color.bg }}
    >
      {Icon && <Icon size={12} />}
      {children}
    </span>
  );
}

function SeverityBadge({ severity }) { return <Badge color={SEVERITY_COLOR[severity]}>{severity}</Badge>; }
function StatusBadge({ status }) { return <Badge color={STATUS_COLOR[status] || STATUS_COLOR.New}>{status}</Badge>; }

function IconButton({ icon: Icon, onClick, title, danger }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="vr-focus rounded-md p-1.5 hover:bg-gray-100 transition-colors"
      style={{ color: danger ? BRAND.red : BRAND.inkSoft }}
    >
      <Icon size={16} />
    </button>
  );
}

function Button({ children, onClick, variant = "primary", icon: Icon, size = "md", disabled, type = "button" }) {
  const base = "vr-focus inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const sizes = { sm: "px-2.5 py-1.5 text-xs", md: "px-3.5 py-2 text-sm", lg: "px-5 py-2.5 text-sm" };
  const styles = {
    primary: { background: BRAND.primary, color: "#fff" },
    soft: { background: BRAND.primarySoft, color: BRAND.primary },
    outline: { background: "transparent", color: BRAND.ink, border: `1px solid ${BRAND.line}` },
    ghost: { background: "transparent", color: BRAND.inkSoft },
    danger: { background: BRAND.redSoft, color: BRAND.red },
  };
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={cx(base, sizes[size])} style={styles[variant]}>
      {Icon && <Icon size={size === "sm" ? 14 : 16} />}
      {children}
    </button>
  );
}

/** Copies the text returned by `getText()` to the clipboard. `getText` runs on
 *  click, so the copied text always reflects the latest data. Flips to a
 *  "Copied" state for two seconds, and — instead of silently copying nothing —
 *  says so when there's nothing to copy yet. */
function CopyButton({ getText, label = "Copy", icon: Icon = Copy, iconOnly = false, responsive = false, size = "sm", variant = "ghost", title, doneMessage = "Copied to clipboard" }) {
  const { toast } = useApp();
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function handleClick(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    let text = "";
    try { text = getText() || ""; } catch (err) { console.error("VertexRank: couldn't build the text to copy:", err); }
    if (!text.trim()) { toast("Nothing to copy yet — run this analysis first.", "error"); return; }
    const ok = await copyTextToClipboard(text);
    if (!ok) { toast("Couldn't copy — your browser blocked clipboard access.", "error"); return; }
    setCopied(true);
    toast(doneMessage);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  const tip = title || (iconOnly ? label : undefined);
  if (iconOnly) return <IconButton icon={copied ? Check : Icon} onClick={handleClick} title={copied ? "Copied" : tip} />;
  const text = copied ? "Copied" : label;
  return (
    <span title={tip} className="inline-flex">
      <Button size={size} variant={variant} icon={copied ? Check : Icon} onClick={handleClick}>
        {/* `responsive`: icon-only on phones (label stays available to screen readers) so a sticky header doesn't grow tall */}
        {responsive ? <span className="sr-only sm:not-sr-only">{text}</span> : text}
      </Button>
    </span>
  );
}

function Card({ children, className, style }) {
  return (
    <div className={cx("rounded-xl", className)} style={{ background: BRAND.surface, border: `1px solid ${BRAND.line}`, ...style }}>
      {children}
    </div>
  );
}

function EmptyState({ icon: Icon, title, body, action }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      <div className="rounded-full p-3 mb-3" style={{ background: BRAND.primarySoft }}>
        <Icon size={22} style={{ color: BRAND.primary }} />
      </div>
      <div className="font-semibold mb-1">{title}</div>
      <div className="text-sm max-w-sm mb-4" style={{ color: BRAND.inkSoft }}>{body}</div>
      {action}
    </div>
  );
}

function Modal({ open, onClose, title, children, footer, width = 560 }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(20,22,30,0.45)" }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="vr-fade-in rounded-xl w-full max-h-[88vh] flex flex-col" style={{ maxWidth: width, background: BRAND.surface }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${BRAND.line}` }}>
          <div className="font-semibold vr-display text-base">{title}</div>
          <IconButton icon={X} onClick={onClose} title="Close" />
        </div>
        <div className="px-5 py-4 overflow-y-auto vr-scrollbar">{children}</div>
        {footer && <div className="px-5 py-3 flex justify-end gap-2" style={{ borderTop: `1px solid ${BRAND.line}` }}>{footer}</div>}
      </div>
    </div>
  );
}

function ConfirmDialog({ open, onClose, onConfirm, title, body }) {
  return (
    <Modal open={open} onClose={onClose} title={title} width={420}
      footer={<>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={() => { onConfirm(); onClose(); }} icon={Trash2}>Delete</Button>
      </>}>
      <p className="text-sm" style={{ color: BRAND.inkSoft }}>{body}</p>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <label className="block mb-3.5">
      <div className="text-xs font-medium mb-1.5" style={{ color: BRAND.inkSoft }}>{label}</div>
      {children}
    </label>
  );
}
const inputCls = "vr-focus w-full rounded-md px-3 py-2 text-sm bg-white";
const inputStyle = { border: `1px solid ${BRAND.line}` };
function TextInput(props) { return <input {...props} className={inputCls} style={inputStyle} />; }
function TextArea(props) { return <textarea {...props} className={inputCls} style={{ ...inputStyle, minHeight: 84 }} />; }
function Select({ children, ...props }) { return <select {...props} className={inputCls} style={inputStyle}>{children}</select>; }

function SearchInput({ value, onChange, placeholder = "Search..." }) {
  return (
    <div className="relative">
      <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: BRAND.inkSoft }} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="vr-focus rounded-md pl-8 pr-3 py-2 text-sm w-full sm:w-64" style={{ ...inputStyle, background: "#fff" }} />
    </div>
  );
}

function ScoreDial({ label, value, size = 84, accent = BRAND.primary }) {
  const connected = value !== null && value !== undefined;
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const off = c - (clamp(connected ? value : 0, 0, 100) / 100) * c;
  return (
    <div className="flex flex-col items-center gap-2">
      <div style={{ width: size, height: size, position: "relative" }}>
        <svg width={size} height={size}>
          <circle cx={size / 2} cy={size / 2} r={r} stroke={BRAND.line} strokeWidth={7} fill="none" />
          {connected && (
            <circle cx={size / 2} cy={size / 2} r={r} stroke={accent} strokeWidth={7} fill="none"
              strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
              transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: "stroke-dashoffset .6s ease" }} />
          )}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center vr-mono font-semibold" style={{ fontSize: connected ? size * 0.26 : size * 0.2, color: connected ? BRAND.ink : BRAND.inkSoft }}>
          {connected ? value : "—"}
        </div>
      </div>
      <div className="text-xs text-center font-medium" style={{ color: BRAND.inkSoft }}>{label}</div>
    </div>
  );
}

function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="fixed bottom-5 right-5 z-[60] flex flex-col gap-2 w-72">
      {toasts.map((t) => (
        <div key={t.id} className="vr-fade-in rounded-lg px-3.5 py-2.5 text-sm shadow-lg flex items-start gap-2"
          style={{ background: BRAND.ink, color: "#fff" }}>
          {t.type === "error" ? <AlertTriangle size={16} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={16} className="mt-0.5 shrink-0" style={{ color: BRAND.visibility }} />}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

function usePagination(items, pageSize = 8) {
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [items.length]);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const paged = items.slice((page - 1) * pageSize, page * pageSize);
  return { page: clamp(page, 1, totalPages), setPage, totalPages, paged };
}

function Pagination({ page, totalPages, setPage }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-4 py-3" style={{ borderTop: `1px solid ${BRAND.line}` }}>
      <span className="text-xs" style={{ color: BRAND.inkSoft }}>Page {page} of {totalPages}</span>
      <div className="flex gap-1">
        <IconButton icon={ChevronLeft} onClick={() => setPage(Math.max(1, page - 1))} title="Previous" />
        <IconButton icon={ChevronRight} onClick={() => setPage(Math.min(totalPages, page + 1))} title="Next" />
      </div>
    </div>
  );
}

function SortHeader({ label, sortKey, sort, setSort }) {
  const active = sort.key === sortKey;
  return (
    <button className="vr-focus inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide" style={{ color: active ? BRAND.ink : BRAND.inkSoft }}
      onClick={() => setSort((s) => ({ key: sortKey, dir: s.key === sortKey && s.dir === "asc" ? "desc" : "asc" }))}>
      {label}
      {active ? (sort.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ArrowUpDown size={11} style={{ opacity: 0.4 }} />}
    </button>
  );
}

/* ============================== recommendation → action center ============================== */

/** Shared card for any grounded recommendation object (from Keyword,
 *  AEO, GEO, Simulator, or the unified engine) with a one-click path into
 *  the Action Center. Every recommendation carries a Source label so it's
 *  always clear whether it's real crawl data or VertexRank AI reasoning. */
function RecommendationCard({ title, why, module, evidence, recommendedAction, priority, confidence, source, actionType, onAdd, added }) {
  return (
    <div className="rounded-lg p-3.5" style={{ background: BRAND.canvas }}>
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <p className="text-sm font-medium pr-2">{title}</p>
        <div className="flex items-center gap-1.5 shrink-0">
          {priority && <PriorityBadge priority={priority} />}
          <CopyButton iconOnly label="Copy this recommendation"
            getText={() => formatRecommendation({ title, why, module, evidence, recommendedAction, priority, confidence, source }, { heading: "##" })} />
        </div>
      </div>
      {(why || module) && <p className="text-xs mb-1.5" style={{ color: BRAND.inkSoft }}>{why || `Module: ${module}`}</p>}
      {evidence && (
        <div className="rounded p-2 mb-1.5" style={{ background: BRAND.surface, border: `1px solid ${BRAND.line}` }}>
          <p className="text-[10px] font-semibold mb-0.5" style={{ color: BRAND.inkSoft }}>EVIDENCE FROM CRAWL</p>
          <p className="text-xs">{evidence}</p>
        </div>
      )}
      {recommendedAction && (
        <div className="rounded p-2 mb-2" style={{ background: BRAND.visibilitySoft }}>
          <p className="text-[10px] font-semibold mb-0.5" style={{ color: BRAND.visibility }}>RECOMMENDED ACTION</p>
          <p className="text-xs">{recommendedAction}</p>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {confidence && <span className="text-[10px]" style={{ color: BRAND.inkSoft }}>Confidence: {confidence}</span>}
          {source && <span className="text-[10px] rounded px-1.5 py-0.5" style={{ background: BRAND.primarySoft, color: BRAND.primary }}>{source}</span>}
        </div>
        <Button size="sm" variant={added ? "outline" : "soft"} icon={added ? Check : ListPlus} disabled={added} onClick={onAdd}>
          {added ? "Added" : "Add to Action Center"}
        </Button>
      </div>
    </div>
  );
}

function AnalysisBanner({ icon: Icon = Sparkles, children }) {
  return (
    <div className="flex items-start gap-2 rounded-lg px-4 py-2.5 text-xs" style={{ background: BRAND.primarySoft, color: BRAND.primary }}>
      <Icon size={14} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function RunAnalysisPanel({ icon: Icon, title, body, buttonLabel, loadingLabel, onRun, loading, error }) {
  return (
    <Card className="p-6 flex flex-col items-center text-center gap-3">
      <div className="rounded-full p-3" style={{ background: BRAND.primarySoft }}>
        <Icon size={22} style={{ color: BRAND.primary }} />
      </div>
      <div>
        <p className="font-semibold vr-display mb-1">{title}</p>
        <p className="text-sm max-w-md" style={{ color: BRAND.inkSoft }}>{body}</p>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-1">
          <Loader2 className="vr-spin" size={18} style={{ color: BRAND.primary }} />
          <span className="text-sm" style={{ color: BRAND.inkSoft }}>{loadingLabel}</span>
        </div>
      ) : (
        <Button icon={Sparkles} onClick={onRun}>{buttonLabel}</Button>
      )}
      {error && <p className="text-xs" style={{ color: BRAND.red }}>{error}</p>}
    </Card>
  );
}

/** Gate shown by every "site-wide" module (site-wide Competitors, AEO, GEO,
 *  keyword clustering, internal-link recs, backlink discovery) until a
 *  full-site crawl exists for the active website. Single source of truth
 *  for that "go crawl your site first" prompt so the message/CTA stays
 *  consistent everywhere it's needed. */
function SiteCrawlGate({ body }) {
  const { setView } = useApp();
  return (
    <Card className="p-6 flex flex-col items-center text-center gap-3">
      <div className="rounded-full p-3" style={{ background: BRAND.primarySoft }}>
        <RadarIcon size={22} style={{ color: BRAND.primary }} />
      </div>
      <div>
        <p className="font-semibold vr-display mb-1">Run a full-site crawl first</p>
        <p className="text-sm max-w-md" style={{ color: BRAND.inkSoft }}>{body}</p>
      </div>
      <Button icon={RadarIcon} onClick={() => setView("scanner")}>Go to Websites</Button>
    </Card>
  );
}

/* ============================== layout ============================== */

function Sidebar({ view, setView }) {
  const { clearAllData } = useApp();
  const [confirmClear, setConfirmClear] = useState(false);
  return (
    <aside className="hidden md:flex md:w-60 shrink-0 flex-col" style={{ background: BRAND.surface, borderRight: `1px solid ${BRAND.line}` }}>
      <div className="px-5 py-5 flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: BRAND.primary }}>
          <Zap size={16} color="#fff" />
        </div>
        <span className="vr-display font-semibold text-lg">VertexRank</span>
      </div>
      <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto vr-scrollbar">
        {NAV.map((n) => {
          const active = view === n.id;
          return (
            <button key={n.id} onClick={() => setView(n.id)}
              className="vr-focus w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{ background: active ? BRAND.primarySoft : "transparent", color: active ? BRAND.primary : BRAND.inkSoft }}>
              <n.icon size={16} />
              {n.label}
            </button>
          );
        })}
      </nav>
      <div className="px-5 py-4 text-xs space-y-1.5" style={{ color: BRAND.inkSoft, borderTop: `1px solid ${BRAND.line}` }}>
        <p className="flex items-center gap-1.5"><Check size={12} style={{ color: BRAND.visibility }} /> Saved in this browser</p>
        <button onClick={() => setConfirmClear(true)} className="vr-focus underline decoration-dotted underline-offset-2">Clear all data</button>
      </div>
      <ConfirmDialog open={confirmClear} onClose={() => setConfirmClear(false)} title="Clear all data"
        body="This removes every website, scan result, and saved item from this browser. This can't be undone."
        onConfirm={clearAllData} />
    </aside>
  );
}

function TopBar({ view }) {
  const { websites, currentWebsiteId, setCurrentWebsiteId, bundle } = useApp();
  const current = websites.find((w) => w.id === currentWebsiteId);
  const label = NAV.find((n) => n.id === view)?.label || "Dashboard";
  return (
    <div className="sticky top-0 z-30 flex items-center justify-between gap-3 px-5 md:px-8 py-4" style={{ background: BRAND.canvas, borderBottom: `1px solid ${BRAND.line}` }}>
      <div>
        <h1 className="vr-display text-xl font-semibold">{label}</h1>
        {current && <p className="text-xs mt-0.5" style={{ color: BRAND.inkSoft }}>{current.url} · {current.country}</p>}
      </div>
      <div className="flex items-center gap-2 flex-wrap justify-end">
        {/* keyed by page/site so a "Copied" state from one page never leaks onto the next */}
        {current && PAGE_EXPORTERS[view] && (
          <CopyButton key={`all:${view}:${currentWebsiteId}`} responsive size="md" variant="outline" label="Copy all" doneMessage="Copied everything on this page"
            title="Copy every analysis and recommendation on this page"
            getText={() => PAGE_EXPORTERS[view](current, bundle())} />
        )}
        {current && view === "dashboard" && (
          <CopyButton key={`full:${currentWebsiteId}`} responsive icon={FileText} size="md" variant="outline" label="Copy full report" doneMessage="Copied the full report"
            title="Copy everything from every page in one document"
            getText={() => exportFullReport(current, bundle())} />
        )}
        {websites.length > 0 && (
          <div className="relative">
            <select value={currentWebsiteId || ""} onChange={(e) => setCurrentWebsiteId(e.target.value)}
              className="vr-focus appearance-none rounded-md pl-3 pr-8 py-2 text-sm bg-white font-medium" style={inputStyle}>
              {websites.map((w) => <option key={w.id} value={w.id}>{w.url}</option>)}
            </select>
            <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: BRAND.inkSoft }} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================== AI Fix Generator ============================== */

function AiFixModal({ issue, meta, onClose, onApply }) {
  const [stage, setStage] = useState("loading"); // loading | ready | error
  const [fix, setFix] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  async function generate() {
    setStage("loading");
    setErrorMsg("");
    try {
      const data = await postJson("/api/ai-fix", {
        issue: { title: issue.title, category: issue.category, severity: issue.severity, why: issue.why, fix: issue.fix, before: issue.before },
        meta: meta || {},
      });
      setFix(data.fix);
      setStage("ready");
    } catch (err) {
      setErrorMsg(err.message || "Something went wrong. Try again.");
      setStage("error");
    }
  }

  useEffect(() => { generate(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [issue.id]);

  return (
    <Modal open onClose={onClose} title="AI Fix Generator" width={620}
      footer={stage === "ready" ? <>
        <Button variant="outline" onClick={onClose}>Discard</Button>
        <Button icon={Check} onClick={() => { onApply(fix); onClose(); }}>Apply Fix</Button>
      </> : stage === "error" ? <>
        <Button variant="outline" onClick={onClose}>Close</Button>
        <Button icon={RefreshCw} onClick={generate}>Try again</Button>
      </> : null}>
      <div className="mb-4">
        <div className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: BRAND.inkSoft }}>Current problem</div>
        <p className="text-sm">{issue.title}</p>
      </div>
      {stage === "loading" ? (
        <div className="flex flex-col items-center py-10 gap-3">
          <Loader2 className="vr-spin" size={26} style={{ color: BRAND.primary }} />
          <p className="text-sm" style={{ color: BRAND.inkSoft }}>VertexRank AI is reading the page and writing a fix…</p>
        </div>
      ) : stage === "error" ? (
        <div className="flex flex-col items-center py-10 gap-3 text-center">
          <AlertTriangle size={26} style={{ color: BRAND.red }} />
          <p className="text-sm" style={{ color: BRAND.inkSoft }}>{errorMsg}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: BRAND.inkSoft }}>Proposed solution</div>
            <p className="text-sm">{issue.fix}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg p-3" style={{ background: BRAND.redSoft }}>
              <div className="text-xs font-semibold mb-1.5" style={{ color: BRAND.red }}>Before (from your live page)</div>
              <pre className="vr-mono text-xs whitespace-pre-wrap break-words">{fix.before}</pre>
            </div>
            <div className="rounded-lg p-3" style={{ background: BRAND.visibilitySoft }}>
              <div className="text-xs font-semibold mb-1.5" style={{ color: BRAND.visibility }}>After</div>
              <pre className="vr-mono text-xs whitespace-pre-wrap break-words">{fix.after}</pre>
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: BRAND.inkSoft }}>Explanation</div>
            <p className="text-sm" style={{ color: BRAND.inkSoft }}>{fix.explanation}</p>
          </div>
          <p className="text-[11px]" style={{ color: BRAND.inkSoft }}>Generated by VertexRank AI</p>
        </div>
      )}
    </Modal>
  );
}

/* ============================== Dashboard ============================== */

/** Shared renderer for a generated AI Insights payload ({summary, quickWins,
 *  strategicInsight, generatedAt}) — used for both the site-wide and
 *  single-page tabs on the Dashboard so the two stay visually identical. */
function AiInsightsBody({ data, error }) {
  return (
    <div className="space-y-5 pt-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: BRAND.inkSoft }}>What this site is</p>
        <p className="text-sm leading-relaxed">{data.summary}</p>
      </div>

      {data.quickWins?.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: BRAND.inkSoft }}>Grounded quick wins</p>
          <div className="space-y-3">
            {data.quickWins.map((qw, idx) => (
              <div key={idx} className="rounded-lg p-3" style={{ background: BRAND.canvas }}>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <p className="text-sm font-medium">{qw.title}</p>
                  {qw.severity && SEVERITY_COLOR[qw.severity] && <SeverityBadge severity={qw.severity} />}
                </div>
                {qw.why && <p className="text-xs mb-2" style={{ color: BRAND.inkSoft }}>{qw.why}</p>}
                <div className="grid sm:grid-cols-2 gap-2">
                  <div className="rounded p-2" style={{ background: BRAND.redSoft }}>
                    <p className="text-[10px] font-semibold mb-1" style={{ color: BRAND.red }}>BEFORE</p>
                    <p className="text-xs vr-mono whitespace-pre-wrap break-words">{qw.before}</p>
                  </div>
                  <div className="rounded p-2" style={{ background: BRAND.visibilitySoft }}>
                    <p className="text-[10px] font-semibold mb-1" style={{ color: BRAND.visibility }}>AFTER</p>
                    <p className="text-xs vr-mono whitespace-pre-wrap break-words">{qw.after}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg p-4" style={{ background: BRAND.primarySoft }}>
        <p className="text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: BRAND.primary }}>Strategic insight</p>
        <p className="text-sm leading-relaxed">{data.strategicInsight}</p>
      </div>

      <p className="text-[11px]" style={{ color: BRAND.inkSoft }}>Generated by VertexRank AI · {fmtDate(data.generatedAt)}</p>
      {error && <p className="text-xs" style={{ color: BRAND.red }}>{error}</p>}
    </div>
  );
}

function Dashboard() {
  const { websites, bundle, setBundles, setView, currentWebsiteId, toast, addAction } = useApp();
  const b = bundle();
  const [insightsTab, setInsightsTab] = useState("site");
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState("");
  const [siteInsightsLoading, setSiteInsightsLoading] = useState(false);
  const [siteInsightsError, setSiteInsightsError] = useState("");

  // Unified AI Recommendation Engine: merges the grounded opportunities
  // already produced by Keyword Intelligence, AEO, and GEO (site-wide
  // versions preferred once they've been run — see buildUnifiedRecs) into
  // one prioritized list, each traceable back to its module and evidence.
  // This MUST run before the early-return guard below — every hook in a
  // component has to run on every render, or React throws "Rendered more
  // hooks than during the previous render" (error #310) the moment
  // currentWebsiteId flips from null to set, which happens on every reload
  // once a website is saved.
  const unifiedRecs = useMemo(() => buildUnifiedRecs(b, 8), [b.keywordIntel, b.aeoAnalysis, b.geoAnalysis, b.siteKeywordClusters, b.siteAeoAnalysis, b.siteGeoAnalysis]);

  if (!currentWebsiteId) {
    return <EmptyState icon={Globe2} title="No website yet" body="Add a website — a full-site crawl starts automatically and powers the real technical and on-page audit." action={<Button icon={Plus} onClick={() => setView("scanner")}>Add a website</Button>} />;
  }
  const scores = websites.find((w) => w.id === currentWebsiteId)?.scores || {};
  const crawled = !!b.siteCrawl;
  const scanned = !!b.scanMeta?.live;
  const crawlIssues = (b.siteCrawl?.siteWide?.recurringIssues || []).map((e, idx) => ({ ...e, id: `dash_ci_${idx}` }));
  const issueSource = crawlIssues.length ? crawlIssues : b.issues;
  const critical = issueSource.filter((i) => i.severity === "Critical" || i.severity === "High").slice(0, 4);
  const quickWins = issueSource.filter((i) => i.severity === "Low" || i.severity === "Medium").slice(0, 4);
  const recentActions = [...b.actions].sort((a, c) => new Date(c.createdAt) - new Date(a.createdAt)).slice(0, 5);

  async function generateInsights() {
    setInsightsLoading(true);
    setInsightsError("");
    try {
      const data = await postJson("/api/ai-insights", { meta: b.scanMeta, issues: b.issues, positives: b.positives });
      setBundles((prev) => {
        const site = prev[currentWebsiteId] || emptyBundle();
        return { ...prev, [currentWebsiteId]: { ...site, aiInsights: { ...data.insights, generatedAt: new Date().toISOString() } } };
      });
      toast("Insights generated by VertexRank AI");
    } catch (err) {
      setInsightsError(err.message || "VertexRank AI couldn't generate insights.");
    } finally {
      setInsightsLoading(false);
    }
  }

  // Site-wide AI Insights: rolls up the full-site crawl plus whichever
  // site-wide AEO/GEO/keyword-clustering/internal-linking modules have
  // already been run into one executive summary. This is the default tab.
  async function generateSiteInsights() {
    setSiteInsightsLoading(true);
    setSiteInsightsError("");
    try {
      const data = await postJson("/api/site-insights", {
        crawl: b.siteCrawl, siteAeoAnalysis: b.siteAeoAnalysis, siteGeoAnalysis: b.siteGeoAnalysis,
        siteKeywordClusters: b.siteKeywordClusters, internalLinkRecs: b.internalLinkRecs,
      });
      setBundles((prev) => {
        const site = prev[currentWebsiteId] || emptyBundle();
        return { ...prev, [currentWebsiteId]: { ...site, siteInsights: { ...data.insights, generatedAt: new Date().toISOString() } } };
      });
      toast("Site-wide insights generated by VertexRank AI");
    } catch (err) {
      setSiteInsightsError(err.message || "VertexRank AI couldn't generate site-wide insights.");
    } finally {
      setSiteInsightsLoading(false);
    }
  }

  const oppData = [
    { name: "Technical", value: scores.technical != null ? 100 - scores.technical : 0 },
    { name: "Content", value: scores.content != null ? 100 - scores.content : 0 },
  ];

  function addUnifiedToActions(rec) {
    addAction({
      title: rec.title, type: rec.actionType || "Content Update", status: "New",
      detail: { sourceId: rec.id, module: rec.module, evidence: rec.evidence, recommendedAction: rec.recommendedAction, priority: rec.priority, confidence: rec.confidence, source: rec.source },
    });
    toast("Added to Action Center");
  }
  function isAdded(id) { return b.actions.some((a) => a.detail?.sourceId === id); }

  return (
    <div className="space-y-6">
      {crawled ? (
        <div className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs" style={{ background: BRAND.visibilitySoft, color: BRAND.visibility }}>
          <CheckCircle2 size={14} />
          Technical and Content scores are the site-wide average across {b.siteCrawl.pagesCrawled} crawled pages of {b.siteCrawl.domain} (crawled {fmtDate(b.siteCrawl.crawledAt)}). AEO, GEO, and Keyword scores are VertexRank AI estimates — run each site-wide analysis from its module to compute them.
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs" style={{ background: BRAND.amberSoft, color: BRAND.amber }}>
          <Info size={14} />
          No full-site crawl for this site yet — a crawl starts automatically when you add a website. If this one predates that, go to Websites and click Full-site crawl.
        </div>
      )}

      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-6 justify-around">
          <div className="flex flex-col items-center gap-1">
            <ScoreDial label="Overall SEO" value={scores.overall} size={104} accent={BRAND.primary} />
            <span className="text-[10px] font-medium" style={{ color: BRAND.inkSoft }}>{crawled ? "From Technical + Content" : scanned ? "From Technical + Content" : "Not scanned"}</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <ScoreDial label="AEO" value={scores.aeo} accent={BRAND.visibility} />
            <span className="text-[10px] font-medium" style={{ color: scores.aeo != null ? BRAND.primary : BRAND.inkSoft }}>{scores.aeo != null ? "VertexRank AI Estimate" : "Not analyzed yet"}</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <ScoreDial label="GEO / AI Visibility" value={scores.geo} accent={BRAND.visibility} />
            <span className="text-[10px] font-medium" style={{ color: scores.geo != null ? BRAND.primary : BRAND.inkSoft }}>{scores.geo != null ? "VertexRank AI Estimate" : "Not analyzed yet"}</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <ScoreDial label="Technical" value={scores.technical} accent={BRAND.amber} />
            <span className="text-[10px] font-medium" style={{ color: crawled ? BRAND.visibility : scanned ? BRAND.visibility : BRAND.inkSoft }}>{crawled ? "Site-wide avg." : scanned ? "Live (single page)" : "Not scanned"}</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <ScoreDial label="Keyword" value={scores.keyword} accent={BRAND.amber} />
            <span className="text-[10px] font-medium" style={{ color: scores.keyword != null ? BRAND.primary : BRAND.inkSoft }}>{scores.keyword != null ? "VertexRank AI Estimate" : "Not analyzed yet"}</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <ScoreDial label="Content" value={scores.content} accent={BRAND.amber} />
            <span className="text-[10px] font-medium" style={{ color: crawled ? BRAND.visibility : scanned ? BRAND.visibility : BRAND.inkSoft }}>{crawled ? "Site-wide avg." : scanned ? "Live (single page)" : "Not scanned"}</span>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Sparkles size={16} style={{ color: BRAND.primary }} />
            <h3 className="font-semibold vr-display">VertexRank AI Insights</h3>
          </div>
          {(insightsTab === "site" ? b.siteInsights : b.aiInsights) && (
            <div className="flex items-center gap-1">
              <CopyButton label="Copy" title="Copy the AI Insights" getText={() => sectionAiInsights(insightsTab === "site" ? b.siteInsights : b.aiInsights)} />
              <Button size="sm" variant="ghost" icon={RefreshCw} onClick={insightsTab === "site" ? generateSiteInsights : generateInsights} disabled={insightsTab === "site" ? siteInsightsLoading : insightsLoading}>
                {(insightsTab === "site" ? siteInsightsLoading : insightsLoading) ? "Regenerating…" : "Regenerate"}
              </Button>
            </div>
          )}
        </div>
        <div className="flex gap-1 rounded-lg p-1 w-fit mt-2 mb-1" style={{ background: BRAND.canvas }}>
          {[["site", "Site-wide"], ["page", "Single-page"]].map(([id, label]) => (
            <button key={id} onClick={() => setInsightsTab(id)} className="vr-focus text-xs font-medium rounded-md px-2.5 py-1"
              style={{ background: insightsTab === id ? BRAND.surface : "transparent", color: insightsTab === id ? BRAND.primary : BRAND.inkSoft, boxShadow: insightsTab === id ? `0 1px 2px rgba(0,0,0,0.06)` : "none" }}>
              {label}
            </button>
          ))}
        </div>

        {insightsTab === "site" ? (
          !crawled ? (
            <p className="text-sm mt-2" style={{ color: BRAND.inkSoft }}>Run a full-site crawl first — from Websites (one starts automatically when you add a site).</p>
          ) : siteInsightsLoading ? (
            <div className="flex flex-col items-center py-8 gap-3">
              <Loader2 className="vr-spin" size={24} style={{ color: BRAND.primary }} />
              <p className="text-sm" style={{ color: BRAND.inkSoft }}>VertexRank AI is reading the crawl and writing site-wide insights…</p>
            </div>
          ) : !b.siteInsights ? (
            <div className="pt-2">
              <p className="text-sm mb-3" style={{ color: BRAND.inkSoft }}>VertexRank AI will read this site's real crawl results — plus any site-wide AEO, GEO, keyword-clustering, and internal-linking analyses you've already run — and write one plain-language summary, a few grounded quick wins, and strategic advice for the whole site.</p>
              <Button icon={Sparkles} onClick={generateSiteInsights}>Generate AI Insights</Button>
              {siteInsightsError && <p className="text-xs mt-2" style={{ color: BRAND.red }}>{siteInsightsError}</p>}
            </div>
          ) : (
            <AiInsightsBody data={b.siteInsights} error={siteInsightsError} />
          )
        ) : (
          !scanned ? (
            <p className="text-sm mt-2" style={{ color: BRAND.inkSoft }}>Run a single-page scan first — from Websites.</p>
          ) : insightsLoading ? (
            <div className="flex flex-col items-center py-8 gap-3">
              <Loader2 className="vr-spin" size={24} style={{ color: BRAND.primary }} />
              <p className="text-sm" style={{ color: BRAND.inkSoft }}>VertexRank AI is reading the page and writing insights…</p>
            </div>
          ) : !b.aiInsights ? (
            <div className="pt-2">
              <p className="text-sm mb-3" style={{ color: BRAND.inkSoft }}>VertexRank AI will read this one page's real content and audit results, then write a plain-language summary, a few grounded quick wins, and strategic advice.</p>
              <Button icon={Sparkles} onClick={generateInsights}>Generate AI Insights</Button>
              {insightsError && <p className="text-xs mt-2" style={{ color: BRAND.red }}>{insightsError}</p>}
            </div>
          ) : (
            <AiInsightsBody data={b.aiInsights} error={insightsError} />
          )
        )}
      </Card>

      <Card className="p-5">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-2">
            <Target size={16} style={{ color: BRAND.primary }} />
            <h3 className="font-semibold vr-display">Unified AI Recommendations</h3>
          </div>
          {unifiedRecs.length > 0 && (
            <CopyButton label="Copy all" title="Copy every unified recommendation (all of them, not just the top 8 shown)"
              getText={() => sectionUnifiedRecs(buildUnifiedRecs(b))} />
          )}
        </div>
        <p className="text-sm mb-4" style={{ color: BRAND.inkSoft }}>
          Every gap found by Keyword Intelligence, AEO, and GEO — site-wide versions preferred once you've run them — reasoned together, ranked by priority, and one click from the Action Center.
        </p>
        {unifiedRecs.length === 0 ? (
          <p className="text-sm" style={{ color: BRAND.inkSoft }}>
            Run Keyword Intelligence, AEO, and GEO analysis (from their sections in the sidebar) to see combined recommendations here.
          </p>
        ) : (
          <div className="space-y-3">
            {unifiedRecs.map((rec) => (
              <RecommendationCard key={rec.id}
                title={rec.title} module={rec.module} evidence={rec.evidence}
                recommendedAction={rec.recommendedAction} priority={rec.priority} confidence={rec.confidence}
                source={rec.source} added={isAdded(rec.id)} onAdd={() => addUnifiedToActions(rec)} />
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold vr-display">Opportunity by area</h3>
            <span className="text-xs" style={{ color: BRAND.inkSoft }}>Points available · Technical &amp; Content only</span>
          </div>
          {crawled || scanned ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={oppData} margin={{ left: -20 }}>
                <CartesianGrid vertical={false} stroke={BRAND.line} />
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: BRAND.inkSoft }} axisLine={{ stroke: BRAND.line }} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: BRAND.inkSoft }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: BRAND.canvas }} contentStyle={{ borderRadius: 8, border: `1px solid ${BRAND.line}`, fontSize: 12 }} />
                <Bar dataKey="value" fill={BRAND.primary} radius={[5, 5, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-sm" style={{ color: BRAND.inkSoft }}>Add a website to see this chart — a crawl starts automatically.</div>
          )}
        </Card>

        <Card className="p-5">
          <h3 className="font-semibold vr-display mb-3">Recent actions</h3>
          <div className="space-y-3">
            {recentActions.length === 0 && <p className="text-sm" style={{ color: BRAND.inkSoft }}>No actions yet.</p>}
            {recentActions.map((a) => (
              <div key={a.id} className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm leading-snug">{a.title}</p>
                  <p className="text-xs mt-0.5" style={{ color: BRAND.inkSoft }}>{fmtDate(a.createdAt)}</p>
                </div>
                <StatusBadge status={a.status} />
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={16} style={{ color: BRAND.red }} />
            <h3 className="font-semibold vr-display">Critical issues</h3>
          </div>
          <div className="space-y-2.5">
            {critical.length === 0 && (
              <p className="text-sm" style={{ color: BRAND.inkSoft }}>
                {crawled || scanned ? "Nothing critical outstanding — nice work." : "Add a website to see issues here — a crawl starts automatically."}
              </p>
            )}
            {critical.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ background: BRAND.canvas }}>
                <span className="text-sm">{i.title}</span>
                <SeverityBadge severity={i.severity} />
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={16} style={{ color: BRAND.visibility }} />
            <h3 className="font-semibold vr-display">Quick wins</h3>
          </div>
          <div className="space-y-2.5">
            {quickWins.length === 0 && (
              <p className="text-sm" style={{ color: BRAND.inkSoft }}>
                {crawled || scanned ? "No quick wins outstanding." : "Add a website to see issues here — a crawl starts automatically."}
              </p>
            )}
            {quickWins.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ background: BRAND.canvas }}>
                <span className="text-sm">{i.title}</span>
                <SeverityBadge severity={i.severity} />
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle2 size={16} style={{ color: BRAND.visibility }} />
            <h3 className="font-semibold vr-display">What's working well</h3>
          </div>
          <div className="space-y-2.5">
            {b.positives.length === 0 && (
              <p className="text-sm" style={{ color: BRAND.inkSoft }}>
                {scanned ? "Nothing passing yet — see the issues list." : "Run a single-page scan to see what's already working (this list isn't produced by the crawl)."}
              </p>
            )}
            {b.positives.slice(0, 6).map((p, idx) => (
              <div key={idx} className="rounded-lg px-3 py-2" style={{ background: BRAND.visibilitySoft }}>
                <p className="text-sm font-medium">{p.title}</p>
                <p className="text-xs mt-0.5" style={{ color: BRAND.inkSoft }}>{p.detail}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ============================== Website Scanner ============================== */

function ScannerView() {
  const { websites, setWebsites, bundles, setBundles, currentWebsiteId, setCurrentWebsiteId, toast } = useApp();
  const [modal, setModal] = useState(null); // {mode:'add'|'edit', website}
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [form, setForm] = useState({ url: "", country: COUNTRIES[0] });
  const [scanningId, setScanningId] = useState(null);
  const [progress, setProgress] = useState(0);
  const [crawlingId, setCrawlingId] = useState(null);
  const [crawlProgress, setCrawlProgress] = useState(0);

  function openAdd() { setForm({ url: "", country: COUNTRIES[0] }); setModal({ mode: "add" }); }
  function openEdit(w) { setForm({ url: w.url, country: w.country }); setModal({ mode: "edit", website: w }); }

  function saveForm() {
    if (!form.url.trim()) return;
    if (modal.mode === "add") {
      const w = { id: uid("site"), url: form.url.replace(/^https?:\/\//, ""), country: form.country, status: "new", lastScan: null, scores: null };
      setWebsites((ws) => [...ws, w]);
      setBundles((b) => ({ ...b, [w.id]: emptyBundle() }));
      toast(`Added ${w.url} — starting a full-site crawl…`);
      if (!currentWebsiteId) setCurrentWebsiteId(w.id);
      startSiteCrawl(w);
    } else {
      setWebsites((ws) => ws.map((w) => (w.id === modal.website.id ? { ...w, url: form.url, country: form.country } : w)));
      toast("Website updated");
    }
    setModal(null);
  }

  function deleteWebsite(id) {
    setWebsites((ws) => ws.filter((w) => w.id !== id));
    setBundles((b) => { const c = { ...b }; delete c[id]; return c; });
    if (currentWebsiteId === id) {
      const rest = websites.filter((w) => w.id !== id);
      setCurrentWebsiteId(rest[0]?.id || null);
    }
    toast("Website removed");
  }

  async function startScan(w) {
    setScanningId(w.id);
    setProgress(6);
    setWebsites((ws) => ws.map((x) => (x.id === w.id ? { ...x, status: "scanning" } : x)));

    // Climb the bar while the real request is in flight — we don't know exactly
    // how long the target site will take to respond, so this just shows motion.
    const ticker = setInterval(() => {
      setProgress((p) => (p < 88 ? p + randInt(rngFor(w.id + p), 3, 9) : p));
    }, 350);

    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: w.url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "The scan couldn't be completed.");

      clearInterval(ticker);
      setProgress(100);

      // Only the real scan results (issues, technical/content scores) get
      // written here. Anything the user has manually added — keywords,
      // competitors, content ideas, internal links, backlinks — is preserved
      // across rescans instead of being wiped.
      const existing = bundles[w.id] || emptyBundle();
      const technical = data.scores.technical;
      const content = data.scores.content;
      const scores = {
        ...existing.scores,
        overall: Math.round((technical + content) / 2),
        technical,
        content,
      };
      const realIssues = data.issues.map((i) => ({
        id: uid("iss"), websiteId: w.id, category: i.category, title: i.title, why: i.why,
        fix: i.fix, severity: i.severity, status: "New", affectedUrls: i.affectedUrls, before: i.before, aiFix: null, source: "live",
      }));

      const bundle = {
        ...existing,
        issues: realIssues,
        positives: data.positives || [],
        aiInsights: null, // stale after a fresh scan — user can regenerate
        // Keyword/AEO/GEO/simulator results were computed from the previous
        // crawl, so they're stale too — clear them and let the user re-run.
        keywordIntel: null,
        aeoAnalysis: null,
        geoAnalysis: null,
        aiVisibility: null,
        scores,
        scanMeta: {
          live: true, statusCode: data.statusCode, loadTimeMs: data.loadTimeMs,
          wordCount: data.meta.wordCount, fetchedAt: data.fetchedAt,
          // Real scraped content, reused by the AI Fix Generator, AI Insights,
          // and the Keyword/AEO/GEO intelligence modules so they all reason
          // about this actual site instead of a generic template.
          title: data.meta.title, metaDescription: data.meta.metaDescription,
          h1Text: data.meta.h1Text, h1Texts: data.meta.h1Texts, h2Texts: data.meta.h2Texts, h3Texts: data.meta.h3Texts,
          altTexts: data.meta.altTexts, anchorTexts: data.meta.anchorTexts,
          bodySnippet: data.meta.bodySnippet, fullText: data.meta.fullText, domain: data.meta.domain,
          schemaTypes: data.meta.schemaTypes, schemaRaw: data.meta.schemaRaw,
          listItemCount: data.meta.listItemCount, tableCount: data.meta.tableCount,
        },
      };
      setBundles((b) => ({ ...b, [w.id]: bundle }));
      setWebsites((ws) => ws.map((x) => (x.id === w.id ? { ...x, status: "scanned", lastScan: data.fetchedAt, scores } : x)));
      toast(`Live scan complete for ${w.url}`);
    } catch (err) {
      clearInterval(ticker);
      setProgress(0);
      setWebsites((ws) => ws.map((x) => (x.id === w.id ? { ...x, status: "new" } : x)));
      toast(err.message || "Couldn't reach that site — check the URL and try again.", "error");
    } finally {
      setScanningId(null);
    }
  }

  // Full-site crawl (up to ~30-60 pages) that powers every "site-wide"
  // module — site-wide Competitor comparison, AEO, GEO, keyword clustering,
  // internal-link recommendations, and backlink-opportunity discovery. This
  // is deliberately separate from the single-page `startScan` above: it
  // takes longer, and a lot of the single-page audit/keyword/AEO/GEO tools
  // work fine without it.
  async function startSiteCrawl(w) {
    setCrawlingId(w.id);
    setCrawlProgress(6);
    const ticker = setInterval(() => {
      setCrawlProgress((p) => (p < 92 ? p + randInt(rngFor(w.id + "crawl" + p), 2, 6) : p));
    }, 500);
    try {
      const data = await postJson("/api/site-scan", { url: w.url });
      clearInterval(ticker);
      setCrawlProgress(100);
      setBundles((prev) => {
        const site = prev[w.id] || emptyBundle();
        return {
          ...prev,
          [w.id]: {
            ...site,
            siteCrawl: data,
            // A fresh crawl invalidates anything computed from the previous
            // one — clear it and let the user re-run each module.
            siteKeywordClusters: null,
            siteAeoAnalysis: null,
            siteGeoAnalysis: null,
            internalLinkRecs: null,
            siteInsights: null,
          },
        };
      });
      // The site-wide Technical/Content scores (averaged across every
      // crawled page) become this website's headline scores on the
      // Dashboard — more representative than one page, and available the
      // moment the crawl finishes with no separate single-page scan needed.
      if (data.siteScores) {
        const technical = data.siteScores.technical;
        const content = data.siteScores.content;
        const overall = Math.round((technical + content) / 2);
        setWebsites((ws) => ws.map((x) => (x.id === w.id ? { ...x, scores: { ...(x.scores || {}), technical, content, overall } } : x)));
      }
      toast(`Full-site crawl complete — ${data.pagesCrawled} page${data.pagesCrawled === 1 ? "" : "s"} crawled${data.truncated ? " (time/page limit reached)" : ""}`);
    } catch (err) {
      clearInterval(ticker);
      setCrawlProgress(0);
      toast(err.message || "Couldn't crawl that site — check the URL and try again.", "error");
    } finally {
      setCrawlingId(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <Button icon={Plus} onClick={openAdd}>Add website</Button>
      </div>

      {websites.length === 0 ? (
        <Card>
          <EmptyState icon={Globe2} title="No websites added" body="Add your first website and country to run a simulated scan across technical, content, AEO, and GEO signals." action={<Button icon={Plus} onClick={openAdd}>Add website</Button>} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {websites.map((w) => (
            <Card key={w.id} className="p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-semibold text-sm break-all">{w.url}</p>
                  <p className="text-xs flex items-center gap-1 mt-0.5" style={{ color: BRAND.inkSoft }}><MapPin size={11} />{w.country}</p>
                </div>
                <div className="flex gap-0.5">
                  <IconButton icon={Pencil} onClick={() => openEdit(w)} title="Edit" />
                  <IconButton icon={Trash2} danger onClick={() => setConfirmDelete(w)} title="Delete" />
                </div>
              </div>

              {w.status === "scanning" || scanningId === w.id ? (
                <div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: BRAND.line }}>
                    <div className="h-full rounded-full" style={{ width: `${progress}%`, background: BRAND.primary, transition: "width .3s ease" }} />
                  </div>
                  <p className="text-xs mt-1.5 flex items-center gap-1" style={{ color: BRAND.inkSoft }}>
                    <Loader2 size={12} className="vr-spin" /> Scanning… {progress}%
                  </p>
                </div>
              ) : w.status === "scanned" ? (
                <div className="flex items-center justify-between">
                  <div>
                    <p className="vr-mono font-semibold text-lg">{w.scores.overall}</p>
                    <p className="text-xs" style={{ color: BRAND.inkSoft }}>Last scan {fmtDate(w.lastScan)}</p>
                    {bundles[w.id]?.scanMeta?.live ? (
                      <p className="text-[11px] mt-0.5 flex items-center gap-1" style={{ color: BRAND.visibility }}>
                        <CheckCircle2 size={11} /> Live · HTTP {bundles[w.id].scanMeta.statusCode} · {bundles[w.id].scanMeta.loadTimeMs}ms · {bundles[w.id].scanMeta.wordCount} words
                      </p>
                    ) : (
                      <p className="text-[11px] mt-0.5" style={{ color: BRAND.inkSoft }}>Simulated demo data</p>
                    )}
                  </div>
                  <Button size="sm" variant="soft" icon={RefreshCw} onClick={() => startScan(w)}>Rescan</Button>
                </div>
              ) : (
                <Button size="sm" icon={Zap} onClick={() => startScan(w)}>Start scan</Button>
              )}

              <div className="pt-2.5 mt-1" style={{ borderTop: `1px solid ${BRAND.line}` }}>
                {crawlingId === w.id ? (
                  <div>
                    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: BRAND.line }}>
                      <div className="h-full rounded-full" style={{ width: `${crawlProgress}%`, background: BRAND.visibility, transition: "width .3s ease" }} />
                    </div>
                    <p className="text-xs mt-1.5 flex items-center gap-1" style={{ color: BRAND.inkSoft }}>
                      <Loader2 size={12} className="vr-spin" /> Crawling site… {crawlProgress}%
                    </p>
                  </div>
                ) : bundles[w.id]?.siteCrawl ? (
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] flex items-center gap-1" style={{ color: BRAND.visibility }}>
                      <CheckCircle2 size={11} /> {bundles[w.id].siteCrawl.pagesCrawled} pages crawled{bundles[w.id].siteCrawl.truncated ? " (partial)" : ""}
                    </p>
                    <Button size="sm" variant="soft" icon={RefreshCw} onClick={() => startSiteCrawl(w)}>Re-crawl</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="soft" icon={RadarIcon} onClick={() => startSiteCrawl(w)}>Full-site crawl</Button>
                )}
                {!bundles[w.id]?.siteCrawl && crawlingId !== w.id && (
                  <p className="text-[11px] mt-1.5" style={{ color: BRAND.inkSoft }}>Crawls the whole site — unlocks site-wide Competitor comparison, AEO, GEO, keyword clustering, internal-link recs, and backlink discovery.</p>
                )}
              </div>

              <button onClick={() => setCurrentWebsiteId(w.id)}
                className="vr-focus text-xs font-medium rounded-md py-1.5"
                style={{ color: currentWebsiteId === w.id ? BRAND.primary : BRAND.inkSoft, background: currentWebsiteId === w.id ? BRAND.primarySoft : BRAND.canvas }}>
                {currentWebsiteId === w.id ? "Active workspace" : "Set as active"}
              </button>
            </Card>
          ))}
        </div>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.mode === "add" ? "Add website" : "Edit website"}
        footer={<><Button variant="outline" onClick={() => setModal(null)}>Cancel</Button><Button onClick={saveForm}>Save</Button></>}>
        <Field label="Website URL">
          <TextInput placeholder="example.com" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />
        </Field>
        <Field label="Target country">
          <Select value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}>
            {COUNTRIES.map((c) => <option key={c}>{c}</option>)}
          </Select>
        </Field>
      </Modal>

      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete website"
        body={`This removes ${confirmDelete?.url} and all of its simulated audit data.`}
        onConfirm={() => deleteWebsite(confirmDelete.id)} />
    </div>
  );
}

/* ============================== SEO Audit ============================== */

function AuditView() {
  const { currentWebsiteId } = useApp();
  const [tab, setTab] = useState("site");
  if (!currentWebsiteId) return <EmptyState icon={Globe2} title="Select a website" body="Choose a website from the top bar to see its audit." />;
  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg p-1 w-fit" style={{ background: BRAND.canvas }}>
        {[["site", "Site-wide Audit"], ["page", "Single-page Audit"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className="vr-focus text-sm font-medium rounded-md px-3 py-1.5"
            style={{ background: tab === id ? BRAND.surface : "transparent", color: tab === id ? BRAND.primary : BRAND.inkSoft, boxShadow: tab === id ? `0 1px 2px rgba(0,0,0,0.06)` : "none" }}>
            {label}
          </button>
        ))}
      </div>
      {tab === "site" ? <SiteAuditPanel /> : <PageAuditPanel />}
    </div>
  );
}

const SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

/** Site-wide SEO Audit — entirely derived from the full-site crawl, with NO
 *  extra AI call: every crawled page already ran through the exact same
 *  deterministic issue rules as a single-page scan (see
 *  lib/siteCrawler.js's detectPageIssues, kept deliberately parallel to
 *  app/api/scan/route.js), so this just groups those real per-page issues
 *  across the whole site plus the issues only visible with 2+ pages
 *  (duplicate titles, orphan pages, near-duplicate content...). "Generate AI
 *  Fix" still calls VertexRank AI, but only to word one concrete fix for one
 *  real affected page — the finding itself is never invented. */
function SiteAuditPanel() {
  const { bundle, currentWebsiteId, toast, addAction } = useApp();
  const b = bundle();
  const [expanded, setExpanded] = useState(null);
  const [fixIssue, setFixIssue] = useState(null); // { issue, meta }

  const crawl = b.siteCrawl;

  const allIssues = useMemo(() => {
    if (!crawl) return [];
    const sw = crawl.siteWide;
    const siteLevel = [];
    if (sw.orphanPages.length > 0) siteLevel.push({
      id: "site_orphan", category: "Internal Linking", severity: "Medium",
      title: `${sw.orphanPages.length} orphan page${sw.orphanPages.length === 1 ? "" : "s"} — no internal links point to them`,
      why: "A page nothing else on the site links to is hard for search engines (and visitors) to find, even if it's in the sitemap.",
      fix: "Add at least one contextual internal link to each orphan page from a related page.", urls: sw.orphanPages,
    });
    if (sw.weakLinkedPages.length > 0) siteLevel.push({
      id: "site_weak", category: "Internal Linking", severity: "Low",
      title: `${sw.weakLinkedPages.length} page${sw.weakLinkedPages.length === 1 ? "" : "s"} with only one internal link pointing to them`,
      why: "A page with only one inbound internal link passes very little authority and is easy to lose track of.",
      fix: "Add a second contextual internal link from another related page.", urls: sw.weakLinkedPages,
    });
    sw.duplicateTitles.forEach((g, idx) => siteLevel.push({
      id: `site_duptitle_${idx}`, category: "On-Page", severity: "High",
      title: `Duplicate page title used on ${g.urls.length} pages: "${g.value}"`,
      why: "Identical titles make it hard for search engines to tell these pages apart, and one may simply be ignored.",
      fix: "Write a unique, specific title for each of these pages.", urls: g.urls,
    }));
    sw.duplicateMetaDescriptions.forEach((g, idx) => siteLevel.push({
      id: `site_dupmeta_${idx}`, category: "On-Page", severity: "Medium",
      title: `Duplicate meta description used on ${g.urls.length} pages`,
      why: "A duplicated description wastes the chance to differentiate each page in search results.",
      fix: "Write a unique meta description for each page summarizing what's actually on it.", urls: g.urls,
    }));
    sw.nearDuplicateContentPairs.forEach((p, idx) => siteLevel.push({
      id: `site_dupcontent_${idx}`, category: "Content", severity: "Medium",
      title: `Near-duplicate content (${p.similarity}% similar)`,
      why: "Two pages that say almost the same thing compete with each other in search instead of ranking together for more.",
      fix: "Differentiate the two pages' angle and content, or merge them and redirect one to the other.", urls: [p.urlA, p.urlB],
    }));
    const recurring = sw.recurringIssues.map((e, idx) => ({ ...e, id: `rec_${idx}` }));
    return [...siteLevel, ...recurring].sort((a, c) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[c.severity] ?? 9) || c.urls.length - a.urls.length);
  }, [crawl]);

  const worstPages = useMemo(() => {
    if (!crawl) return [];
    return [...crawl.pages]
      .map((p) => ({ url: p.url, title: p.title || p.url, score: Math.round(((p.scores?.technical ?? 100) + (p.scores?.content ?? 100)) / 2), issueCount: p.issues?.length || 0 }))
      .sort((a, c) => a.score - c.score)
      .slice(0, 8);
  }, [crawl]);

  if (!crawl) return <SiteCrawlGate body="A site-wide audit groups the same real technical and on-page checks used for a single page across every crawled page — one entry per problem, with every affected URL, instead of the same issue repeated per page." />;

  function isAdded(id) { return b.actions.some((a) => a.detail?.sourceId === id); }
  function addIssueToActions(issue) {
    addAction({
      title: issue.title, type: issue.category === "Content" ? "Content Update" : issue.category === "Schema" ? "Schema Markup" : "Technical Fix", status: "New",
      detail: { sourceId: issue.id, module: "Site-wide Audit", evidence: `Affects ${issue.urls.length} page${issue.urls.length === 1 ? "" : "s"}: ${issue.urls.slice(0, 3).join(", ")}${issue.urls.length > 3 ? "…" : ""}`, recommendedAction: issue.fix, priority: issue.severity === "Critical" || issue.severity === "High" ? "High" : issue.severity === "Medium" ? "Medium" : "Low", confidence: "High", source: "Crawled Data" },
    });
    toast("Added to Action Center");
  }
  function openAiFix(issue) {
    const repUrl = issue.urls[0];
    const page = crawl.pages.find((p) => p.url === repUrl);
    setFixIssue({
      issue: { title: issue.title, category: issue.category, severity: issue.severity, why: issue.why, fix: issue.fix, before: issue.before },
      meta: page ? { domain: crawl.domain, title: page.title, metaDescription: page.metaDescription, h1Text: page.h1Text, bodySnippet: page.fullText } : { domain: crawl.domain },
    });
  }

  return (
    <div className="space-y-4">
      <AnalysisBanner icon={ListChecks}>
        {crawl.pagesCrawled} pages crawled from {crawl.domain} · {allIssues.length} distinct issue{allIssues.length === 1 ? "" : "s"} found · every finding below is real crawl data, not an AI guess.
      </AnalysisBanner>

      <Card className="p-5 flex flex-wrap items-center gap-6 justify-around">
        <div className="flex flex-col items-center gap-1">
          <ScoreDial label="Site Technical" value={crawl.siteScores?.technical ?? null} size={100} accent={BRAND.amber} />
          <span className="text-[10px] font-medium" style={{ color: BRAND.visibility }}>Avg. across {crawl.pagesCrawled} pages</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <ScoreDial label="Site Content" value={crawl.siteScores?.content ?? null} size={100} accent={BRAND.amber} />
          <span className="text-[10px] font-medium" style={{ color: BRAND.visibility }}>Avg. across {crawl.pagesCrawled} pages</span>
        </div>
      </Card>

      {worstPages.length > 0 && (
        <Card className="p-4">
          <h3 className="font-semibold vr-display mb-3">Worst-scoring pages</h3>
          <div className="space-y-1.5">
            {worstPages.map((p) => (
              <div key={p.url} className="flex items-center justify-between gap-2 text-xs rounded px-3 py-2" style={{ background: BRAND.canvas }}>
                <span className="truncate flex-1">{p.title}</span>
                <span style={{ color: BRAND.inkSoft }}>{p.issueCount} issue{p.issueCount === 1 ? "" : "s"}</span>
                <span className="vr-mono font-semibold shrink-0" style={{ color: p.score < 40 ? BRAND.red : p.score < 70 ? BRAND.amber : BRAND.visibility }}>{p.score}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {allIssues.length === 0 ? (
        <Card><EmptyState icon={CheckCircle2} title="No issues found across the crawl" body="Every crawled page passed the technical and on-page checks." /></Card>
      ) : (
        <div className="space-y-3">
          {allIssues.map((issue) => (
            <Card key={issue.id} className="overflow-hidden">
              <button className="vr-focus w-full flex items-center justify-between gap-3 px-4 py-3.5 text-left" onClick={() => setExpanded(expanded === issue.id ? null : issue.id)}>
                <div className="flex items-center gap-3 min-w-0">
                  <ChevronRight size={15} style={{ transform: expanded === issue.id ? "rotate(90deg)" : "none", transition: "transform .15s", color: BRAND.inkSoft, flexShrink: 0 }} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{issue.title}</p>
                    <p className="text-xs mt-0.5" style={{ color: BRAND.inkSoft }}>{issue.category} · {issue.urls.length} URL{issue.urls.length > 1 ? "s" : ""} affected</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge color={{ fg: BRAND.visibility, bg: BRAND.visibilitySoft }}>Crawled Data</Badge>
                  <SeverityBadge severity={issue.severity} />
                </div>
              </button>
              {expanded === issue.id && (
                <div className="px-4 pb-4 pt-1 space-y-3" style={{ borderTop: `1px solid ${BRAND.line}` }}>
                  <div className="grid sm:grid-cols-2 gap-3 pt-3">
                    <div><p className="text-xs font-semibold mb-1" style={{ color: BRAND.inkSoft }}>Why it matters</p><p className="text-sm">{issue.why}</p></div>
                    <div><p className="text-xs font-semibold mb-1" style={{ color: BRAND.inkSoft }}>Recommended fix</p><p className="text-sm">{issue.fix}</p></div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold mb-1.5" style={{ color: BRAND.inkSoft }}>Affected pages</p>
                    <div className="flex flex-wrap gap-1.5">
                      {issue.urls.slice(0, 12).map((u) => <span key={u} className="text-[10px] vr-mono rounded px-1.5 py-0.5" style={{ background: BRAND.canvas, color: BRAND.inkSoft }}>{u}</span>)}
                      {issue.urls.length > 12 && <span className="text-[10px]" style={{ color: BRAND.inkSoft }}>+{issue.urls.length - 12} more</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button size="sm" icon={Wand2} onClick={() => openAiFix(issue)}>Generate AI Fix</Button>
                    <Button size="sm" variant={isAdded(issue.id) ? "outline" : "soft"} icon={isAdded(issue.id) ? Check : ListPlus} disabled={isAdded(issue.id)} onClick={() => addIssueToActions(issue)}>
                      {isAdded(issue.id) ? "Added" : "Add to Action Center"}
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {fixIssue && <AiFixModal issue={fixIssue.issue} meta={fixIssue.meta} onClose={() => setFixIssue(null)} onApply={() => toast("Fix noted — apply it on the affected page(s) above.")} />}
    </div>
  );
}

function PageAuditPanel() {
  const { bundle, setBundles, currentWebsiteId, toast, addAction } = useApp();
  const b = bundle();
  const [search, setSearch] = useState("");
  const [cat, setCat] = useState("All");
  const [sev, setSev] = useState("All");
  const [fixIssue, setFixIssue] = useState(null);
  const [expanded, setExpanded] = useState(null);

  if (!currentWebsiteId) return <EmptyState icon={Globe2} title="Select a website" body="Choose a website from the top bar to see its audit." />;

  const filtered = b.issues.filter((i) =>
    i.title.toLowerCase().includes(search.toLowerCase()) &&
    (cat === "All" || i.category === cat) &&
    (sev === "All" || i.severity === sev)
  );

  function updateIssue(id, patch) {
    setBundles((prev) => {
      const site = prev[currentWebsiteId] || emptyBundle();
      return { ...prev, [currentWebsiteId]: { ...site, issues: site.issues.map((i) => (i.id === id ? { ...i, ...patch } : i)) } };
    });
  }

  function applyFix(issue, fix) {
    updateIssue(issue.id, { status: "Applied", aiFix: fix });
    addAction({ title: issue.title, type: "Technical Fix", status: "Applied", issueId: issue.id });
    toast(`Fix applied: ${issue.title}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <SearchInput value={search} onChange={setSearch} placeholder="Search issues..." />
        <div className="flex gap-2">
          <Select value={cat} onChange={(e) => setCat(e.target.value)}>
            <option>All</option>{ISSUE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </Select>
          <Select value={sev} onChange={(e) => setSev(e.target.value)}>
            <option>All</option>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}
          </Select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card>
          {b.issues.length === 0 ? (
            <EmptyState icon={ListChecks} title="No audit yet" body="Go to Websites and run a scan to pull a real technical and on-page audit for this site." />
          ) : (
            <EmptyState icon={ListChecks} title="No matching issues" body="Try clearing filters, or rescan the site to refresh the audit." />
          )}
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((i) => (
            <Card key={i.id} className="overflow-hidden">
              <button className="vr-focus w-full flex items-center justify-between gap-3 px-4 py-3.5 text-left" onClick={() => setExpanded(expanded === i.id ? null : i.id)}>
                <div className="flex items-center gap-3 min-w-0">
                  <ChevronRight size={15} style={{ transform: expanded === i.id ? "rotate(90deg)" : "none", transition: "transform .15s", color: BRAND.inkSoft, flexShrink: 0 }} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{i.title}</p>
                    <p className="text-xs mt-0.5" style={{ color: BRAND.inkSoft }}>{i.category} · {i.affectedUrls} URL{i.affectedUrls > 1 ? "s" : ""} affected</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge color={i.source === "live" ? { fg: BRAND.visibility, bg: BRAND.visibilitySoft } : { fg: BRAND.inkSoft, bg: BRAND.canvas }}>{i.source === "live" ? "Live" : "Simulated"}</Badge>
                  <SeverityBadge severity={i.severity} />
                  <StatusBadge status={i.status} />
                </div>
              </button>
              {expanded === i.id && (
                <div className="px-4 pb-4 pt-1 space-y-3" style={{ borderTop: `1px solid ${BRAND.line}` }}>
                  <div className="grid sm:grid-cols-3 gap-3 pt-3">
                    <div><p className="text-xs font-semibold mb-1" style={{ color: BRAND.inkSoft }}>Problem</p><p className="text-sm">{i.title}</p></div>
                    <div><p className="text-xs font-semibold mb-1" style={{ color: BRAND.inkSoft }}>Why it matters</p><p className="text-sm">{i.why}</p></div>
                    <div><p className="text-xs font-semibold mb-1" style={{ color: BRAND.inkSoft }}>Recommended fix</p><p className="text-sm">{i.fix}</p></div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button size="sm" icon={Wand2} onClick={() => setFixIssue(i)}>Generate AI Fix</Button>
                    {i.status !== "Applied" && i.status !== "Verified" && (
                      <Button size="sm" variant="soft" icon={Check} onClick={() => { updateIssue(i.id, { status: "Approved" }); toast("Marked approved"); }}>Approve</Button>
                    )}
                    {i.status === "Applied" && (
                      <Button size="sm" variant="soft" icon={CheckCircle2} onClick={() => { updateIssue(i.id, { status: "Verified" }); toast("Marked verified"); }}>Mark verified</Button>
                    )}
                    {i.aiFix && <span className="text-xs" style={{ color: BRAND.visibility }}>AI fix applied</span>}
                    <CopyButton label="Copy" variant="outline" title="Copy this issue" getText={() => formatIssue(i, "##")} />
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {fixIssue && <AiFixModal issue={fixIssue} meta={b.scanMeta} onClose={() => setFixIssue(null)} onApply={(fix) => applyFix(fixIssue, fix)} />}
    </div>
  );
}

/* ============================== Action Center ============================== */

function ActionCenter() {
  const { bundle, setBundles, currentWebsiteId, toast } = useApp();
  const b = bundle();
  const [statusFilter, setStatusFilter] = useState("All");
  const [modal, setModal] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [form, setForm] = useState({ title: "", type: ACTION_TYPES[0], status: "New" });
  const [expanded, setExpanded] = useState(null);

  // usePagination must run on every render regardless of currentWebsiteId —
  // moved above the early-return guard below for the same reason as
  // Dashboard's useMemo (see the comment there): skipping a hook call on
  // some renders but not others is React error #310.
  const actions = b.actions.filter((a) => statusFilter === "All" || a.status === statusFilter);
  const { page, setPage, totalPages, paged } = usePagination(actions);

  if (!currentWebsiteId) return <EmptyState icon={Globe2} title="Select a website" body="Choose a website from the top bar to manage its actions." />;

  function mutate(fn) {
    setBundles((prev) => {
      const site = prev[currentWebsiteId] || emptyBundle();
      return { ...prev, [currentWebsiteId]: { ...site, actions: fn(site.actions) } };
    });
  }
  function openEdit(a) { setForm({ title: a.title, type: a.type, status: a.status }); setModal({ mode: "edit", action: a }); }
  function save() {
    if (!form.title.trim()) return;
    mutate((arr) => arr.map((a) => (a.id === modal.action.id ? { ...a, ...form } : a)));
    toast("Action updated");
    setModal(null);
  }
  function setStatus(id, status) { mutate((arr) => arr.map((a) => (a.id === id ? { ...a, status } : a))); toast(`Status set to ${status}`); }
  function del(id) { mutate((arr) => arr.filter((a) => a.id !== id)); toast("Action deleted"); }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option>All</option>{ISSUE_STATUSES.map((s) => <option key={s}>{s}</option>)}
        </Select>
      </div>

      <Card className="overflow-hidden">
        {actions.length === 0 ? <EmptyState icon={ClipboardCheck} title="No actions yet" body="Actions appear here once you click 'Add to Action Center' on a real finding from any module — nothing here is invented." /> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr style={{ borderBottom: `1px solid ${BRAND.line}` }}>
                  <th className="px-4 py-2.5"></th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Action</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Type</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Created</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Status</th>
                  <th className="px-4 py-2.5"></th>
                </tr></thead>
                <tbody>
                  {paged.map((a) => (
                    <React.Fragment key={a.id}>
                    <tr className="vr-row" style={{ borderBottom: a.detail && expanded === a.id ? "none" : `1px solid ${BRAND.line}` }}>
                      <td className="px-4 py-2.5">
                        {a.detail && (
                          <button className="vr-focus" onClick={() => setExpanded(expanded === a.id ? null : a.id)}>
                            <ChevronRight size={14} style={{ transform: expanded === a.id ? "rotate(90deg)" : "none", transition: "transform .15s", color: BRAND.inkSoft }} />
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          {a.title}
                          {a.detail?.priority && <PriorityBadge priority={a.detail.priority} />}
                        </div>
                        {a.detail?.module && <p className="text-[11px] mt-0.5" style={{ color: BRAND.inkSoft }}>{a.detail.module}</p>}
                      </td>
                      <td className="px-4 py-2.5" style={{ color: BRAND.inkSoft }}>{a.type}</td>
                      <td className="px-4 py-2.5" style={{ color: BRAND.inkSoft }}>{fmtDate(a.createdAt)}</td>
                      <td className="px-4 py-2.5">
                        <select value={a.status} onChange={(e) => setStatus(a.id, e.target.value)}
                          className="vr-focus text-xs font-medium rounded px-2 py-1 border-0" style={{ color: STATUS_COLOR[a.status].fg, background: STATUS_COLOR[a.status].bg }}>
                          {ISSUE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex gap-0.5 justify-end">
                          <CopyButton iconOnly label="Copy this action" getText={() => formatAction(a, "##")} />
                          <IconButton icon={Pencil} onClick={() => openEdit(a)} title="Edit" />
                          <IconButton icon={Trash2} danger onClick={() => setConfirmDelete(a)} title="Delete" />
                        </div>
                      </td>
                    </tr>
                    {a.detail && expanded === a.id && (
                      <tr style={{ borderBottom: `1px solid ${BRAND.line}` }}>
                        <td colSpan={6} className="px-4 pb-4 pt-0">
                          <div className="rounded-lg p-3.5 space-y-2" style={{ background: BRAND.canvas }}>
                            {a.detail.evidence && <div><p className="text-xs font-semibold mb-0.5" style={{ color: BRAND.inkSoft }}>Evidence from crawl</p><p className="text-sm">{a.detail.evidence}</p></div>}
                            {a.detail.recommendedAction && <div><p className="text-xs font-semibold mb-0.5" style={{ color: BRAND.inkSoft }}>Recommended action</p><p className="text-sm">{a.detail.recommendedAction}</p></div>}
                            <div className="flex items-center gap-3 flex-wrap pt-1">
                              {a.detail.confidence && <span className="text-xs" style={{ color: BRAND.inkSoft }}>Confidence: {a.detail.confidence}</span>}
                              {a.detail.source && <span className="text-xs rounded px-1.5 py-0.5" style={{ background: BRAND.primarySoft, color: BRAND.primary }}>{a.detail.source}</span>}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} totalPages={totalPages} setPage={setPage} />
          </>
        )}
      </Card>

      <Modal open={!!modal} onClose={() => setModal(null)} title="Edit action"
        footer={<><Button variant="outline" onClick={() => setModal(null)}>Cancel</Button><Button onClick={save}>Save</Button></>}>
        <Field label="Title"><TextInput value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} /></Field>
        <Field label="Type"><Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>{ACTION_TYPES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
        <Field label="Status"><Select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>{ISSUE_STATUSES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
      </Modal>
      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete action" body="This action will be permanently removed." onConfirm={() => del(confirmDelete.id)} />
    </div>
  );
}

/* ============================== Keyword Intelligence ============================== */

/* ============================== Keyword Intelligence ============================== */

function KeywordsView() {
  const { currentWebsiteId } = useApp();
  const [tab, setTab] = useState("clusters");
  if (!currentWebsiteId) return <EmptyState icon={Globe2} title="Select a website" body="Choose a website from the top bar to see its keyword tracking." />;
  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg p-1 w-fit" style={{ background: BRAND.canvas }}>
        {[["clusters", "Site-wide Clustering"], ["ai", "AI Keyword Intelligence"], ["manual", "Manual Tracking"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className="vr-focus text-sm font-medium rounded-md px-3 py-1.5"
            style={{ background: tab === id ? BRAND.surface : "transparent", color: tab === id ? BRAND.primary : BRAND.inkSoft, boxShadow: tab === id ? `0 1px 2px rgba(0,0,0,0.06)` : "none" }}>
            {label}
          </button>
        ))}
      </div>
      {tab === "ai" ? <KeywordIntelligencePanel /> : tab === "clusters" ? <SiteKeywordClusteringPanel /> : <ManualKeywordTracker />}
    </div>
  );
}

/** Site-wide keyword clustering + cannibalization detection (Feature ②):
 *  groups keyword candidates from EVERY crawled page into topic clusters and
 *  flags cannibalization — multiple different pages strongly targeting the
 *  same cluster. Deterministic clustering always shows even if the AI
 *  labeling step fails; see app/api/site-keyword-clusters/route.js. */
function SiteKeywordClusteringPanel() {
  const { bundle, setBundles, currentWebsiteId, toast, addAction } = useApp();
  const b = bundle();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const data = b.siteKeywordClusters;

  async function runAnalysis() {
    setLoading(true); setError("");
    try {
      const res = await postJson("/api/site-keyword-clusters", { crawl: b.siteCrawl });
      setBundles((prev) => {
        const site = prev[currentWebsiteId] || emptyBundle();
        return { ...prev, [currentWebsiteId]: { ...site, siteKeywordClusters: res.result } };
      });
      if (res.warning) toast(res.warning);
      else toast("Site-wide keyword clusters ready");
    } catch (err) {
      setError(err.message || "Couldn't cluster this site's keywords.");
      toast(err.message || "Couldn't cluster this site's keywords.", "error");
    } finally {
      setLoading(false);
    }
  }

  function isAdded(id) { return b.actions.some((a) => a.detail?.sourceId === id); }
  function addOpportunity(o) {
    addAction({ title: o.opportunity, type: "Content Update", status: "New", detail: { sourceId: o.id, module: "Site-wide Keyword Clustering", evidence: o.evidence, priority: o.priority, confidence: "Medium", source: o.source } });
    toast("Added to Action Center");
  }
  function addCannibalGuidance(g) {
    addAction({ title: `${g.recommendedAction} competing pages`, type: "Content Update", status: "New", detail: { sourceId: g.id, module: "Site-wide Keyword Clustering", evidence: g.explanation, recommendedAction: g.reasoning, priority: "High", confidence: "Medium", source: g.source } });
    toast("Added to Action Center");
  }

  if (!b.siteCrawl) return <SiteCrawlGate body="Keyword clustering groups the keywords found across EVERY page of your site and flags cannibalization — two different pages competing for the same topic. That needs a full-site crawl, not just one page." />;

  if (!data) {
    return <RunAnalysisPanel icon={KeyRound} title="Site-wide keyword clustering" body={`Group the keywords found across all ${b.siteCrawl.pagesCrawled} crawled pages into topic clusters and detect cannibalization — pages competing for the same search intent.`}
      buttonLabel="Cluster keywords" loadingLabel="Clustering keywords across the site…" onRun={runAnalysis} loading={loading} error={error} />;
  }

  return (
    <div className="space-y-4">
      <AnalysisBanner icon={KeyRound}>
        {data.domain} · {data.pagesCrawled} pages · {data.clusterCount} clusters · {data.cannibalizationCount} cannibalization risk{data.cannibalizationCount === 1 ? "" : "s"}
      </AnalysisBanner>
      <div className="flex justify-end">
        <Button size="sm" variant="soft" icon={loading ? Loader2 : RefreshCw} disabled={loading} onClick={runAnalysis}>{loading ? "Re-clustering…" : "Re-cluster"}</Button>
      </div>

      {data.cannibalizationGuidance && data.cannibalizationGuidance.length > 0 && (
        <Card className="p-4">
          <h3 className="font-semibold vr-display mb-3 flex items-center gap-2"><AlertTriangle size={16} style={{ color: BRAND.amber }} /> Keyword cannibalization</h3>
          <div className="space-y-3">
            {data.cannibalizationGuidance.map((g) => {
              const c = (data.cannibalization || []).find((x) => x.clusterId === g.clusterId);
              return (
                <div key={g.id} className="rounded-lg p-3.5" style={{ background: BRAND.canvas }}>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <p className="text-sm font-medium">{c?.keywords?.slice(0, 4).join(", ") || "Competing pages"}</p>
                    <Badge color={{ fg: BRAND.primary, bg: BRAND.primarySoft }}>{g.recommendedAction}</Badge>
                  </div>
                  <p className="text-xs mb-2" style={{ color: BRAND.inkSoft }}>{g.explanation}</p>
                  {c?.competingPages && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {c.competingPages.map((p) => (
                        <span key={p.url} className="text-[10px] vr-mono rounded px-1.5 py-0.5" style={{ background: p.url === g.primaryPageUrl ? BRAND.visibilitySoft : BRAND.surface, color: p.url === g.primaryPageUrl ? BRAND.visibility : BRAND.inkSoft, border: `1px solid ${BRAND.line}` }}>
                          {p.url === g.primaryPageUrl ? "★ " : ""}{p.title}
                        </span>
                      ))}
                    </div>
                  )}
                  {g.reasoning && <p className="text-[11px] mb-2" style={{ color: BRAND.inkSoft }}>{g.reasoning}</p>}
                  <div className="flex justify-end">
                    <Button size="sm" variant={isAdded(g.id) ? "outline" : "soft"} icon={isAdded(g.id) ? Check : ListPlus} disabled={isAdded(g.id)} onClick={() => addCannibalGuidance(g)}>{isAdded(g.id) ? "Added" : "Add to Action Center"}</Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {data.opportunities && data.opportunities.length > 0 && (
        <Card className="p-4">
          <h3 className="font-semibold vr-display mb-3">Keyword strategy opportunities</h3>
          <div className="space-y-3">
            {data.opportunities.map((o) => (
              <RecommendationCard key={o.id} title={o.opportunity} evidence={o.evidence} priority={o.priority} source={o.source} onAdd={() => addOpportunity(o)} added={isAdded(o.id)} />
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <h3 className="font-semibold vr-display mb-3">Clusters ({data.clusters.length})</h3>
        {data.clusters.length === 0 ? <p className="text-sm" style={{ color: BRAND.inkSoft }}>No clusters detected.</p> : (
          <div className="grid sm:grid-cols-2 gap-3">
            {data.clusters.slice(0, 20).map((c) => (
              <div key={c.id} className="rounded-lg p-3" style={{ background: BRAND.canvas }}>
                <p className="text-sm font-medium">{c.label}</p>
                {c.insight && <p className="text-xs mt-1" style={{ color: BRAND.inkSoft }}>{c.insight}</p>}
                <div className="flex flex-wrap gap-1 mt-2">{c.keywords.slice(0, 6).map((k) => <span key={k} className="text-[10px] rounded px-1.5 py-0.5" style={{ background: BRAND.primarySoft, color: BRAND.primary }}>{k}</span>)}</div>
                <p className="text-[10px] mt-2" style={{ color: BRAND.inkSoft }}>{c.pages.length} page{c.pages.length === 1 ? "" : "s"} · {c.source}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function KeywordIntelligencePanel() {
  const { bundle, setBundles, currentWebsiteId, toast, addAction, setScore } = useApp();
  const b = bundle();
  const [form, setForm] = useState({ targetKeyword: "", topic: "", country: COUNTRIES[0], language: "English" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [intentFilter, setIntentFilter] = useState("All");
  const [expanded, setExpanded] = useState(null);

  const intel = b.keywordIntel;

  async function runAnalysis() {
    if (!b.scanMeta?.live) { toast("Run a live scan first, from Websites — Keyword Intelligence reads the real crawl.", "error"); return; }
    setLoading(true); setError("");
    try {
      const data = await postJson("/api/keyword-intelligence", {
        scanMeta: b.scanMeta, targetKeyword: form.targetKeyword, topic: form.topic, country: form.country, language: form.language,
      });
      setBundles((prev) => {
        const site = prev[currentWebsiteId] || emptyBundle();
        return { ...prev, [currentWebsiteId]: { ...site, keywordIntel: data.result } };
      });
      setScore("keyword", computeOpportunityScore(data.result.opportunities));
      toast("Keyword Intelligence generated by VertexRank AI");
    } catch (err) {
      setError(err.message || "Couldn't run keyword analysis.");
    } finally {
      setLoading(false);
    }
  }

  function addOppToActions(o) {
    addAction({
      title: o.problem, type: "Content Update", status: "New",
      detail: { sourceId: `kwi_${o.id}`, module: "Keyword Intelligence", evidence: o.evidence, recommendedAction: o.recommendedAction, priority: o.priority, confidence: o.confidence, source: o.source },
    });
    toast("Added to Action Center");
  }
  function isAdded(id) { return b.actions.some((a) => a.detail?.sourceId === id); }

  const KEYWORD_TYPES = ["Primary", "Secondary", "Long-tail", "Related", "Semantic", "Entity", "Question", "Commercial", "Informational", "Transactional", "Navigational", "Local"];

  let rows = (intel?.keywords || []).filter((k) =>
    k.keyword.toLowerCase().includes(search.toLowerCase()) &&
    (typeFilter === "All" || k.type === typeFilter) &&
    (intentFilter === "All" || k.intent === intentFilter)
  );
  const { page, setPage, totalPages, paged } = usePagination(rows, 10);

  return (
    <div className="space-y-5">
      <AnalysisBanner icon={Sparkles}>
        VertexRank AI reads the real crawled page — title, headings, alt text, body content — to extract and classify keyword candidates. Estimates (relevance, difficulty) are labeled "VertexRank AI Estimate" with a confidence level; they are never real Google search volume, rankings, or CPC.
      </AnalysisBanner>

      <Card className="p-5">
        <div className="flex items-center gap-2 mb-3">
          <Target size={16} style={{ color: BRAND.primary }} />
          <h3 className="font-semibold vr-display">Run Keyword Intelligence</h3>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <Field label="Target keyword (optional)"><TextInput placeholder="e.g. POS software Kenya" value={form.targetKeyword} onChange={(e) => setForm((f) => ({ ...f, targetKeyword: e.target.value }))} /></Field>
          <Field label="Topic (optional)"><TextInput placeholder="e.g. point of sale" value={form.topic} onChange={(e) => setForm((f) => ({ ...f, topic: e.target.value }))} /></Field>
          <Field label="Country"><Select value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}>{COUNTRIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
          <Field label="Language"><TextInput value={form.language} onChange={(e) => setForm((f) => ({ ...f, language: e.target.value }))} /></Field>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 py-1">
            <Loader2 className="vr-spin" size={18} style={{ color: BRAND.primary }} />
            <span className="text-sm" style={{ color: BRAND.inkSoft }}>VertexRank AI is reading the crawl and classifying keywords…</span>
          </div>
        ) : (
          <Button icon={intel ? RefreshCw : Sparkles} onClick={runAnalysis}>{intel ? "Re-run analysis" : "Run Keyword Intelligence"}</Button>
        )}
        {error && <p className="text-xs mt-2" style={{ color: BRAND.red }}>{error}</p>}
        {!b.scanMeta?.live && <p className="text-xs mt-2" style={{ color: BRAND.amber }}>This website hasn't been scanned yet — go to Websites and run a scan first.</p>}
      </Card>

      {intel && (
        <>
          <Card className="p-5">
            <div className="flex items-center gap-4 flex-wrap">
              <ScoreDial label="Keyword Opportunity" value={computeOpportunityScore(intel.opportunities)} size={92} accent={BRAND.primary} />
              <div className="text-xs" style={{ color: BRAND.inkSoft }}>
                <p className="font-medium mb-1" style={{ color: BRAND.ink }}>How this score works</p>
                <p>Starts at 100 and subtracts a weighted penalty for each open opportunity below (Critical −20, High −12, Medium −6, Low −2) — fully explainable, not an AI-invented number.</p>
                <p className="mt-1">Generated {fmtDate(intel.generatedAt)} · {intel.keywords.length} keywords · {intel.opportunities.length} opportunities</p>
              </div>
            </div>
          </Card>

          {intel.entities?.length > 0 && (
            <Card className="p-5">
              <div className="flex items-start justify-between gap-2 mb-1">
                <h3 className="font-semibold vr-display">Entities detected on the page</h3>
                <CopyButton label="Copy" getText={() => sectionEntities(intel.entities)} />
              </div>
              <p className="text-xs mb-3" style={{ color: BRAND.inkSoft }}>Crawled Data · proper-noun phrases found directly in the page text.</p>
              <div className="flex flex-wrap gap-1.5">
                {intel.entities.map((e) => (
                  <span key={e.entity} className="text-xs rounded-full px-2.5 py-1" style={{ background: BRAND.canvas, color: BRAND.ink }}>{e.entity} <span style={{ color: BRAND.inkSoft }}>×{e.occurrences}</span></span>
                ))}
              </div>
            </Card>
          )}

          <Card className="p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h3 className="font-semibold vr-display">Keyword Opportunity Analysis</h3>
              {intel.opportunities.length > 0 && <CopyButton label="Copy" getText={() => sectionKeywordOpportunities(intel)} />}
            </div>
            {intel.opportunities.length === 0 ? (
              <p className="text-sm" style={{ color: BRAND.inkSoft }}>No specific opportunities flagged this run.</p>
            ) : (
              <div className="space-y-3">
                {sortByPriority(intel.opportunities).map((o) => (
                  <RecommendationCard key={o.id} title={o.problem} evidence={o.evidence} recommendedAction={o.recommendedAction}
                    priority={o.priority} confidence={o.confidence} source={o.source}
                    added={isAdded(`kwi_${o.id}`)} onAdd={() => addOppToActions(o)} />
                ))}
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="p-4 flex flex-wrap gap-2 items-center justify-between" style={{ borderBottom: `1px solid ${BRAND.line}` }}>
              <div className="flex flex-wrap gap-2">
                <SearchInput value={search} onChange={setSearch} placeholder="Search keywords..." />
                <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}><option>All</option>{KEYWORD_TYPES.map((t) => <option key={t}>{t}</option>)}</Select>
                <Select value={intentFilter} onChange={(e) => setIntentFilter(e.target.value)}><option>All</option>{INTENTS.map((i) => <option key={i}>{i}</option>)}</Select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs" style={{ color: BRAND.inkSoft }}>{rows.length} keyword{rows.length === 1 ? "" : "s"}</span>
                <CopyButton label="Copy keywords" title="Copies the keywords currently shown (respects search and filters)" getText={() => sectionKeywordTable(rows)} />
              </div>
            </div>
            {rows.length === 0 ? (
              <div className="p-6"><EmptyState icon={KeyRound} title="No keywords match" body="Try clearing the search or filters." /></div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr style={{ borderBottom: `1px solid ${BRAND.line}` }}>
                      <th className="px-4 py-2.5"></th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Keyword</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Type</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Intent</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Occurs</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Where it appears</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Relevance</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Difficulty (AI Est.)</th>
                    </tr></thead>
                    <tbody>
                      {paged.map((k) => (
                        <React.Fragment key={k.id}>
                          <tr className="vr-row cursor-pointer" style={{ borderBottom: expanded === k.id ? "none" : `1px solid ${BRAND.line}` }} onClick={() => setExpanded(expanded === k.id ? null : k.id)}>
                            <td className="px-4 py-2.5"><ChevronRight size={13} style={{ transform: expanded === k.id ? "rotate(90deg)" : "none", transition: "transform .15s", color: BRAND.inkSoft }} /></td>
                            <td className="px-4 py-2.5 font-medium">{k.keyword}</td>
                            <td className="px-4 py-2.5"><Badge color={{ fg: BRAND.primary, bg: BRAND.primarySoft }}>{k.type}</Badge></td>
                            <td className="px-4 py-2.5" style={{ color: BRAND.inkSoft }}>{k.intent}</td>
                            <td className="px-4 py-2.5 vr-mono">{k.occurrences || 0}</td>
                            <td className="px-4 py-2.5">
                              <div className="flex flex-wrap gap-1 max-w-[240px]">
                                {[["title", "Title"], ["metaDescription", "Meta"], ["h1", "H1"], ["h2h3", "H2/H3"], ["alt", "ALT"], ["schema", "Schema"]]
                                  .filter(([key]) => k.usage?.[key])
                                  .map(([key, label]) => <span key={key} className="text-[10px] rounded px-1.5 py-0.5" style={{ background: BRAND.visibilitySoft, color: BRAND.visibility }}>{label}</span>)}
                                {(!k.usage || Object.values(k.usage).every((v) => !v)) && <span className="text-xs" style={{ color: BRAND.inkSoft }}>Not found on page</span>}
                              </div>
                            </td>
                            <td className="px-4 py-2.5 vr-mono">{k.relevance}</td>
                            <td className="px-4 py-2.5 vr-mono" style={{ color: BRAND.inkSoft }}>{k.difficultyEstimate ?? "—"} <span className="text-[10px]">({k.difficultyConfidence})</span></td>
                          </tr>
                          {expanded === k.id && (
                            <tr style={{ borderBottom: `1px solid ${BRAND.line}` }}>
                              <td colSpan={8} className="px-4 pb-4 pt-0">
                                <div className="rounded-lg p-3.5 space-y-2" style={{ background: BRAND.canvas }}>
                                  {k.recommendedUsage && <div><p className="text-xs font-semibold mb-0.5" style={{ color: BRAND.inkSoft }}>Recommended usage</p><p className="text-sm">{k.recommendedUsage}</p></div>}
                                  {k.opportunity && <div><p className="text-xs font-semibold mb-0.5" style={{ color: BRAND.inkSoft }}>Optimization opportunity</p><p className="text-sm">{k.opportunity}</p></div>}
                                  <p className="text-[11px] rounded px-1.5 py-0.5 inline-block" style={{ background: BRAND.primarySoft, color: BRAND.primary }}>{k.source}</p>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={page} totalPages={totalPages} setPage={setPage} />
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function ManualKeywordTracker() {
  const { bundle, setBundles, currentWebsiteId, toast } = useApp();
  const b = bundle();
  const [search, setSearch] = useState("");
  const [intent, setIntent] = useState("All");
  const [sort, setSort] = useState({ key: "keyword", dir: "asc" });
  const [modal, setModal] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [form, setForm] = useState({ keyword: "", intent: "Informational", ranking: "", usage: [] });
  const [suggesting, setSuggesting] = useState(false);

  function mutate(fn) {
    setBundles((prev) => {
      const site = prev[currentWebsiteId] || emptyBundle();
      return { ...prev, [currentWebsiteId]: { ...site, keywords: fn(site.keywords) } };
    });
  }
  function openAdd() { setForm({ keyword: "", intent: "Informational", ranking: "", usage: [] }); setModal({ mode: "add" }); }
  function openEdit(k) { setForm({ keyword: k.keyword, intent: k.intent, ranking: k.ranking ?? "", usage: k.usage }); setModal({ mode: "edit", k }); }
  function toggleUsage(loc) {
    setForm((f) => ({ ...f, usage: f.usage.includes(loc) ? f.usage.filter((u) => u !== loc) : [...f.usage, loc] }));
  }
  function save() {
    if (!form.keyword.trim()) return;
    const payload = { keyword: form.keyword.trim(), intent: form.intent, ranking: form.ranking ? Number(form.ranking) : null, usage: form.usage };
    if (modal.mode === "add") {
      mutate((arr) => [...arr, { id: uid("kw"), websiteId: currentWebsiteId, volume: null, difficulty: null, opportunity: null, ...payload }]);
      toast("Keyword added");
    } else {
      mutate((arr) => arr.map((x) => (x.id === modal.k.id ? { ...x, ...payload } : x)));
      toast("Keyword updated");
    }
    setModal(null);
  }
  function del(id) { mutate((arr) => arr.filter((x) => x.id !== id)); toast("Keyword removed"); }

  // Lets the user populate this list with VertexRank AI's own suggestions —
  // grounded in the real crawl via Keyword Intelligence — instead of typing
  // every keyword in by hand.
  async function suggestWithAi() {
    let scanMeta = b.scanMeta;
    if (!scanMeta?.live) {
      const homepage = b.siteCrawl?.pages?.find((p) => p.url === b.siteCrawl.startUrl) || b.siteCrawl?.pages?.[0];
      if (homepage) scanMeta = { domain: b.siteCrawl.domain, title: homepage.title, metaDescription: homepage.metaDescription, h1Text: homepage.h1Text, fullText: homepage.fullText };
    }
    if (!scanMeta?.domain) { toast("Add a website first — a full-site crawl starts automatically and powers this.", "error"); return; }
    setSuggesting(true);
    try {
      let intel = b.keywordIntel;
      if (!intel) {
        const data = await postJson("/api/keyword-intelligence", { scanMeta, targetKeyword: "", topic: "", country: COUNTRIES[0], language: "English" });
        intel = data.result;
        setBundles((prev) => {
          const site = prev[currentWebsiteId] || emptyBundle();
          return { ...prev, [currentWebsiteId]: { ...site, keywordIntel: intel } };
        });
      }
      const existing = new Set(b.keywords.map((k) => k.keyword.toLowerCase()));
      const picks = [...(intel.keywords || [])]
        .sort((a, c) => c.relevance - a.relevance)
        .filter((k) => !existing.has(k.keyword.toLowerCase()))
        .slice(0, 8);
      if (picks.length === 0) { toast("No new AI-suggested keywords — everything relevant is already tracked."); return; }
      mutate((arr) => [
        ...arr,
        ...picks.map((k) => ({
          id: uid("kw"), websiteId: currentWebsiteId, keyword: k.keyword, intent: k.intent, ranking: null, volume: null, difficulty: null, opportunity: null,
          usage: [
            ...(k.usage?.title ? ["Title"] : []), ...(k.usage?.metaDescription ? ["Meta"] : []), ...(k.usage?.h1 ? ["H1"] : []),
            ...(k.usage?.h2h3 ? ["Headings"] : []), ...(k.usage?.body ? ["Body"] : []), ...(k.usage?.alt ? ["ALT"] : []), ...(k.usage?.schema ? ["Schema"] : []),
          ],
        })),
      ]);
      toast(`Added ${picks.length} AI-suggested keyword${picks.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast(err.message || "Couldn't suggest keywords.", "error");
    } finally {
      setSuggesting(false);
    }
  }

  let rows = b.keywords.filter((k) => k.keyword.toLowerCase().includes(search.toLowerCase()) && (intent === "All" || k.intent === intent));
  rows = [...rows].sort((a, c) => {
    const dir = sort.dir === "asc" ? 1 : -1;
    const av = a[sort.key] ?? -1, cv = c[sort.key] ?? -1;
    return av > cv ? dir : av < cv ? -dir : 0;
  });
  const { page, setPage, totalPages, paged } = usePagination(rows, 8);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs" style={{ background: BRAND.amberSoft, color: BRAND.amber }}>
        <Info size={14} />
        Search volume, difficulty, and opportunity require a paid keyword data provider — not connected yet, so those show "—". "Suggest with AI" fills this list from the real crawl — the only thing "Add keyword" is still for is recording a real Google rank position you already know, since nothing in VertexRank can discover that automatically.
      </div>
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex flex-wrap gap-2">
          <SearchInput value={search} onChange={setSearch} placeholder="Search keywords..." />
          <Select value={intent} onChange={(e) => setIntent(e.target.value)}><option>All</option>{INTENTS.map((i) => <option key={i}>{i}</option>)}</Select>
        </div>
        <div className="flex gap-2">
          <Button variant="soft" icon={suggesting ? Loader2 : Sparkles} disabled={suggesting} onClick={suggestWithAi}>{suggesting ? "Suggesting…" : "Suggest with AI"}</Button>
          <Button icon={Plus} onClick={openAdd}>Add keyword</Button>
        </div>
      </div>
      {b.keywords.length === 0 ? (
        <Card><EmptyState icon={KeyRound} title="No keywords tracked yet" body="Let VertexRank AI suggest keywords from the crawl, or add the ones you're targeting by hand." action={<div className="flex gap-2"><Button variant="soft" icon={Sparkles} onClick={suggestWithAi}>Suggest with AI</Button><Button icon={Plus} onClick={openAdd}>Add keyword</Button></div>} /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr style={{ borderBottom: `1px solid ${BRAND.line}` }}>
                <th className="text-left px-4 py-2.5"><SortHeader label="Keyword" sortKey="keyword" sort={sort} setSort={setSort} /></th>
                <th className="text-left px-4 py-2.5"><SortHeader label="Intent" sortKey="intent" sort={sort} setSort={setSort} /></th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Volume</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Difficulty</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Opportunity</th>
                <th className="text-left px-4 py-2.5"><SortHeader label="Rank" sortKey="ranking" sort={sort} setSort={setSort} /></th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>Appears in</th>
                <th className="px-4 py-2.5"></th>
              </tr></thead>
              <tbody>
                {paged.map((k) => (
                  <tr key={k.id} className="vr-row" style={{ borderBottom: `1px solid ${BRAND.line}` }}>
                    <td className="px-4 py-2.5 font-medium">{k.keyword}</td>
                    <td className="px-4 py-2.5" style={{ color: BRAND.inkSoft }}>{k.intent}</td>
                    <td className="px-4 py-2.5 vr-mono" style={{ color: BRAND.inkSoft }}>{k.volume ?? "—"}</td>
                    <td className="px-4 py-2.5 vr-mono" style={{ color: BRAND.inkSoft }}>{k.difficulty ?? "—"}</td>
                    <td className="px-4 py-2.5 vr-mono" style={{ color: BRAND.inkSoft }}>{k.opportunity ?? "—"}</td>
                    <td className="px-4 py-2.5 vr-mono">{k.ranking ? `#${k.ranking}` : "—"}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1 max-w-[220px]">
                        {(k.usage || []).map((u) => <span key={u} className="text-[10px] rounded px-1.5 py-0.5" style={{ background: BRAND.canvas, color: BRAND.inkSoft }}>{u}</span>)}
                        {(!k.usage || k.usage.length === 0) && <span className="text-xs" style={{ color: BRAND.inkSoft }}>—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex gap-0.5 justify-end">
                        <IconButton icon={Pencil} onClick={() => openEdit(k)} title="Edit" />
                        <IconButton icon={Trash2} danger onClick={() => setConfirmDelete(k)} title="Delete" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={totalPages} setPage={setPage} />
        </Card>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.mode === "add" ? "Add keyword" : "Edit keyword"}
        footer={<><Button variant="outline" onClick={() => setModal(null)}>Cancel</Button><Button onClick={save}>Save</Button></>}>
        <Field label="Keyword"><TextInput value={form.keyword} onChange={(e) => setForm((f) => ({ ...f, keyword: e.target.value }))} /></Field>
        <Field label="Search intent"><Select value={form.intent} onChange={(e) => setForm((f) => ({ ...f, intent: e.target.value }))}>{INTENTS.map((i) => <option key={i}>{i}</option>)}</Select></Field>
        <Field label="Current ranking (optional, if you know it)"><TextInput type="number" min="1" placeholder="e.g. 14" value={form.ranking} onChange={(e) => setForm((f) => ({ ...f, ranking: e.target.value }))} /></Field>
        <Field label="Where it appears on the page">
          <div className="flex flex-wrap gap-2">
            {LOCATIONS.map((loc) => (
              <button key={loc} type="button" onClick={() => toggleUsage(loc)}
                className="vr-focus text-xs rounded-full px-2.5 py-1 font-medium"
                style={{ background: form.usage.includes(loc) ? BRAND.primarySoft : BRAND.canvas, color: form.usage.includes(loc) ? BRAND.primary : BRAND.inkSoft, border: `1px solid ${form.usage.includes(loc) ? BRAND.primary : BRAND.line}` }}>
                {loc}
              </button>
            ))}
          </div>
        </Field>
      </Modal>
      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete keyword" body="This keyword will be permanently removed." onConfirm={() => del(confirmDelete.id)} />
    </div>
  );
}

/* ============================== AEO ============================== */

function AeoView() {
  const { currentWebsiteId } = useApp();
  const [tab, setTab] = useState("site");
  if (!currentWebsiteId) return <EmptyState icon={Globe2} title="Select a website" body="Choose a website from the top bar to track AEO questions." />;
  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg p-1 w-fit" style={{ background: BRAND.canvas }}>
        {[["site", "Site-wide AEO"], ["ai", "AI Answer Coverage"], ["manual", "Manual Tracking"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className="vr-focus text-sm font-medium rounded-md px-3 py-1.5"
            style={{ background: tab === id ? BRAND.surface : "transparent", color: tab === id ? BRAND.primary : BRAND.inkSoft, boxShadow: tab === id ? `0 1px 2px rgba(0,0,0,0.06)` : "none" }}>
            {label}
          </button>
        ))}
      </div>
      {tab === "ai" ? <AeoIntelligencePanel /> : tab === "site" ? <SiteAeoPanel /> : <ManualAeoTracker />}
    </div>
  );
}

const COVERAGE_COLOR = {
  Answered: { fg: BRAND.visibility, bg: BRAND.visibilitySoft },
  Partial: { fg: BRAND.amber, bg: BRAND.amberSoft },
  Missing: { fg: BRAND.red, bg: BRAND.redSoft },
};

function AeoIntelligencePanel() {
  const { bundle, setBundles, currentWebsiteId, toast, addAction, setScore } = useApp();
  const b = bundle();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [coverageFilter, setCoverageFilter] = useState("All");
  const [expanded, setExpanded] = useState(null);
  const aeo = b.aeoAnalysis;

  async function runAnalysis() {
    if (!b.scanMeta?.live) { toast("Run a live scan first, from Websites — AEO analysis reads the real crawl.", "error"); return; }
    setLoading(true); setError("");
    try {
      const data = await postJson("/api/aeo-analysis", { scanMeta: b.scanMeta, keywords: b.keywordIntel?.keywords || [] });
      setBundles((prev) => {
        const site = prev[currentWebsiteId] || emptyBundle();
        return { ...prev, [currentWebsiteId]: { ...site, aeoAnalysis: data.result } };
      });
      const avgCoverage = data.result.questions.length
        ? data.result.questions.reduce((s, q) => s + q.coverageScore, 0) / data.result.questions.length
        : data.result.readinessScore;
      setScore("aeo", clamp(Math.round(0.5 * data.result.readinessScore + 0.5 * avgCoverage), 0, 100));
      toast("AEO analysis generated by VertexRank AI");
    } catch (err) {
      setError(err.message || "Couldn't run AEO analysis.");
    } finally {
      setLoading(false);
    }
  }

  function addQuestionToActions(q) {
    addAction({
      title: `Answer: "${q.question}"`, type: "FAQ Addition", status: "New",
      detail: { sourceId: `aeoq_${q.id}`, module: "AEO", evidence: q.missingInfo, recommendedAction: q.recommendedAnswer, priority: q.priority, confidence: "Medium", source: q.source },
    });
    toast("Added to Action Center");
  }
  function addRecToActions(r) {
    addAction({
      title: r.recommendation, type: "Content Update", status: "New",
      detail: { sourceId: `aeor_${r.id}`, module: "AEO", evidence: r.why, recommendedAction: r.recommendation, priority: r.priority, confidence: "Medium", source: r.source },
    });
    toast("Added to Action Center");
  }
  function isAdded(id) { return b.actions.some((a) => a.detail?.sourceId === id); }

  const signalLabels = AEO_SIGNAL_LABELS;

  const questions = (aeo?.questions || []).filter((q) => coverageFilter === "All" || q.coverage === coverageFilter);

  return (
    <div className="space-y-5">
      <AnalysisBanner icon={Sparkles}>
        VertexRank AI generates realistic buyer questions grounded in the real crawled content, then judges — using only that content — whether the page already answers each one. Nothing here claims to be real AI-search or Google data.
      </AnalysisBanner>

      <Card className="p-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><MessageCircleQuestion size={16} style={{ color: BRAND.primary }} /><h3 className="font-semibold vr-display">Run AEO Analysis</h3></div>
        {loading ? (
          <div className="flex items-center gap-2"><Loader2 className="vr-spin" size={18} style={{ color: BRAND.primary }} /><span className="text-sm" style={{ color: BRAND.inkSoft }}>VertexRank AI is generating questions and checking coverage…</span></div>
        ) : (
          <Button icon={aeo ? RefreshCw : Sparkles} onClick={runAnalysis}>{aeo ? "Re-run analysis" : "Run AEO Analysis"}</Button>
        )}
      </Card>
      {error && <p className="text-xs" style={{ color: BRAND.red }}>{error}</p>}
      {!b.scanMeta?.live && <p className="text-xs" style={{ color: BRAND.amber }}>This website hasn't been scanned yet — go to Websites and run a scan first.</p>}

      {aeo && (
        <>
          <Card className="p-5">
            <div className="flex items-center gap-4 flex-wrap mb-4">
              <ScoreDial label="AEO Readiness" value={b.scores?.aeo ?? aeo.readinessScore} size={92} accent={BRAND.visibility} />
              <div className="text-xs" style={{ color: BRAND.inkSoft }}>
                <p className="font-medium mb-1" style={{ color: BRAND.ink }}>How this score works</p>
                <p>Half comes from a real signal checklist below (schema, structure, existing Q&A); half from the average answer-coverage of the generated questions.</p>
                <p className="mt-1">Generated {fmtDate(aeo.generatedAt)}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(signalLabels).map(([key, label]) => (
                <span key={key} className="text-xs rounded-full px-2.5 py-1 flex items-center gap-1"
                  style={{ background: aeo.flags[key] ? BRAND.visibilitySoft : BRAND.canvas, color: aeo.flags[key] ? BRAND.visibility : BRAND.inkSoft }}>
                  {aeo.flags[key] ? <Check size={11} /> : <X size={11} />} {label}
                </span>
              ))}
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h3 className="font-semibold vr-display">Content Recommendations</h3>
              {(aeo.contentRecommendations || []).length > 0 && <CopyButton label="Copy" getText={() => sectionAeoRecommendations(aeo)} />}
            </div>
            {(aeo.contentRecommendations || []).length === 0 ? (
              <p className="text-sm" style={{ color: BRAND.inkSoft }}>No content additions flagged this run.</p>
            ) : (
              <div className="space-y-3">
                {sortByPriority(aeo.contentRecommendations).map((r) => (
                  <RecommendationCard key={r.id} title={r.recommendation} evidence={r.why} priority={r.priority} source={r.source}
                    added={isAdded(`aeor_${r.id}`)} onAdd={() => addRecToActions(r)} />
                ))}
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="p-4 flex flex-wrap gap-2 items-center justify-between" style={{ borderBottom: `1px solid ${BRAND.line}` }}>
              <h3 className="font-semibold vr-display">Question &amp; Answer Coverage</h3>
              <div className="flex items-center gap-2">
                <CopyButton label="Copy" title="Copies the questions currently shown (respects the filter)" getText={() => sectionAeoQuestions(questions)} />
                <Select value={coverageFilter} onChange={(e) => setCoverageFilter(e.target.value)}>
                  <option>All</option><option>Answered</option><option>Partial</option><option>Missing</option>
                </Select>
              </div>
            </div>
            <div className="divide-y" style={{ borderColor: BRAND.line }}>
              {questions.map((q) => (
                <div key={q.id}>
                  <button className="w-full text-left px-4 py-3 flex items-center gap-3 vr-row" onClick={() => setExpanded(expanded === q.id ? null : q.id)}>
                    <ChevronRight size={13} style={{ transform: expanded === q.id ? "rotate(90deg)" : "none", transition: "transform .15s", color: BRAND.inkSoft, flexShrink: 0 }} />
                    <span className="text-sm font-medium flex-1">{q.question}</span>
                    <Badge color={COVERAGE_COLOR[q.coverage] || COVERAGE_COLOR.Missing}>{q.coverage}</Badge>
                    <PriorityBadge priority={q.priority} />
                  </button>
                  {expanded === q.id && (
                    <div className="px-4 pb-4">
                      <div className="rounded-lg p-3.5 space-y-2" style={{ background: BRAND.canvas }}>
                        <div className="flex gap-4 text-xs flex-wrap" style={{ color: BRAND.inkSoft }}>
                          <span>Intent: {q.intent}</span>
                          {q.relatedKeyword && <span>Related keyword: {q.relatedKeyword}</span>}
                          <span>Coverage score: {q.coverageScore}/100</span>
                        </div>
                        {q.missingInfo && <div><p className="text-xs font-semibold mb-0.5" style={{ color: BRAND.inkSoft }}>Missing information</p><p className="text-sm">{q.missingInfo}</p></div>}
                        {q.recommendedAnswer && <div><p className="text-xs font-semibold mb-0.5" style={{ color: BRAND.inkSoft }}>Recommended answer</p><p className="text-sm">{q.recommendedAnswer}</p></div>}
                        <div className="flex justify-end pt-1">
                          <Button size="sm" variant={isAdded(`aeoq_${q.id}`) ? "outline" : "soft"} icon={isAdded(`aeoq_${q.id}`) ? Check : ListPlus} disabled={isAdded(`aeoq_${q.id}`)} onClick={() => addQuestionToActions(q)}>
                            {isAdded(`aeoq_${q.id}`) ? "Added" : "Add to Action Center"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {questions.length === 0 && <p className="text-sm px-4 py-6" style={{ color: BRAND.inkSoft }}>No questions match this filter.</p>}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/** Site-wide counterpart to AeoIntelligencePanel: judges whether the SITE AS
 *  A WHOLE answers buyer questions — the same question might be answered by
 *  a different page than whichever one a single-page analysis happened to
 *  look at. Reads b.siteCrawl (from a full-site crawl), not b.scanMeta. */
function SiteAeoPanel() {
  const { bundle, setBundles, currentWebsiteId, toast, addAction } = useApp();
  const b = bundle();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [coverageFilter, setCoverageFilter] = useState("All");
  const [expanded, setExpanded] = useState(null);
  const aeo = b.siteAeoAnalysis;

  async function runAnalysis() {
    setLoading(true); setError("");
    try {
      const data = await postJson("/api/site-aeo-analysis", { crawl: b.siteCrawl, keywords: b.keywordIntel?.keywords || [] });
      setBundles((prev) => {
        const site = prev[currentWebsiteId] || emptyBundle();
        return { ...prev, [currentWebsiteId]: { ...site, siteAeoAnalysis: data.result } };
      });
      if (data.warning) toast(data.warning);
      else toast("Site-wide AEO analysis generated by VertexRank AI");
    } catch (err) {
      setError(err.message || "Couldn't run site-wide AEO analysis.");
    } finally {
      setLoading(false);
    }
  }

  function addQuestionToActions(q) {
    addAction({ title: `Answer: "${q.question}"`, type: "FAQ Addition", status: "New", detail: { sourceId: `saeoq_${q.id}`, module: "Site-wide AEO", evidence: q.missingInfo, recommendedAction: q.recommendedAnswer, priority: q.priority, confidence: "Medium", source: q.source } });
    toast("Added to Action Center");
  }
  function addRecToActions(r) {
    addAction({ title: r.recommendation, type: "Content Update", status: "New", detail: { sourceId: `saeor_${r.id}`, module: "Site-wide AEO", evidence: r.why, recommendedAction: r.recommendation, priority: r.priority, confidence: "Medium", source: r.source } });
    toast("Added to Action Center");
  }
  function isAdded(id) { return b.actions.some((a) => a.detail?.sourceId === id); }

  if (!b.siteCrawl) return <SiteCrawlGate body="Site-wide AEO checks whether ANY page on your site answers a given buyer question — not just the one page a single-page scan happens to look at. That needs a full-site crawl." />;

  const questions = (aeo?.questions || []).filter((q) => coverageFilter === "All" || q.coverage === coverageFilter);

  return (
    <div className="space-y-5">
      <AnalysisBanner icon={Sparkles}>
        Reasoning over {b.siteCrawl.pagesCrawled} crawled pages of {b.siteCrawl.domain} — a question counts as "Answered" only if some real page on the site appears to cover it.
      </AnalysisBanner>

      <Card className="p-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><MessageCircleQuestion size={16} style={{ color: BRAND.primary }} /><h3 className="font-semibold vr-display">Run Site-wide AEO Analysis</h3></div>
        {loading ? (
          <div className="flex items-center gap-2"><Loader2 className="vr-spin" size={18} style={{ color: BRAND.primary }} /><span className="text-sm" style={{ color: BRAND.inkSoft }}>Reasoning across the crawled site…</span></div>
        ) : (
          <Button icon={aeo ? RefreshCw : Sparkles} onClick={runAnalysis}>{aeo ? "Re-run analysis" : "Run Site-wide AEO Analysis"}</Button>
        )}
      </Card>
      {error && <p className="text-xs" style={{ color: BRAND.red }}>{error}</p>}

      {aeo && (
        <>
          <Card className="p-5">
            <div className="flex items-center gap-4 flex-wrap mb-2">
              <ScoreDial label="Site AEO Readiness" value={aeo.readinessScore} size={92} accent={BRAND.visibility} />
              <div className="text-xs" style={{ color: BRAND.inkSoft }}>
                <p className="font-medium mb-1" style={{ color: BRAND.ink }}>Site-wide signal checklist</p>
                <p>A signal counts as true if ANY of the {aeo.pagesCrawled} crawled pages establishes it.</p>
                <p className="mt-1">Generated {fmtDate(aeo.generatedAt)}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {Object.entries(AEO_SIGNAL_LABELS).map(([key, label]) => (
                <span key={key} className="text-xs rounded-full px-2.5 py-1 flex items-center gap-1"
                  style={{ background: aeo.flags[key] ? BRAND.visibilitySoft : BRAND.canvas, color: aeo.flags[key] ? BRAND.visibility : BRAND.inkSoft }}>
                  {aeo.flags[key] ? <Check size={11} /> : <X size={11} />} {label}
                </span>
              ))}
            </div>
          </Card>

          {aeo.weakestPages && aeo.weakestPages.length > 0 && (
            <Card className="p-4">
              <h3 className="font-semibold vr-display mb-3">Weakest pages</h3>
              <div className="space-y-1.5">
                {aeo.weakestPages.slice(0, 8).map((p) => (
                  <div key={p.url} className="flex items-center justify-between gap-2 text-xs rounded px-3 py-2" style={{ background: BRAND.canvas }}>
                    <span className="truncate">{p.title}</span>
                    <span className="vr-mono font-semibold shrink-0" style={{ color: p.score < 40 ? BRAND.red : p.score < 70 ? BRAND.amber : BRAND.visibility }}>{p.score}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card className="p-5">
            <h3 className="font-semibold vr-display mb-3">Site-level content recommendations</h3>
            {(aeo.contentRecommendations || []).length === 0 ? <p className="text-sm" style={{ color: BRAND.inkSoft }}>No site-level additions flagged this run.</p> : (
              <div className="space-y-3">
                {sortByPriority(aeo.contentRecommendations).map((r) => (
                  <RecommendationCard key={r.id} title={r.recommendation} evidence={r.why} priority={r.priority} source={r.source} added={isAdded(`saeor_${r.id}`)} onAdd={() => addRecToActions(r)} />
                ))}
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="p-4 flex flex-wrap gap-2 items-center justify-between" style={{ borderBottom: `1px solid ${BRAND.line}` }}>
              <h3 className="font-semibold vr-display">Site-wide Question &amp; Answer Coverage</h3>
              <Select value={coverageFilter} onChange={(e) => setCoverageFilter(e.target.value)}>
                <option>All</option><option>Answered</option><option>Partial</option><option>Missing</option>
              </Select>
            </div>
            <div className="divide-y" style={{ borderColor: BRAND.line }}>
              {questions.map((q) => (
                <div key={q.id}>
                  <button className="w-full text-left px-4 py-3 flex items-center gap-3 vr-row" onClick={() => setExpanded(expanded === q.id ? null : q.id)}>
                    <ChevronRight size={13} style={{ transform: expanded === q.id ? "rotate(90deg)" : "none", transition: "transform .15s", color: BRAND.inkSoft, flexShrink: 0 }} />
                    <span className="text-sm font-medium flex-1">{q.question}</span>
                    <Badge color={COVERAGE_COLOR[q.coverage] || COVERAGE_COLOR.Missing}>{q.coverage}</Badge>
                    <PriorityBadge priority={q.priority} />
                  </button>
                  {expanded === q.id && (
                    <div className="px-4 pb-4">
                      <div className="rounded-lg p-3.5 space-y-2" style={{ background: BRAND.canvas }}>
                        <div className="flex gap-4 text-xs flex-wrap" style={{ color: BRAND.inkSoft }}>
                          <span>Intent: {q.intent}</span>
                          {q.relatedKeyword && <span>Related keyword: {q.relatedKeyword}</span>}
                          <span>Coverage score: {q.coverageScore}/100</span>
                          {q.answeringUrl && <span className="vr-mono">Answered by: {q.answeringUrl}</span>}
                        </div>
                        {q.missingInfo && <div><p className="text-xs font-semibold mb-0.5" style={{ color: BRAND.inkSoft }}>Missing information</p><p className="text-sm">{q.missingInfo}</p></div>}
                        {q.recommendedAnswer && <div><p className="text-xs font-semibold mb-0.5" style={{ color: BRAND.inkSoft }}>Recommended answer</p><p className="text-sm">{q.recommendedAnswer}</p></div>}
                        <div className="flex justify-end pt-1">
                          <Button size="sm" variant={isAdded(`saeoq_${q.id}`) ? "outline" : "soft"} icon={isAdded(`saeoq_${q.id}`) ? Check : ListPlus} disabled={isAdded(`saeoq_${q.id}`)} onClick={() => addQuestionToActions(q)}>
                            {isAdded(`saeoq_${q.id}`) ? "Added" : "Add to Action Center"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {questions.length === 0 && <p className="text-sm px-4 py-6" style={{ color: BRAND.inkSoft }}>No questions match this filter.</p>}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function ManualAeoTracker() {
  const { bundle, setBundles, currentWebsiteId, toast } = useApp();
  const b = bundle();
  const [modal, setModal] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [form, setForm] = useState({ question: "", hasAnswer: false });
  const [suggesting, setSuggesting] = useState(false);

  function mutate(fn) {
    setBundles((prev) => {
      const site = prev[currentWebsiteId] || emptyBundle();
      return { ...prev, [currentWebsiteId]: { ...site, aeoQuestions: fn(site.aeoQuestions) } };
    });
  }
  function openEdit(q) { setForm({ question: q.question, hasAnswer: q.hasAnswer }); setModal({ mode: "edit", q }); }
  function save() {
    if (!form.question.trim()) return;
    mutate((arr) => arr.map((x) => (x.id === modal.q.id ? { ...x, question: form.question.trim(), hasAnswer: form.hasAnswer } : x)));
    toast("Question updated");
    setModal(null);
  }
  function toggleAnswered(id, value) { mutate((arr) => arr.map((q) => (q.id === id ? { ...q, hasAnswer: value } : q))); }
  function del(id) { mutate((arr) => arr.filter((q) => q.id !== id)); toast("Question removed"); }

  // Populate the list with VertexRank AI's own generated questions (from the
  // AI Answer Coverage / Site-wide AEO tabs) — the only way new questions
  // enter this tracker now; nothing here is typed in by hand.
  async function suggestWithAi() {
    setSuggesting(true);
    try {
      let aeo = b.siteAeoAnalysis;
      let source = "site";
      if (!aeo) {
        if (b.siteCrawl) {
          const data = await postJson("/api/site-aeo-analysis", { crawl: b.siteCrawl, keywords: b.keywordIntel?.keywords || [] });
          aeo = data.result;
          setBundles((prev) => {
            const site = prev[currentWebsiteId] || emptyBundle();
            return { ...prev, [currentWebsiteId]: { ...site, siteAeoAnalysis: aeo } };
          });
        } else if (b.scanMeta?.live) {
          const data = await postJson("/api/aeo-analysis", { scanMeta: b.scanMeta, keywords: b.keywordIntel?.keywords || [] });
          aeo = data.result;
          source = "page";
          setBundles((prev) => {
            const site = prev[currentWebsiteId] || emptyBundle();
            return { ...prev, [currentWebsiteId]: { ...site, aeoAnalysis: aeo } };
          });
        } else {
          toast("Add a website first — a full-site crawl starts automatically and powers this.", "error");
          return;
        }
      }
      const existing = new Set(b.aeoQuestions.map((q) => q.question.toLowerCase()));
      const picks = (aeo.questions || []).filter((q) => !existing.has(q.question.toLowerCase()));
      if (picks.length === 0) { toast("No new AI-suggested questions — everything relevant is already tracked."); return; }
      mutate((arr) => [...arr, ...picks.map((q) => ({ id: uid("aeo"), websiteId: currentWebsiteId, question: q.question, hasAnswer: q.coverage === "Answered" }))]);
      toast(`Added ${picks.length} AI-suggested question${picks.length === 1 ? "" : "s"}${source === "page" ? " (from single-page AEO)" : ""}`);
    } catch (err) {
      toast(err.message || "Couldn't suggest questions.", "error");
    } finally {
      setSuggesting(false);
    }
  }

  const missing = b.aeoQuestions.filter((q) => !q.hasAnswer);
  const answered = b.aeoQuestions.filter((q) => q.hasAnswer);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs" style={{ background: BRAND.primarySoft, color: BRAND.primary }}>
        <Info size={14} />
        Questions here come only from VertexRank AI's own suggestions (grounded in the crawl) — there's no manual add, so nothing here is a guess you typed in.
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="soft" icon={suggesting ? Loader2 : Sparkles} disabled={suggesting} onClick={suggestWithAi}>{suggesting ? "Suggesting…" : "Suggest with AI"}</Button>
      </div>

      {b.aeoQuestions.length === 0 ? (
        <Card><EmptyState icon={MessageCircleQuestion} title="No questions tracked yet" body="Let VertexRank AI suggest questions grounded in the crawl." action={<Button variant="soft" icon={Sparkles} onClick={suggestWithAi}>Suggest with AI</Button>} /></Card>
      ) : (
        <>
          <Card className="p-5">
            <div className="flex items-center gap-2 mb-1"><MessageCircleQuestion size={16} style={{ color: BRAND.primary }} /><h3 className="font-semibold vr-display">Needs a direct answer</h3></div>
            <p className="text-sm mb-4" style={{ color: BRAND.inkSoft }}>Questions you haven't marked as answered on-site yet.</p>
            <div className="space-y-2.5">
              {missing.map((q) => (
                <div key={q.id} className="flex items-center justify-between gap-3 rounded-lg px-4 py-3" style={{ background: BRAND.canvas }}>
                  <p className="text-sm font-medium">{q.question}</p>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="soft" icon={Check} onClick={() => toggleAnswered(q.id, true)}>Mark answered</Button>
                    <IconButton icon={Pencil} onClick={() => openEdit(q)} title="Edit" />
                    <IconButton icon={Trash2} danger onClick={() => setConfirmDelete(q)} title="Delete" />
                  </div>
                </div>
              ))}
              {missing.length === 0 && <p className="text-sm" style={{ color: BRAND.inkSoft }}>Everything tracked is marked answered.</p>}
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 mb-3"><CheckCircle2 size={16} style={{ color: BRAND.visibility }} /><h3 className="font-semibold vr-display">Already answered on-site</h3></div>
            <div className="grid sm:grid-cols-2 gap-2.5">
              {answered.map((q) => (
                <div key={q.id} className="flex items-center justify-between gap-2 rounded-lg px-4 py-3" style={{ background: BRAND.visibilitySoft }}>
                  <p className="text-sm">{q.question}</p>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <IconButton icon={Pencil} onClick={() => openEdit(q)} title="Edit" />
                    <IconButton icon={Trash2} danger onClick={() => setConfirmDelete(q)} title="Delete" />
                  </div>
                </div>
              ))}
              {answered.length === 0 && <p className="text-sm" style={{ color: BRAND.inkSoft }}>Nothing marked answered yet.</p>}
            </div>
          </Card>
        </>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)} title="Edit question"
        footer={<><Button variant="outline" onClick={() => setModal(null)}>Cancel</Button><Button onClick={save}>Save</Button></>}>
        <Field label="Question a buyer might ask an AI assistant"><TextArea value={form.question} onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))} /></Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.hasAnswer} onChange={(e) => setForm((f) => ({ ...f, hasAnswer: e.target.checked }))} />
          This is already answered directly somewhere on the site
        </label>
      </Modal>
      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete question" body="This question will be permanently removed." onConfirm={() => del(confirmDelete.id)} />
    </div>
  );
}

/* ============================== GEO ============================== */

function GeoView() {
  const { currentWebsiteId } = useApp();
  const [tab, setTab] = useState("site");
  if (!currentWebsiteId) return <EmptyState icon={Globe2} title="Select a website" body="Choose a website from the top bar." />;

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg p-1 w-fit" style={{ background: BRAND.canvas }}>
        {[["site", "Site-wide GEO"], ["geo", "GEO / AI Visibility"], ["sim", "AI Visibility Simulator"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className="vr-focus text-sm font-medium rounded-md px-3 py-1.5 flex items-center gap-1.5"
            style={{ background: tab === id ? BRAND.surface : "transparent", color: tab === id ? BRAND.primary : BRAND.inkSoft, boxShadow: tab === id ? `0 1px 2px rgba(0,0,0,0.06)` : "none" }}>
            {id === "sim" && <Bot size={14} />} {label}
          </button>
        ))}
      </div>
      {tab === "geo" ? <GeoIntelligencePanel /> : tab === "site" ? <SiteGeoPanel /> : <AiVisibilitySimulatorPanel />}
    </div>
  );
}

function GeoIntelligencePanel() {
  const { bundle, setBundles, currentWebsiteId, toast, addAction, setScore } = useApp();
  const b = bundle();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const geo = b.geoAnalysis;

  async function runAnalysis() {
    if (!b.scanMeta?.live) { toast("Run a live scan first, from Websites — GEO analysis reads the real crawl.", "error"); return; }
    setLoading(true); setError("");
    try {
      const data = await postJson("/api/geo-analysis", { scanMeta: b.scanMeta });
      setBundles((prev) => {
        const site = prev[currentWebsiteId] || emptyBundle();
        return { ...prev, [currentWebsiteId]: { ...site, geoAnalysis: data.result } };
      });
      const factorValues = Object.values(data.result.factors).map((f) => f.score);
      const avgFactor = factorValues.length ? factorValues.reduce((a, v) => a + v, 0) / factorValues.length : data.result.visibilityScore;
      setScore("geo", clamp(Math.round(0.6 * data.result.visibilityScore + 0.4 * avgFactor), 0, 100));
      toast("GEO analysis generated by VertexRank AI");
    } catch (err) {
      setError(err.message || "Couldn't run GEO analysis.");
    } finally {
      setLoading(false);
    }
  }

  function addOppToActions(o) {
    addAction({
      title: o.title, type: "Schema Markup", status: "New",
      detail: { sourceId: `geoo_${o.id}`, module: "GEO / AI Visibility", evidence: o.why, recommendedAction: o.title, priority: o.priority, confidence: "Medium", source: o.source },
    });
    toast("Added to Action Center");
  }
  function isAdded(id) { return b.actions.some((a) => a.detail?.sourceId === id); }

  const authorityLabels = GEO_AUTHORITY_LABELS;

  return (
    <div className="space-y-5">
      <AnalysisBanner icon={RadarIcon}>
        VertexRank AI reasons only over the real crawled page to judge how clearly an AI system could understand this business. This is an "AI Visibility Opportunity" assessment, not a guarantee of inclusion in any AI system's answers.
      </AnalysisBanner>

      <Card className="p-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><RadarIcon size={16} style={{ color: BRAND.primary }} /><h3 className="font-semibold vr-display">Run GEO Analysis</h3></div>
        {loading ? (
          <div className="flex items-center gap-2"><Loader2 className="vr-spin" size={18} style={{ color: BRAND.primary }} /><span className="text-sm" style={{ color: BRAND.inkSoft }}>VertexRank AI is assessing entity clarity and authority signals…</span></div>
        ) : (
          <Button icon={geo ? RefreshCw : Sparkles} onClick={runAnalysis}>{geo ? "Re-run analysis" : "Run GEO Analysis"}</Button>
        )}
      </Card>
      {error && <p className="text-xs" style={{ color: BRAND.red }}>{error}</p>}
      {!b.scanMeta?.live && <p className="text-xs" style={{ color: BRAND.amber }}>This website hasn't been scanned yet — go to Websites and run a scan first.</p>}

      {geo ? (
        <>
          <Card className="p-5">
            <div className="flex items-center gap-4 flex-wrap mb-4">
              <ScoreDial label="GEO / AI Visibility" value={b.scores?.geo ?? geo.visibilityScore} size={92} accent={BRAND.visibility} />
              <div className="text-xs" style={{ color: BRAND.inkSoft }}>
                <p className="font-medium mb-1" style={{ color: BRAND.ink }}>How this score works</p>
                <p>60% comes from a real, rule-based signal checklist (schema, contact/about info, credentials); 40% from VertexRank AI's qualitative judgment of the eight factors below.</p>
                <p className="mt-1">Generated {fmtDate(geo.generatedAt)}</p>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              {GEO_FACTORS.map((f) => {
                const factor = geo.factors[f.key];
                return (
                  <div key={f.key} className="rounded-lg px-4 py-3" style={{ background: BRAND.canvas }}>
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <p className="text-sm font-medium">{f.label}</p>
                      <span className="text-sm vr-mono font-semibold" style={{ color: factor.score >= 60 ? BRAND.visibility : factor.score >= 35 ? BRAND.amber : BRAND.red }}>{factor.score}</span>
                    </div>
                    <p className="text-xs mb-1.5" style={{ color: BRAND.inkSoft }}>{f.blurb}</p>
                    {factor.note && <p className="text-xs">{factor.note}</p>}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="font-semibold vr-display mb-3">Authority &amp; Trust Signals</h3>
            <p className="text-xs mb-3" style={{ color: BRAND.inkSoft }}>Crawled Data · detected directly from the page.</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(authorityLabels).map(([key, label]) => (
                <span key={key} className="text-xs rounded-full px-2.5 py-1 flex items-center gap-1"
                  style={{ background: geo.flags[key] ? BRAND.visibilitySoft : BRAND.canvas, color: geo.flags[key] ? BRAND.visibility : BRAND.inkSoft }}>
                  {geo.flags[key] ? <Check size={11} /> : <X size={11} />} {label}
                </span>
              ))}
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2"><ShieldCheck size={16} style={{ color: BRAND.primary }} /><h3 className="font-semibold vr-display">AI Visibility Opportunities</h3></div>
              {(geo.opportunities || []).length > 0 && <CopyButton label="Copy" getText={() => sectionGeoOpportunities(geo)} />}
            </div>
            {(geo.opportunities || []).length === 0 ? (
              <p className="text-sm" style={{ color: BRAND.inkSoft }}>No opportunities flagged this run.</p>
            ) : (
              <div className="space-y-3">
                {sortByPriority(geo.opportunities).map((o) => (
                  <RecommendationCard key={o.id} title={o.title} evidence={o.why} priority={o.priority} source={o.source}
                    added={isAdded(`geoo_${o.id}`)} onAdd={() => addOppToActions(o)} />
                ))}
              </div>
            )}
          </Card>
        </>
      ) : (
        <Card className="p-5">
          <h3 className="font-semibold vr-display mb-3">What GEO scoring measures</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            {GEO_FACTORS.map((f) => (
              <div key={f.key} className="flex items-start justify-between gap-3 rounded-lg px-4 py-3" style={{ background: BRAND.canvas }}>
                <div><p className="text-sm font-medium">{f.label}</p><p className="text-xs mt-0.5" style={{ color: BRAND.inkSoft }}>{f.blurb}</p></div>
                <span className="text-xs font-medium shrink-0" style={{ color: BRAND.inkSoft }}>Not analyzed yet</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

const READINESS_COLOR = {
  Strong: { fg: BRAND.visibility, bg: BRAND.visibilitySoft },
  Partial: { fg: BRAND.amber, bg: BRAND.amberSoft },
  Weak: { fg: BRAND.red, bg: BRAND.redSoft },
};

/** Site-wide counterpart to GeoIntelligencePanel: judges the SITE AS A
 *  WHOLE's clarity/authority/trust signals from a full-site crawl, plus
 *  entities detected across every crawled page — not just one URL. */
function SiteGeoPanel() {
  const { bundle, setBundles, currentWebsiteId, toast, addAction } = useApp();
  const b = bundle();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const geo = b.siteGeoAnalysis;

  async function runAnalysis() {
    setLoading(true); setError("");
    try {
      const data = await postJson("/api/site-geo-analysis", { crawl: b.siteCrawl });
      setBundles((prev) => {
        const site = prev[currentWebsiteId] || emptyBundle();
        return { ...prev, [currentWebsiteId]: { ...site, siteGeoAnalysis: data.result } };
      });
      if (data.warning) toast(data.warning);
      else toast("Site-wide GEO analysis generated by VertexRank AI");
    } catch (err) {
      setError(err.message || "Couldn't run site-wide GEO analysis.");
    } finally {
      setLoading(false);
    }
  }

  function addOppToActions(o) {
    addAction({ title: o.title, type: "Schema Markup", status: "New", detail: { sourceId: `sgeoo_${o.id}`, module: "Site-wide GEO", evidence: o.why, recommendedAction: o.title, priority: o.priority, confidence: "Medium", source: o.source } });
    toast("Added to Action Center");
  }
  function isAdded(id) { return b.actions.some((a) => a.detail?.sourceId === id); }

  if (!b.siteCrawl) return <SiteCrawlGate body="Site-wide GEO looks for entity/authority signals — About, Contact, credentials, testimonials — across EVERY page, since a business either clearly has these somewhere on the site or it doesn't. That needs a full-site crawl." />;

  return (
    <div className="space-y-5">
      <AnalysisBanner icon={RadarIcon}>
        Reasoning over {b.siteCrawl.pagesCrawled} crawled pages of {b.siteCrawl.domain}. This is an "AI Visibility Opportunity" assessment, not a guarantee of inclusion in any AI system's answers.
      </AnalysisBanner>

      <Card className="p-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><RadarIcon size={16} style={{ color: BRAND.primary }} /><h3 className="font-semibold vr-display">Run Site-wide GEO Analysis</h3></div>
        {loading ? (
          <div className="flex items-center gap-2"><Loader2 className="vr-spin" size={18} style={{ color: BRAND.primary }} /><span className="text-sm" style={{ color: BRAND.inkSoft }}>Assessing entity clarity and authority across the site…</span></div>
        ) : (
          <Button icon={geo ? RefreshCw : Sparkles} onClick={runAnalysis}>{geo ? "Re-run analysis" : "Run Site-wide GEO Analysis"}</Button>
        )}
      </Card>
      {error && <p className="text-xs" style={{ color: BRAND.red }}>{error}</p>}

      {geo && geo.factors && (
        <>
          <Card className="p-5">
            <div className="flex items-center gap-4 flex-wrap mb-4">
              <ScoreDial label="Site GEO Visibility" value={geo.visibilityScore} size={92} accent={BRAND.visibility} />
              <div className="text-xs" style={{ color: BRAND.inkSoft }}>
                <p className="font-medium mb-1" style={{ color: BRAND.ink }}>How this score works</p>
                <p>Rule-based signal checklist across every crawled page, combined with VertexRank AI's qualitative judgment of the eight factors below.</p>
                <p className="mt-1">Generated {fmtDate(geo.generatedAt)}</p>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              {GEO_FACTORS.map((f) => {
                const factor = geo.factors[f.key];
                return (
                  <div key={f.key} className="rounded-lg px-4 py-3" style={{ background: BRAND.canvas }}>
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <p className="text-sm font-medium">{f.label}</p>
                      <span className="text-sm vr-mono font-semibold" style={{ color: factor.score >= 60 ? BRAND.visibility : factor.score >= 35 ? BRAND.amber : BRAND.red }}>{factor.score}</span>
                    </div>
                    <p className="text-xs mb-1.5" style={{ color: BRAND.inkSoft }}>{f.blurb}</p>
                    {factor.note && <p className="text-xs">{factor.note}</p>}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="font-semibold vr-display mb-3">Authority &amp; Trust Signals</h3>
            <p className="text-xs mb-3" style={{ color: BRAND.inkSoft }}>Crawled Data · true if any crawled page establishes it.</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(GEO_AUTHORITY_LABELS).map(([key, label]) => (
                <span key={key} className="text-xs rounded-full px-2.5 py-1 flex items-center gap-1"
                  style={{ background: geo.flags[key] ? BRAND.visibilitySoft : BRAND.canvas, color: geo.flags[key] ? BRAND.visibility : BRAND.inkSoft }}>
                  {geo.flags[key] ? <Check size={11} /> : <X size={11} />} {label}
                </span>
              ))}
            </div>
          </Card>

          {geo.entities && geo.entities.length > 0 && (
            <Card className="p-5">
              <h3 className="font-semibold vr-display mb-3">Entities detected across the site</h3>
              <div className="flex flex-wrap gap-1.5">
                {geo.entities.slice(0, 20).map((e) => (
                  <span key={e.entity} className="text-xs rounded-full px-2.5 py-1" style={{ background: BRAND.primarySoft, color: BRAND.primary }}>{e.entity} · {e.occurrences}</span>
                ))}
              </div>
            </Card>
          )}

          <Card className="p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2"><ShieldCheck size={16} style={{ color: BRAND.primary }} /><h3 className="font-semibold vr-display">Site-level AI Visibility Opportunities</h3></div>
            </div>
            {(geo.opportunities || []).length === 0 ? (
              <p className="text-sm" style={{ color: BRAND.inkSoft }}>No opportunities flagged this run.</p>
            ) : (
              <div className="space-y-3">
                {sortByPriority(geo.opportunities).map((o) => (
                  <RecommendationCard key={o.id} title={o.title} evidence={o.why} priority={o.priority} source={o.source} added={isAdded(`sgeoo_${o.id}`)} onAdd={() => addOppToActions(o)} />
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function AiVisibilitySimulatorPanel() {
  const { bundle, setBundles, currentWebsiteId, toast, addAction } = useApp();
  const b = bundle();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sim = b.aiVisibility;

  async function runSimulation() {
    if (!b.scanMeta?.live) { toast("Run a live scan first, from Websites — the simulator reads the real crawl.", "error"); return; }
    setLoading(true); setError("");
    try {
      const data = await postJson("/api/ai-visibility-simulator", {
        scanMeta: b.scanMeta, keywords: b.keywordIntel?.keywords || [], country: "Kenya",
      });
      setBundles((prev) => {
        const site = prev[currentWebsiteId] || emptyBundle();
        return { ...prev, [currentWebsiteId]: { ...site, aiVisibility: data.result } };
      });
      toast("AI Visibility Simulation generated");
    } catch (err) {
      setError(err.message || "Couldn't run the simulation.");
    } finally {
      setLoading(false);
    }
  }
  function addToActions(q) {
    addAction({
      title: `Improve AI visibility for: "${q.query}"`, type: "Content Update", status: "New",
      detail: { sourceId: `sim_${q.id}`, module: "AI Visibility Simulator", evidence: q.missingInfo, recommendedAction: q.recommendedImprovement, priority: q.answerReadiness === "Weak" ? "High" : "Medium", confidence: "Medium", source: "VertexRank AI Visibility Simulation" },
    });
    toast("Added to Action Center");
  }
  function isAdded(id) { return b.actions.some((a) => a.detail?.sourceId === id); }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs font-medium" style={{ background: BRAND.primarySoft, color: BRAND.primary }}>
        <Bot size={14} />
        VertexRank AI Visibility Simulation — not actual AI search results. This does not call or reflect ChatGPT, Gemini, Perplexity, or Google AI Overviews.
      </div>

      <Card className="p-5 flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="font-semibold vr-display mb-1">Simulate AI search visibility</h3><p className="text-sm" style={{ color: BRAND.inkSoft }}>Generates realistic questions a person might ask an AI assistant, and checks how well this page's real content could support an answer.</p></div>
        {loading ? (
          <div className="flex items-center gap-2"><Loader2 className="vr-spin" size={18} style={{ color: BRAND.primary }} /><span className="text-sm" style={{ color: BRAND.inkSoft }}>Simulating…</span></div>
        ) : (
          <div className="flex items-center gap-2">
            {sim && <CopyButton label="Copy results" variant="outline" size="md" getText={() => sectionSimulator(sim)} />}
            <Button icon={sim ? RefreshCw : Bot} onClick={runSimulation}>{sim ? "Re-run simulation" : "Run Simulation"}</Button>
          </div>
        )}
      </Card>
      {error && <p className="text-xs" style={{ color: BRAND.red }}>{error}</p>}
      {!b.scanMeta?.live && <p className="text-xs" style={{ color: BRAND.amber }}>This website hasn't been scanned yet — go to Websites and run a scan first.</p>}

      {sim && (
        <div className="space-y-3">
          {sim.queries.map((q) => (
            <Card key={q.id} className="p-4">
              <div className="flex items-start justify-between gap-3 mb-2">
                <p className="text-sm font-medium pr-2">"{q.query}"</p>
                <Badge color={READINESS_COLOR[q.answerReadiness] || READINESS_COLOR.Weak}>{q.answerReadiness}</Badge>
              </div>
              <div className="flex items-center gap-3 mb-2 text-xs" style={{ color: BRAND.inkSoft }}>
                {q.relevantEntity && <span>Entity: {q.relevantEntity}</span>}
                <span>Coverage score: {q.coverageScore}/100</span>
              </div>
              {q.missingInfo && <div className="rounded p-2 mb-2" style={{ background: BRAND.canvas }}><p className="text-[10px] font-semibold mb-0.5" style={{ color: BRAND.inkSoft }}>MISSING INFORMATION</p><p className="text-xs">{q.missingInfo}</p></div>}
              {q.recommendedImprovement && <div className="rounded p-2 mb-2" style={{ background: BRAND.visibilitySoft }}><p className="text-[10px] font-semibold mb-0.5" style={{ color: BRAND.visibility }}>RECOMMENDED IMPROVEMENT</p><p className="text-xs">{q.recommendedImprovement}</p></div>}
              <div className="flex justify-end">
                <Button size="sm" variant={isAdded(`sim_${q.id}`) ? "outline" : "soft"} icon={isAdded(`sim_${q.id}`) ? Check : ListPlus} disabled={isAdded(`sim_${q.id}`)} onClick={() => addToActions(q)}>
                  {isAdded(`sim_${q.id}`) ? "Added" : "Add to Action Center"}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================== Competitors ============================== */

function CompetitorsView() {
  const { bundle, setBundles, currentWebsiteId, toast, addAction } = useApp();
  const b = bundle();
  const [modal, setModal] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [form, setForm] = useState({ name: "", url: "" });
  const [analyzing, setAnalyzing] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [suggesting, setSuggesting] = useState(false);

  if (!currentWebsiteId) return <EmptyState icon={Globe2} title="Select a website" body="Choose a website from the top bar to see competitor analysis." />;

  function mutate(fn) {
    setBundles((prev) => {
      const site = prev[currentWebsiteId] || emptyBundle();
      return { ...prev, [currentWebsiteId]: { ...site, competitors: fn(site.competitors) } };
    });
  }
  function setSuggestions(fn) {
    setBundles((prev) => {
      const site = prev[currentWebsiteId] || emptyBundle();
      return { ...prev, [currentWebsiteId]: { ...site, competitorSuggestions: fn(site.competitorSuggestions || []) } };
    });
  }
  function openEdit(c) { setForm({ name: c.name, url: c.url }); setModal({ mode: "edit", c }); }
  function save() {
    if (!form.name.trim()) return;
    mutate((arr) => arr.map((x) => (x.id === modal.c.id ? { ...x, name: form.name.trim(), url: form.url.trim() || x.url } : x)));
    toast("Competitor updated");
    setModal(null);
  }
  function del(id) { mutate((arr) => arr.filter((x) => x.id !== id)); toast("Competitor removed"); }

  async function analyze(c) {
    if (b.siteCrawl?.pages?.length) return analyzeSiteWide(c);
    if (!b.scanMeta?.live) { toast("Run a live scan of your own site first — from Websites.", "error"); return; }
    setAnalyzing(c.id);
    try {
      const data = await postJson("/api/competitor-scan", {
        competitorUrl: c.url, scanMeta: b.scanMeta, ourKeywords: (b.keywordIntel?.keywords || []).map((k) => k.keyword),
      });
      mutate((arr) => arr.map((x) => (x.id === c.id ? { ...x, analysis: data.result } : x)));
      setExpanded(c.id);
      toast(data.warning ? "Observed comparison ready (AI interpretation unavailable)" : "Competitor analysis ready");
    } catch (err) {
      toast(err.message || "Couldn't analyze that competitor.", "error");
    } finally {
      setAnalyzing(null);
    }
  }

  // Site-wide competitor analysis: crawls the competitor's WHOLE site (not
  // just one page) and compares it against our own full-site crawl. Chains
  // straight into automatic backlink-opportunity discovery using that same
  // competitor crawl the moment it comes back — no second crawl, and no
  // manual URL entry anywhere in the flow.
  async function analyzeSiteWide(c) {
    setAnalyzing(c.id);
    try {
      const data = await postJson("/api/site-competitor-analysis", { competitorUrl: c.url, ourCrawl: b.siteCrawl });
      mutate((arr) => arr.map((x) => (x.id === c.id ? { ...x, siteAnalysis: data.result } : x)));
      setExpanded(c.id);
      toast(data.warning ? "Site-wide comparison ready (AI interpretation unavailable)" : "Site-wide competitor analysis ready");

      if (data.competitorCrawl?.pages?.length) {
        try {
          const bl = await postJson("/api/backlink-opportunities", {
            crawl: data.competitorCrawl,
            ourContext: b.scanMeta?.title ? `${b.scanMeta.domain} — ${b.scanMeta.title}` : (b.siteCrawl?.domain || ""),
          });
          mutate((arr) => arr.map((x) => (x.id === c.id ? { ...x, backlinkOpportunities: bl.result } : x)));
          if ((bl.result.opportunities?.length || 0) > 0) toast(`Found ${bl.result.opportunities.length} potential backlink prospect${bl.result.opportunities.length === 1 ? "" : "s"} from ${c.name}'s site`);
        } catch {
          // Non-fatal — the competitor comparison above still succeeded even
          // if this automatic follow-up step failed.
        }
      }
    } catch (err) {
      toast(err.message || "Couldn't analyze that competitor site-wide.", "error");
    } finally {
      setAnalyzing(null);
    }
  }
  function addGapToActions(c, g) {
    addAction({
      title: g.gap, type: "Content Update", status: "New",
      detail: { sourceId: `${c.id}_${g.id}`, module: `Competitor: ${c.name}`, evidence: g.evidence, recommendedAction: g.recommendedAction, priority: g.priority, confidence: "Medium", source: g.source },
    });
    toast("Added to Action Center");
  }
  function addAeoGeoDiffToActions(c, d) {
    addAction({
      title: d.difference, type: "Schema Markup", status: "New",
      detail: { sourceId: `${c.id}_${d.id}`, module: `Competitor: ${c.name} (AEO/GEO)`, recommendedAction: d.recommendedAction, priority: d.priority, confidence: "Medium", source: d.source },
    });
    toast("Added to Action Center");
  }
  function isAdded(id) { return b.actions.some((a) => a.detail?.sourceId === id); }
  function isBacklinkTracked(host) { return b.backlinks.some((x) => x.name === host); }
  function addBacklinkToTracker(o) {
    setBundles((prev) => {
      const site = prev[currentWebsiteId] || emptyBundle();
      if (site.backlinks.some((x) => x.name === o.host)) return prev;
      const item = {
        id: uid("bl"), websiteId: currentWebsiteId, name: o.host,
        type: mapBacklinkDestinationType(o.destinationType),
        description: [o.whyRelevant, o.suggestedApproach].filter(Boolean).join(" "),
        difficulty: "Moderate", status: "Not started",
      };
      return { ...prev, [currentWebsiteId]: { ...site, backlinks: [item, ...site.backlinks] } };
    });
    toast(`${o.host} added to Backlink Radar`);
  }

  // Suggests plausible real-world competitors from VertexRank AI's general
  // knowledge of this site's industry/location, so the user doesn't have to
  // already know who to add — each suggestion still needs a click to accept
  // since company names/URLs here are the model's best guess, not verified fact.
  async function suggestCompetitors() {
    let scanMeta = b.scanMeta;
    if (!scanMeta?.live) {
      const homepage = b.siteCrawl?.pages?.find((p) => p.url === b.siteCrawl.startUrl) || b.siteCrawl?.pages?.[0];
      if (homepage) scanMeta = { domain: b.siteCrawl.domain, title: homepage.title, metaDescription: homepage.metaDescription, h1Text: homepage.h1Text, fullText: homepage.fullText };
    }
    if (!scanMeta?.domain) { toast("Add a website first — a full-site crawl starts automatically and powers this.", "error"); return; }
    setSuggesting(true);
    try {
      const data = await postJson("/api/competitor-suggestions", { scanMeta });
      const existing = new Set(b.competitors.map((c) => c.name.toLowerCase()));
      const fresh = (data.result.suggestions || []).filter((s) => s.name && !existing.has(s.name.toLowerCase()));
      setSuggestions(() => fresh);
      if (fresh.length === 0) toast("VertexRank AI didn't have any new competitor suggestions this time.");
    } catch (err) {
      toast(err.message || "Couldn't suggest competitors.", "error");
    } finally {
      setSuggesting(false);
    }
  }
  function acceptSuggestion(s) {
    mutate((arr) => [...arr, { id: uid("comp"), websiteId: currentWebsiteId, analysis: null, name: s.name, url: s.url || s.name.toLowerCase().replace(/\s+/g, "") + ".com" }]);
    setSuggestions((arr) => arr.filter((x) => x.id !== s.id));
    toast(`${s.name} added — verify the URL before analyzing`);
  }
  function dismissSuggestion(id) { setSuggestions((arr) => arr.filter((x) => x.id !== id)); }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs" style={{ background: b.siteCrawl ? BRAND.primarySoft : BRAND.amberSoft, color: b.siteCrawl ? BRAND.primary : BRAND.amber }}>
        <Info size={14} />
        {b.siteCrawl
          ? `Site-wide comparison is on: analyzing a competitor crawls their whole site and compares it against your ${b.siteCrawl.pagesCrawled}-page crawl, then automatically mines their outbound links for backlink prospects — no manual entry needed.`
          : "Competitor SEO scores and shared-keyword counts require a paid data provider — not connected yet. You can analyze one real, publicly crawlable competitor page below, or run a full-site crawl of your own site (from Websites) to unlock a full site-wide comparison and automatic backlink discovery."}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="soft" icon={suggesting ? Loader2 : Sparkles} disabled={suggesting} onClick={suggestCompetitors}>{suggesting ? "Suggesting…" : "Suggest with AI"}</Button>
      </div>

      {(b.competitorSuggestions || []).length > 0 && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-1"><Sparkles size={16} style={{ color: BRAND.primary }} /><h3 className="font-semibold vr-display">AI-suggested competitors</h3></div>
          <p className="text-xs mb-3" style={{ color: BRAND.inkSoft }}>VertexRank AI's best guess from general knowledge of this industry — not a live search. Verify the name and URL before relying on it.</p>
          <div className="space-y-2">
            {b.competitorSuggestions.map((s) => (
              <div key={s.id} className="flex items-start justify-between gap-3 rounded-lg px-4 py-3" style={{ background: BRAND.canvas }}>
                <div>
                  <div className="flex items-center gap-2"><p className="text-sm font-medium">{s.name}</p><Badge color={{ fg: BRAND.inkSoft, bg: BRAND.surface }}>{s.confidence} confidence</Badge></div>
                  {s.url && <p className="text-xs" style={{ color: BRAND.inkSoft }}>{s.url}</p>}
                  <p className="text-xs mt-1">{s.reason}</p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant="soft" icon={Plus} onClick={() => acceptSuggestion(s)}>Add</Button>
                  <IconButton icon={X} onClick={() => dismissSuggestion(s.id)} title="Dismiss" />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {b.competitors.length === 0 ? <Card><EmptyState icon={Users} title="No competitors tracked" body="Let VertexRank AI suggest competitors from the crawl, then accept the ones that fit." action={<Button variant="soft" icon={Sparkles} onClick={suggestCompetitors}>Suggest with AI</Button>} /></Card> : (
        <div className="grid sm:grid-cols-2 gap-4">
          {b.competitors.map((c) => (
            <Card key={c.id} className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-semibold text-sm">{c.name}</p>
                  <p className="text-xs" style={{ color: BRAND.inkSoft }}>{c.url}</p>
                </div>
                <div className="flex gap-0.5">
                  <CopyButton iconOnly label="Copy this competitor and its analysis" getText={() => formatCompetitor(c, "##")} />
                  <IconButton icon={Pencil} onClick={() => openEdit(c)} title="Edit" />
                  <IconButton icon={Trash2} danger onClick={() => setConfirmDelete(c)} title="Delete" />
                </div>
              </div>
              <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${BRAND.line}` }}>
                {analyzing === c.id ? (
                  <div className="flex items-center gap-2 text-sm" style={{ color: BRAND.inkSoft }}><Loader2 className="vr-spin" size={16} /> {b.siteCrawl ? "Crawling their whole site and comparing…" : "Crawling and comparing…"}</div>
                ) : (
                  <Button size="sm" variant="soft" icon={(c.siteAnalysis || c.analysis) ? RefreshCw : Search} onClick={() => analyze(c)}>
                    {b.siteCrawl ? ((c.siteAnalysis || c.analysis) ? "Re-analyze site-wide" : "Analyze site-wide") : ((c.siteAnalysis || c.analysis) ? "Re-analyze" : "Analyze real page")}
                  </Button>
                )}
                {(c.siteAnalysis || c.analysis) && (
                  <button className="text-xs ml-2 underline" style={{ color: BRAND.primary }} onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                    {expanded === c.id ? "Hide" : "Show"} comparison
                  </button>
                )}
              </div>
              {c.siteAnalysis && expanded === c.id && (
                <div className="mt-3 space-y-3">
                  <div className="rounded-lg p-3" style={{ background: BRAND.canvas }}>
                    <p className="text-[10px] font-semibold mb-2" style={{ color: BRAND.inkSoft }}>SITE-WIDE OBSERVED DATA · {c.siteAnalysis.observed.ourPagesCrawled} of our pages vs {c.siteAnalysis.observed.competitorPagesCrawled} of theirs</p>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs mb-2">
                      <span>Avg. word count</span><span>{c.siteAnalysis.observed.comparison.avgWordCount.ours} vs {c.siteAnalysis.observed.comparison.avgWordCount.competitor}</span>
                      <span>Orphan page rate</span><span>{c.siteAnalysis.observed.comparison.orphanPageRatioPct.ours}% vs {c.siteAnalysis.observed.comparison.orphanPageRatioPct.competitor}%</span>
                      <span>AEO readiness</span><span>{c.siteAnalysis.observed.comparison.aeoReadiness.ours} vs {c.siteAnalysis.observed.comparison.aeoReadiness.competitor}</span>
                      <span>GEO visibility</span><span>{c.siteAnalysis.observed.comparison.geoVisibility.ours} vs {c.siteAnalysis.observed.comparison.geoVisibility.competitor}</span>
                    </div>
                    <p className="text-[10px]" style={{ color: BRAND.inkSoft }}>(you vs {c.name})</p>
                    {c.siteAnalysis.observed.competitorOnlyTopics.length > 0 && (
                      <>
                        <p className="text-xs font-medium mt-2 mb-1">Topics they cover across their site that we don't</p>
                        <div className="flex flex-wrap gap-1">{c.siteAnalysis.observed.competitorOnlyTopics.slice(0, 12).map((t) => <span key={t} className="text-[10px] rounded px-1.5 py-0.5" style={{ background: BRAND.redSoft, color: BRAND.red }}>{t}</span>)}</div>
                      </>
                    )}
                  </div>
                  {c.siteAnalysis.interpretation && (
                    <div className="rounded-lg p-3" style={{ background: BRAND.primarySoft }}>
                      <p className="text-[10px] font-semibold mb-1" style={{ color: BRAND.primary }}>VERTEXRANK AI INTERPRETATION</p>
                      <p className="text-xs mb-2">{c.siteAnalysis.interpretation.summary}</p>
                      <div className="space-y-2">
                        {c.siteAnalysis.interpretation.gaps.map((g) => (
                          <div key={g.id} className="rounded p-2" style={{ background: BRAND.surface }}>
                            <div className="flex items-center justify-between gap-2 mb-1"><p className="text-xs font-medium">{g.gap}</p><PriorityBadge priority={g.priority} /></div>
                            <p className="text-[11px] mb-1.5" style={{ color: BRAND.inkSoft }}>{g.evidence}</p>
                            <div className="flex justify-end">
                              <Button size="sm" variant={isAdded(`${c.id}_${g.id}`) ? "outline" : "soft"} icon={isAdded(`${c.id}_${g.id}`) ? Check : ListPlus} disabled={isAdded(`${c.id}_${g.id}`)} onClick={() => addGapToActions(c, g)}>
                                {isAdded(`${c.id}_${g.id}`) ? "Added" : "Add to Action Center"}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                      {c.siteAnalysis.interpretation.aeoGeoDifferences?.length > 0 && (
                        <div className="space-y-2 mt-2">
                          <p className="text-[10px] font-semibold" style={{ color: BRAND.primary }}>AEO/GEO DIFFERENCES</p>
                          {c.siteAnalysis.interpretation.aeoGeoDifferences.map((d) => (
                            <div key={d.id} className="rounded p-2" style={{ background: BRAND.surface }}>
                              <div className="flex items-center justify-between gap-2 mb-1"><p className="text-xs font-medium">{d.difference}</p><PriorityBadge priority={d.priority} /></div>
                              <p className="text-[11px] mb-1.5" style={{ color: BRAND.inkSoft }}>{d.recommendedAction}</p>
                              <div className="flex justify-end">
                                <Button size="sm" variant={isAdded(`${c.id}_${d.id}`) ? "outline" : "soft"} icon={isAdded(`${c.id}_${d.id}`) ? Check : ListPlus} disabled={isAdded(`${c.id}_${d.id}`)} onClick={() => addAeoGeoDiffToActions(c, d)}>
                                  {isAdded(`${c.id}_${d.id}`) ? "Added" : "Add to Action Center"}
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {c.backlinkOpportunities && (
                    <div className="rounded-lg p-3" style={{ background: BRAND.visibilitySoft }}>
                      <p className="text-[10px] font-semibold mb-1" style={{ color: BRAND.visibility }}>AUTO-DISCOVERED BACKLINK PROSPECTS — from {c.name}'s crawl</p>
                      <p className="text-[10px] mb-2" style={{ color: BRAND.inkSoft }}>{c.backlinkOpportunities.disclaimer}</p>
                      {(c.backlinkOpportunities.opportunities || []).length === 0 ? (
                        <p className="text-xs" style={{ color: BRAND.inkSoft }}>No strong prospects surfaced from this crawl.</p>
                      ) : (
                        <div className="space-y-2">
                          {c.backlinkOpportunities.opportunities.map((o) => (
                            <div key={o.id} className="rounded p-2" style={{ background: BRAND.surface }}>
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <p className="text-xs font-medium">{o.host}</p>
                                <div className="flex items-center gap-1.5"><PriorityBadge priority={o.priority} /></div>
                              </div>
                              <p className="text-[11px] mb-1" style={{ color: BRAND.inkSoft }}>{o.whyRelevant}</p>
                              {o.suggestedApproach && <p className="text-[11px] mb-1.5" style={{ color: BRAND.inkSoft }}>Next step: {o.suggestedApproach}</p>}
                              <div className="flex justify-end">
                                <Button size="sm" variant={isBacklinkTracked(o.host) ? "outline" : "soft"} icon={isBacklinkTracked(o.host) ? Check : ListPlus} disabled={isBacklinkTracked(o.host)} onClick={() => addBacklinkToTracker(o)}>
                                  {isBacklinkTracked(o.host) ? "In tracker" : "Add to Backlink Radar"}
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {!c.siteAnalysis && c.analysis && expanded === c.id && (
                <div className="mt-3 space-y-3">
                  <div className="rounded-lg p-3" style={{ background: BRAND.canvas }}>
                    <p className="text-[10px] font-semibold mb-1" style={{ color: BRAND.inkSoft }}>OBSERVED COMPETITOR DATA (single page)</p>
                    <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                      <span>Word count: {c.analysis.observed.wordCount}</span>
                      <span>Headings: {c.analysis.observed.headingCount}</span>
                      <span>Schema: {c.analysis.observed.schemaTypes.join(", ") || "none"}</span>
                    </div>
                    {c.analysis.observed.competitorOnlyTopics.length > 0 && (
                      <>
                        <p className="text-xs font-medium mb-1">Topics they cover that we don't</p>
                        <div className="flex flex-wrap gap-1">{c.analysis.observed.competitorOnlyTopics.slice(0, 10).map((t) => <span key={t} className="text-[10px] rounded px-1.5 py-0.5" style={{ background: BRAND.redSoft, color: BRAND.red }}>{t}</span>)}</div>
                      </>
                    )}
                  </div>
                  {c.analysis.interpretation && (
                    <div className="rounded-lg p-3" style={{ background: BRAND.primarySoft }}>
                      <p className="text-[10px] font-semibold mb-1" style={{ color: BRAND.primary }}>VERTEXRANK AI INTERPRETATION</p>
                      <p className="text-xs mb-2">{c.analysis.interpretation.summary}</p>
                      <div className="space-y-2">
                        {c.analysis.interpretation.gaps.map((g) => (
                          <div key={g.id} className="rounded p-2" style={{ background: BRAND.surface }}>
                            <div className="flex items-center justify-between gap-2 mb-1"><p className="text-xs font-medium">{g.gap}</p><PriorityBadge priority={g.priority} /></div>
                            <p className="text-[11px] mb-1.5" style={{ color: BRAND.inkSoft }}>{g.evidence}</p>
                            <div className="flex justify-end">
                              <Button size="sm" variant={isAdded(`${c.id}_${g.id}`) ? "outline" : "soft"} icon={isAdded(`${c.id}_${g.id}`) ? Check : ListPlus} disabled={isAdded(`${c.id}_${g.id}`)} onClick={() => addGapToActions(c, g)}>
                                {isAdded(`${c.id}_${g.id}`) ? "Added" : "Add to Action Center"}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      <Modal open={!!modal} onClose={() => setModal(null)} title="Edit competitor"
        footer={<><Button variant="outline" onClick={() => setModal(null)}>Cancel</Button><Button onClick={save}>Save</Button></>}>
        <Field label="Name"><TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
        <Field label="Website"><TextInput placeholder="competitor.com" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} /></Field>
      </Modal>
      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Remove competitor" body="This competitor will no longer be tracked." onConfirm={() => del(confirmDelete.id)} />
    </div>
  );
}

/* ============================== Content Planner ============================== */

function ContentPlannerView() {
  const { bundle, setBundles, currentWebsiteId, toast } = useApp();
  const b = bundle();
  const [modal, setModal] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [generatingIdeas, setGeneratingIdeas] = useState(false);
  const blankForm = { title: "", primaryKeyword: "", secondaryKeywords: "", intent: "Informational", status: "Idea", questions: "", outline: "", aeoRecs: "", geoRecs: "" };
  const [form, setForm] = useState(blankForm);

  if (!currentWebsiteId) return <EmptyState icon={Globe2} title="Select a website" body="Choose a website from the top bar to plan content." />;

  function mutate(fn) {
    setBundles((prev) => {
      const site = prev[currentWebsiteId] || emptyBundle();
      return { ...prev, [currentWebsiteId]: { ...site, contentIdeas: fn(site.contentIdeas) } };
    });
  }
  function openEdit(c) {
    setForm({
      title: c.title, primaryKeyword: c.primaryKeyword, secondaryKeywords: (c.secondaryKeywords || []).join(", "),
      intent: c.intent, status: c.status, questions: (c.questions || []).join("\n"), outline: (c.outline || []).join("\n"),
      aeoRecs: c.aeoRecs || "", geoRecs: c.geoRecs || "",
    });
    setModal({ mode: "edit", c });
  }
  async function generateWithAi() {
    if (!form.title.trim()) { toast("Add a title first", "error"); return; }
    setGenerating(true);
    try {
      const data = await postJson("/api/content-plan", { title: form.title, primaryKeyword: form.primaryKeyword, intent: form.intent });
      const plan = data.plan;
      setForm((f) => ({
        ...f,
        secondaryKeywords: (plan.secondaryKeywords || []).join(", "),
        questions: (plan.questions || []).join("\n"),
        outline: (plan.outline || []).join("\n"),
        aeoRecs: plan.aeoRecs || "",
        geoRecs: plan.geoRecs || "",
      }));
      toast("Draft plan generated by VertexRank AI");
    } catch (err) {
      toast(err.message || "Couldn't generate a plan.", "error");
    } finally {
      setGenerating(false);
    }
  }
  function save() {
    if (!form.title.trim()) return;
    const payload = {
      title: form.title.trim(),
      primaryKeyword: form.primaryKeyword.trim(),
      secondaryKeywords: form.secondaryKeywords.split(",").map((k) => k.trim()).filter(Boolean),
      intent: form.intent,
      status: form.status,
      questions: form.questions.split("\n").map((q) => q.trim()).filter(Boolean),
      outline: form.outline.split("\n").map((o) => o.trim()).filter(Boolean),
      aeoRecs: form.aeoRecs.trim(),
      geoRecs: form.geoRecs.trim(),
    };
    mutate((arr) => arr.map((x) => (x.id === modal.c.id ? { ...x, ...payload } : x)));
    toast("Content idea updated");
    setModal(null);
  }
  function del(id) { mutate((arr) => arr.filter((x) => x.id !== id)); toast("Content idea deleted"); }

  // Generates complete content ideas end-to-end — title, keywords, outline,
  // and all — grounded in the real crawl and the gaps already found by
  // Keyword Intelligence, AEO, and GEO (site-wide versions preferred once
  // they've been run). This is the only way new ideas enter the planner now.
  async function generateIdeasWithAi() {
    let scanMeta = b.scanMeta;
    if (!scanMeta?.live) {
      const homepage = b.siteCrawl?.pages?.find((p) => p.url === b.siteCrawl.startUrl) || b.siteCrawl?.pages?.[0];
      if (homepage) scanMeta = { domain: b.siteCrawl.domain, title: homepage.title, metaDescription: homepage.metaDescription, h1Text: homepage.h1Text, fullText: homepage.fullText };
    }
    if (!scanMeta?.domain) { toast("Add a website first — a full-site crawl starts automatically and powers this.", "error"); return; }
    setGeneratingIdeas(true);
    try {
      const siteKw = b.siteKeywordClusters?.opportunities;
      const keywordOpportunities = siteKw?.length ? siteKw.map((o) => ({ problem: o.opportunity, evidence: o.evidence })) : (b.keywordIntel?.opportunities || []);
      const aeoQuestions = b.siteAeoAnalysis?.questions?.length ? b.siteAeoAnalysis.questions : (b.aeoAnalysis?.questions || []);
      const geoOpportunities = b.siteGeoAnalysis?.opportunities?.length ? b.siteGeoAnalysis.opportunities : (b.geoAnalysis?.opportunities || []);
      const data = await postJson("/api/content-ideas", { scanMeta, keywordOpportunities, aeoQuestions, geoOpportunities, count: 4 });
      const existing = new Set(b.contentIdeas.map((c) => c.title.toLowerCase()));
      const fresh = (data.result.ideas || []).filter((idea) => idea.title && !existing.has(idea.title.toLowerCase()));
      if (fresh.length === 0) { toast("No new AI-generated ideas this time — try again for different suggestions."); return; }
      mutate((arr) => [
        ...arr,
        ...fresh.map((idea) => ({
          id: uid("ci"), websiteId: currentWebsiteId, internalLinks: 0, status: "Idea",
          title: idea.title, primaryKeyword: idea.primaryKeyword, secondaryKeywords: idea.secondaryKeywords,
          intent: idea.intent, questions: idea.questions, outline: idea.outline, aeoRecs: idea.aeoRecs, geoRecs: idea.geoRecs,
          rationale: idea.rationale, source: idea.source,
        })),
      ]);
      toast(`Added ${fresh.length} AI-generated content idea${fresh.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast(err.message || "Couldn't generate content ideas.", "error");
    } finally {
      setGeneratingIdeas(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button variant="soft" icon={generatingIdeas ? Loader2 : Sparkles} disabled={generatingIdeas} onClick={generateIdeasWithAi}>{generatingIdeas ? "Generating…" : "Generate ideas with AI"}</Button>
      </div>
      {b.contentIdeas.length === 0 ? <Card><EmptyState icon={FileText} title="No content ideas yet" body="Let VertexRank AI generate complete ideas from the crawl and known gaps." action={<Button variant="soft" icon={Sparkles} onClick={generateIdeasWithAi}>Generate ideas with AI</Button>} /></Card> : (
        <div className="grid sm:grid-cols-2 gap-4">
          {b.contentIdeas.map((c) => (
            <Card key={c.id} className="p-4 cursor-pointer" onClick={() => setDrawer(c)}>
              <div className="flex items-start justify-between">
                <p className="font-semibold text-sm pr-2">{c.title}</p>
                <div className="flex gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <CopyButton iconOnly label="Copy this content idea" getText={() => formatContentIdea(c, "##")} />
                  <IconButton icon={Pencil} onClick={() => openEdit(c)} title="Edit" />
                  <IconButton icon={Trash2} danger onClick={() => setConfirmDelete(c)} title="Delete" />
                </div>
              </div>
              <p className="text-xs mt-1" style={{ color: BRAND.inkSoft }}>{c.primaryKeyword || "No primary keyword set"}</p>
              <div className="flex gap-2 mt-3">
                <Badge color={{ fg: BRAND.primary, bg: BRAND.primarySoft }}>{c.intent}</Badge>
                <Badge color={{ fg: BRAND.inkSoft, bg: BRAND.canvas }}>{c.status}</Badge>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)} title="Edit content idea" width={620}
        footer={<><Button variant="outline" onClick={() => setModal(null)}>Cancel</Button><Button onClick={save}>Save</Button></>}>
        <Field label="Title"><TextInput value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} /></Field>
        <Field label="Primary keyword"><TextInput value={form.primaryKeyword} onChange={(e) => setForm((f) => ({ ...f, primaryKeyword: e.target.value }))} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Search intent"><Select value={form.intent} onChange={(e) => setForm((f) => ({ ...f, intent: e.target.value }))}>{INTENTS.map((i) => <option key={i}>{i}</option>)}</Select></Field>
          <Field label="Status"><Select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>{["Idea", "Drafting", "Ready", "Published"].map((s) => <option key={s}>{s}</option>)}</Select></Field>
        </div>
        <div className="mb-3.5">
          <Button size="sm" variant="soft" icon={generating ? Loader2 : Wand2} onClick={generateWithAi} disabled={generating}>
            {generating ? "Generating…" : "Draft the rest with AI"}
          </Button>
          <p className="text-xs mt-1.5" style={{ color: BRAND.inkSoft }}>Fills in secondary keywords, questions, outline, and AEO/GEO notes below from the title, which you can edit before saving.</p>
        </div>
        <Field label="Secondary keywords (comma separated)"><TextInput value={form.secondaryKeywords} onChange={(e) => setForm((f) => ({ ...f, secondaryKeywords: e.target.value }))} /></Field>
        <Field label="Questions to answer (one per line)"><TextArea value={form.questions} onChange={(e) => setForm((f) => ({ ...f, questions: e.target.value }))} /></Field>
        <Field label="Outline (one section per line)"><TextArea value={form.outline} onChange={(e) => setForm((f) => ({ ...f, outline: e.target.value }))} /></Field>
        <Field label="AEO notes (optional)"><TextArea value={form.aeoRecs} onChange={(e) => setForm((f) => ({ ...f, aeoRecs: e.target.value }))} /></Field>
        <Field label="GEO notes (optional)"><TextArea value={form.geoRecs} onChange={(e) => setForm((f) => ({ ...f, geoRecs: e.target.value }))} /></Field>
      </Modal>

      <Modal open={!!drawer} onClose={() => setDrawer(null)} title={drawer?.title} width={640}>
        {drawer && (
          <div className="space-y-4">
            <div className="flex gap-2"><Badge color={{ fg: BRAND.primary, bg: BRAND.primarySoft }}>{drawer.intent}</Badge><Badge color={{ fg: BRAND.inkSoft, bg: BRAND.canvas }}>{drawer.status}</Badge></div>
            <div><p className="text-xs font-semibold mb-1" style={{ color: BRAND.inkSoft }}>Primary keyword</p><p className="text-sm">{drawer.primaryKeyword || "—"}</p></div>
            {drawer.secondaryKeywords?.length > 0 && <div><p className="text-xs font-semibold mb-1" style={{ color: BRAND.inkSoft }}>Secondary keywords</p><div className="flex flex-wrap gap-1.5">{drawer.secondaryKeywords.map((k) => <span key={k} className="text-xs rounded px-2 py-1" style={{ background: BRAND.canvas }}>{k}</span>)}</div></div>}
            {drawer.questions?.length > 0 && <div><p className="text-xs font-semibold mb-1" style={{ color: BRAND.inkSoft }}>Questions to answer</p><ul className="text-sm list-disc pl-4 space-y-0.5">{drawer.questions.map((q) => <li key={q}>{q}</li>)}</ul></div>}
            {drawer.outline?.length > 0 && <div><p className="text-xs font-semibold mb-1" style={{ color: BRAND.inkSoft }}>Outline</p><ol className="text-sm list-decimal pl-4 space-y-0.5">{drawer.outline.map((o) => <li key={o}>{o}</li>)}</ol></div>}
            {(drawer.aeoRecs || drawer.geoRecs) && (
              <div className="grid sm:grid-cols-2 gap-3">
                {drawer.aeoRecs && <div className="rounded-lg p-3" style={{ background: BRAND.visibilitySoft }}><p className="text-xs font-semibold mb-1" style={{ color: BRAND.visibility }}>AEO notes</p><p className="text-sm">{drawer.aeoRecs}</p></div>}
                {drawer.geoRecs && <div className="rounded-lg p-3" style={{ background: BRAND.primarySoft }}><p className="text-xs font-semibold mb-1" style={{ color: BRAND.primary }}>GEO notes</p><p className="text-sm">{drawer.geoRecs}</p></div>}
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete content idea" body="This content idea will be permanently removed." onConfirm={() => del(confirmDelete.id)} />
    </div>
  );
}

/* ============================== Internal Links ============================== */

function InternalLinksView() {
  const { bundle, setBundles, currentWebsiteId, toast } = useApp();
  const b = bundle();
  const [modal, setModal] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [form, setForm] = useState({ source: "", target: "", anchor: "", reason: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!currentWebsiteId) return <EmptyState icon={Globe2} title="Select a website" body="Choose a website from the top bar to see internal link opportunities." />;

  function mutate(fn) {
    setBundles((prev) => {
      const site = prev[currentWebsiteId] || emptyBundle();
      return { ...prev, [currentWebsiteId]: { ...site, internalLinks: fn(site.internalLinks) } };
    });
  }
  function openEdit(l) { setForm({ source: l.source, target: l.target, anchor: l.anchor, reason: l.reason }); setModal({ mode: "edit", l }); }
  function save() {
    if (!form.source.trim() || !form.target.trim()) return;
    mutate((arr) => arr.map((x) => (x.id === modal.l.id ? { ...x, ...form } : x)));
    toast("Link opportunity updated");
    setModal(null);
  }
  function apply(id) { mutate((arr) => arr.map((x) => (x.id === id ? { ...x, status: "Applied" } : x))); toast("Internal link applied"); }
  function del(id) { mutate((arr) => arr.filter((x) => x.id !== id)); toast("Link opportunity removed"); }

  // Automatic internal-link recommendations: targets orphan/weakly-linked
  // pages found by the full-site crawl and suggests which other crawled
  // pages should link to them, with natural anchor text.
  async function runAnalysis() {
    setLoading(true); setError("");
    try {
      const data = await postJson("/api/internal-linking", { crawl: b.siteCrawl });
      setBundles((prev) => {
        const site = prev[currentWebsiteId] || emptyBundle();
        return { ...prev, [currentWebsiteId]: { ...site, internalLinkRecs: data.result } };
      });
      if (data.warning) toast(data.warning);
      else toast("Internal-link recommendations ready");
    } catch (err) {
      setError(err.message || "Couldn't generate internal-link recommendations.");
      toast(err.message || "Couldn't generate internal-link recommendations.", "error");
    } finally {
      setLoading(false);
    }
  }
  function isTracked(fromUrl, targetUrl) { return b.internalLinks.some((x) => x.source === fromUrl && x.target === targetUrl); }
  function addRecToTracker(targetUrl, link) {
    mutate((arr) => [...arr, { id: uid("lnk"), websiteId: currentWebsiteId, status: "Suggested", source: link.fromUrl, target: targetUrl, anchor: link.anchorText, reason: link.reason }]);
    toast("Added to link opportunities");
  }

  const recs = b.internalLinkRecs;

  return (
    <div className="space-y-4">
      {!b.siteCrawl ? (
        <SiteCrawlGate body="Automatic internal-link recommendations target orphan and weakly-linked pages found across your whole site, then suggest which other pages should link to them. That needs a full-site crawl." />
      ) : !recs ? (
        <RunAnalysisPanel icon={Link2} title="Automatic internal-link recommendations"
          body={`Find orphan and weakly-linked pages across all ${b.siteCrawl.pagesCrawled} crawled pages, then suggest which related pages should link to them, with natural anchor text.`}
          buttonLabel="Generate recommendations" loadingLabel="Analyzing the link graph…" onRun={runAnalysis} loading={loading} error={error} />
      ) : (
        <Card className="p-4">
          <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
            <div>
              <h3 className="font-semibold vr-display">Automatic recommendations</h3>
              <p className="text-xs mt-0.5" style={{ color: BRAND.inkSoft }}>{recs.orphanPageCount} orphan · {recs.weakLinkedPageCount} weakly-linked page{recs.weakLinkedPageCount === 1 ? "" : "s"} found across {recs.pagesCrawled} pages{recs.targetsTruncated ? " (showing the first batch)" : ""}</p>
            </div>
            <Button size="sm" variant="soft" icon={loading ? Loader2 : RefreshCw} disabled={loading} onClick={runAnalysis}>{loading ? "Re-analyzing…" : "Re-analyze"}</Button>
          </div>
          {recs.note && <p className="text-xs mb-2" style={{ color: BRAND.inkSoft }}>{recs.note}</p>}
          {(recs.recommendations || []).length === 0 ? (
            <p className="text-sm" style={{ color: BRAND.inkSoft }}>No natural link recommendations this run.</p>
          ) : (
            <div className="space-y-3">
              {recs.recommendations.map((r) => (
                <div key={r.id} className="rounded-lg p-3.5" style={{ background: BRAND.canvas }}>
                  <p className="text-xs vr-mono font-medium mb-2">Target: {r.targetUrl}</p>
                  <div className="space-y-2">
                    {r.links.map((l) => (
                      <div key={l.id} className="rounded p-2 flex items-start justify-between gap-3" style={{ background: BRAND.surface }}>
                        <div className="min-w-0">
                          <p className="text-xs vr-mono truncate" style={{ color: BRAND.inkSoft }}>from {l.fromUrl}</p>
                          <p className="text-sm font-medium mt-0.5">"{l.anchorText}"</p>
                          <p className="text-xs mt-0.5" style={{ color: BRAND.inkSoft }}>{l.reason}</p>
                        </div>
                        <Button size="sm" variant={isTracked(l.fromUrl, r.targetUrl) ? "outline" : "soft"} icon={isTracked(l.fromUrl, r.targetUrl) ? Check : ListPlus} disabled={isTracked(l.fromUrl, r.targetUrl)} onClick={() => addRecToTracker(r.targetUrl, l)}>
                          {isTracked(l.fromUrl, r.targetUrl) ? "Added" : "Add"}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card className="overflow-hidden">
        {b.internalLinks.length === 0 ? <EmptyState icon={Link2} title="No link opportunities" body="Internal link suggestions connecting related pages will appear here." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr style={{ borderBottom: `1px solid ${BRAND.line}` }}>
                {["Source page", "Target page", "Suggested anchor", "Reason", "Status", ""].map((h) => <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: BRAND.inkSoft }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {b.internalLinks.map((l) => (
                  <tr key={l.id} className="vr-row" style={{ borderBottom: `1px solid ${BRAND.line}` }}>
                    <td className="px-4 py-2.5 vr-mono text-xs">{l.source}</td>
                    <td className="px-4 py-2.5 vr-mono text-xs">{l.target}</td>
                    <td className="px-4 py-2.5">{l.anchor}</td>
                    <td className="px-4 py-2.5 text-xs max-w-[220px]" style={{ color: BRAND.inkSoft }}>{l.reason}</td>
                    <td className="px-4 py-2.5"><StatusBadge status={l.status === "Applied" ? "Applied" : "New"} /></td>
                    <td className="px-4 py-2.5">
                      <div className="flex gap-0.5 justify-end">
                        {l.status !== "Applied" && <IconButton icon={Check} onClick={() => apply(l.id)} title="Apply" />}
                        <IconButton icon={Pencil} onClick={() => openEdit(l)} title="Edit" />
                        <IconButton icon={Trash2} danger onClick={() => setConfirmDelete(l)} title="Delete" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Modal open={!!modal} onClose={() => setModal(null)} title="Edit link opportunity"
        footer={<><Button variant="outline" onClick={() => setModal(null)}>Cancel</Button><Button onClick={save}>Save</Button></>}>
        <Field label="Source page"><TextInput placeholder="/blog/example" value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} /></Field>
        <Field label="Target page"><TextInput placeholder="/pricing" value={form.target} onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))} /></Field>
        <Field label="Suggested anchor text"><TextInput value={form.anchor} onChange={(e) => setForm((f) => ({ ...f, anchor: e.target.value }))} /></Field>
        <Field label="Reason"><TextArea value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} /></Field>
      </Modal>
      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete link opportunity" body="This suggestion will be permanently removed." onConfirm={() => del(confirmDelete.id)} />
    </div>
  );
}

/* ============================== Backlink Radar ============================== */

function BacklinksView() {
  const { bundle, setBundles, currentWebsiteId, toast } = useApp();
  const b = bundle();
  const [filter, setFilter] = useState("All");
  const [modal, setModal] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const blankForm = { name: "", type: BACKLINK_CATEGORIES[0], description: "", difficulty: "Easy", status: "Not started" };
  const [form, setForm] = useState(blankForm);
  const [discoverUrl, setDiscoverUrl] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState("");
  const [manualDiscovery, setManualDiscovery] = useState(null);

  if (!currentWebsiteId) return <EmptyState icon={Globe2} title="Select a website" body="Choose a website from the top bar to track backlink opportunities." />;

  function mutate(fn) {
    setBundles((prev) => {
      const site = prev[currentWebsiteId] || emptyBundle();
      return { ...prev, [currentWebsiteId]: { ...site, backlinks: fn(site.backlinks) } };
    });
  }
  function openEdit(o) { setForm({ name: o.name, type: o.type, description: o.description, difficulty: o.difficulty, status: o.status }); setModal({ mode: "edit", o }); }
  function save() {
    if (!form.name.trim()) return;
    mutate((arr) => arr.map((x) => (x.id === modal.o.id ? { ...x, ...form } : x)));
    toast("Backlink opportunity updated");
    setModal(null);
  }
  function setStatus(id, status) { mutate((arr) => arr.map((x) => (x.id === id ? { ...x, status } : x))); toast(`Status set to ${status}`); }
  function del(id) { mutate((arr) => arr.filter((x) => x.id !== id)); toast("Opportunity removed"); }
  function isTracked(host) { return b.backlinks.some((x) => x.name === host); }
  function addToTracker(o) {
    mutate((arr) => (arr.some((x) => x.name === o.host) ? arr : [{ id: uid("bl"), websiteId: currentWebsiteId, name: o.host, type: mapBacklinkDestinationType(o.destinationType), description: [o.whyRelevant, o.suggestedApproach].filter(Boolean).join(" "), difficulty: "Moderate", status: "Not started" }, ...arr]));
    toast(`${o.host} added to tracker`);
  }

  // Automatically discovered prospects — every competitor that's had a
  // site-wide analysis run already had its outbound links mined for
  // backlink prospects (see CompetitorsView's analyzeSiteWide). Aggregated
  // here, deduplicated by host, with no manual entry required to see them.
  const autoDiscovered = [];
  const seenHosts = new Set();
  for (const c of b.competitors) {
    for (const o of c.backlinkOpportunities?.opportunities || []) {
      if (seenHosts.has(o.host)) continue;
      seenHosts.add(o.host);
      autoDiscovered.push({ ...o, competitorName: c.name });
    }
  }

  async function discoverFromUrl() {
    if (!discoverUrl.trim()) return;
    setDiscovering(true); setDiscoverError(""); setManualDiscovery(null);
    try {
      const crawl = await postJson("/api/site-scan", { url: discoverUrl.trim(), maxPages: 25 });
      const bl = await postJson("/api/backlink-opportunities", { crawl, ourContext: b.scanMeta?.title ? `${b.scanMeta.domain} — ${b.scanMeta.title}` : (b.siteCrawl?.domain || "") });
      setManualDiscovery(bl.result);
      toast(`Found ${bl.result.candidateDomainsFound} candidate domain${bl.result.candidateDomainsFound === 1 ? "" : "s"} linked from ${crawl.domain}`);
    } catch (err) {
      setDiscoverError(err.message || "Couldn't discover opportunities from that site.");
    } finally {
      setDiscovering(false);
    }
  }

  const list = b.backlinks.filter((x) => filter === "All" || x.type === filter);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs" style={{ background: BRAND.primarySoft, color: BRAND.primary }}>
        <Info size={14} />
        Backlink opportunities are auto-discovered by mining the outbound links of any site-wide-analyzed competitor's crawl (Competitors tab) — sites already linking to a similar business are plausible prospects. No manual entry required. These are prospects to investigate, never confirmed or guaranteed links.
      </div>

      {autoDiscovered.length > 0 && (
        <Card className="p-4">
          <h3 className="font-semibold vr-display mb-1 flex items-center gap-2"><Sparkles size={16} style={{ color: BRAND.primary }} /> Auto-discovered from competitor crawls</h3>
          <p className="text-xs mb-3" style={{ color: BRAND.inkSoft }}>{autoDiscovered.length} prospect{autoDiscovered.length === 1 ? "" : "s"} found across your analyzed competitors.</p>
          <div className="grid sm:grid-cols-2 gap-3">
            {autoDiscovered.map((o) => (
              <div key={o.host} className="rounded-lg p-3" style={{ background: BRAND.canvas }}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <p className="text-sm font-medium">{o.host}</p>
                  <PriorityBadge priority={o.priority} />
                </div>
                <p className="text-[11px] mb-1" style={{ color: BRAND.inkSoft }}>{o.destinationType} · via {o.competitorName}</p>
                <p className="text-xs mb-1.5">{o.whyRelevant}</p>
                {o.suggestedApproach && <p className="text-xs mb-2" style={{ color: BRAND.inkSoft }}>Next step: {o.suggestedApproach}</p>}
                <div className="flex justify-end">
                  <Button size="sm" variant={isTracked(o.host) ? "outline" : "soft"} icon={isTracked(o.host) ? Check : ListPlus} disabled={isTracked(o.host)} onClick={() => addToTracker(o)}>
                    {isTracked(o.host) ? "In tracker" : "Add to tracker"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <h3 className="font-semibold vr-display mb-1">Discover from another site</h3>
        <p className="text-xs mb-3" style={{ color: BRAND.inkSoft }}>Optional: crawl any site in your space directly (not just a tracked competitor) and mine its outbound links for prospects.</p>
        <div className="flex gap-2 flex-wrap">
          <div className="flex-1 min-w-[200px]"><TextInput placeholder="site-in-your-space.com" value={discoverUrl} onChange={(e) => setDiscoverUrl(e.target.value)} /></div>
          <Button variant="soft" icon={discovering ? Loader2 : Search} disabled={discovering} onClick={discoverFromUrl}>{discovering ? "Discovering…" : "Discover"}</Button>
        </div>
        {discoverError && <p className="text-xs mt-2" style={{ color: BRAND.red }}>{discoverError}</p>}
        {manualDiscovery && (
          <div className="mt-3 space-y-2">
            <p className="text-[11px]" style={{ color: BRAND.inkSoft }}>{manualDiscovery.disclaimer}</p>
            {(manualDiscovery.opportunities || []).length === 0 ? (
              <p className="text-sm" style={{ color: BRAND.inkSoft }}>No strong prospects surfaced from this crawl.</p>
            ) : manualDiscovery.opportunities.map((o) => (
              <div key={o.id} className="rounded-lg p-3" style={{ background: BRAND.canvas }}>
                <div className="flex items-center justify-between gap-2 mb-1"><p className="text-sm font-medium">{o.host}</p><PriorityBadge priority={o.priority} /></div>
                <p className="text-xs mb-1.5">{o.whyRelevant}</p>
                <div className="flex justify-end">
                  <Button size="sm" variant={isTracked(o.host) ? "outline" : "soft"} icon={isTracked(o.host) ? Check : ListPlus} disabled={isTracked(o.host)} onClick={() => addToTracker(o)}>
                    {isTracked(o.host) ? "In tracker" : "Add to tracker"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="flex flex-wrap gap-2 items-center justify-between">
        <Select value={filter} onChange={(e) => setFilter(e.target.value)}><option>All</option>{BACKLINK_CATEGORIES.map((t) => <option key={t}>{t}</option>)}</Select>
      </div>
      {b.backlinks.length === 0 ? (
        <Card><EmptyState icon={Rss} title="No backlink opportunities tracked yet" body="Add prospects from the discovery tools above — auto-discovered from a competitor's crawl, or from any site you point Discover at." /></Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {list.map((o) => {
            const Icon = BACKLINK_ICONS[o.type] || Rss;
            return (
              <Card key={o.id} className="p-4 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="rounded-md p-1.5" style={{ background: BRAND.primarySoft }}><Icon size={14} style={{ color: BRAND.primary }} /></div>
                    <span className="text-xs font-medium" style={{ color: BRAND.inkSoft }}>{o.type}</span>
                  </div>
                  <div className="flex gap-0.5">
                    <IconButton icon={Pencil} onClick={() => openEdit(o)} title="Edit" />
                    <IconButton icon={Trash2} danger onClick={() => setConfirmDelete(o)} title="Remove" />
                  </div>
                </div>
                <p className="font-semibold text-sm">{o.name}</p>
                {o.description && <p className="text-xs" style={{ color: BRAND.inkSoft }}>{o.description}</p>}
                <div className="flex items-center justify-between mt-1">
                  <Badge color={o.difficulty === "Easy" ? { fg: BRAND.visibility, bg: BRAND.visibilitySoft } : o.difficulty === "Moderate" ? { fg: BRAND.amber, bg: BRAND.amberSoft } : { fg: BRAND.red, bg: BRAND.redSoft }}>{o.difficulty}</Badge>
                </div>
                <select value={o.status} onChange={(e) => setStatus(o.id, e.target.value)} className="vr-focus text-xs font-medium rounded-md px-2 py-1.5" style={inputStyle}>
                  {BACKLINK_STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </Card>
            );
          })}
        </div>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)} title="Edit backlink opportunity"
        footer={<><Button variant="outline" onClick={() => setModal(null)}>Cancel</Button><Button onClick={save}>Save</Button></>}>
        <Field label="Name"><TextInput placeholder="e.g. G2, a specific publication, a partner site" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
        <Field label="Type"><Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>{BACKLINK_CATEGORIES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
        <Field label="Notes (optional)"><TextArea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Difficulty"><Select value={form.difficulty} onChange={(e) => setForm((f) => ({ ...f, difficulty: e.target.value }))}>{BACKLINK_DIFFICULTIES.map((d) => <option key={d}>{d}</option>)}</Select></Field>
          <Field label="Status"><Select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>{BACKLINK_STATUSES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
        </div>
      </Modal>
      <ConfirmDialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Remove opportunity" body="This backlink opportunity will be permanently removed." onConfirm={() => del(confirmDelete.id)} />
    </div>
  );
}

/* ============================== App Root ============================== */

function VertexRankApp() {
  const seeded = useMemo(() => initialState(), []);
  const [websites, setWebsites] = useState(seeded.websites);
  const [bundles, setBundles] = useState(seeded.bundles);
  const [currentWebsiteId, setCurrentWebsiteId] = useState(seeded.websites[0]?.id || null);
  const [view, setView] = useState("dashboard");
  const [toasts, setToasts] = useState([]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Load any saved workspace from this browser once, after mount. Doing this
  // in an effect (rather than in useState's initializer) keeps the very
  // first server-rendered HTML and the first client render identical, which
  // avoids a React hydration mismatch — the saved data appears a moment
  // after the page paints instead.
  useEffect(() => {
    const saved = loadPersistedState();
    if (saved) {
      setWebsites(saved.websites);
      setBundles(saved.bundles);
      setCurrentWebsiteId(saved.currentWebsiteId);
    }
    setHydrated(true);
  }, []);

  // Save on every change, once we've hydrated — guarding on `hydrated` stops
  // the initial empty state from overwriting a real saved workspace before
  // the load above has had a chance to run.
  useEffect(() => {
    if (!hydrated) return;
    savePersistedState({ websites, bundles, currentWebsiteId });
  }, [websites, bundles, currentWebsiteId, hydrated]);

  function toast(message, type = "success") {
    const id = uid("toast");
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
  }
  function bundle() {
    return bundles[currentWebsiteId] || emptyBundle();
  }
  function addAction(a) {
    setBundles((prev) => {
      const site = prev[currentWebsiteId] || emptyBundle();
      if (!site) return prev;
      return { ...prev, [currentWebsiteId]: { ...site, actions: [{ id: uid("act"), websiteId: currentWebsiteId, createdAt: new Date().toISOString(), ...a }, ...site.actions] } };
    });
  }
  /** Keeps the per-website score shown on the Websites cards and the
   *  bundle-level score shown on the Dashboard dial in sync — Keyword/AEO/GEO
   *  analyses call this once they compute an explainable score. */
  function setScore(key, value) {
    setWebsites((ws) => ws.map((w) => (w.id === currentWebsiteId ? { ...w, scores: { ...w.scores, [key]: value } } : w)));
    setBundles((prev) => {
      const site = prev[currentWebsiteId] || emptyBundle();
      return { ...prev, [currentWebsiteId]: { ...site, scores: { ...site.scores, [key]: value } } };
    });
  }
  function clearAllData() {
    setWebsites([]);
    setBundles({});
    setCurrentWebsiteId(null);
    if (typeof window !== "undefined") {
      try { window.localStorage.removeItem(STORAGE_KEY); window.localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
    }
    toast("All saved data cleared");
  }

  const ctx = { websites, setWebsites, bundles, setBundles, bundle, currentWebsiteId, setCurrentWebsiteId, toast, toasts, addAction, setScore, clearAllData, view, setView };

  const views = {
    dashboard: Dashboard, scanner: ScannerView, audit: AuditView, actions: ActionCenter, keywords: KeywordsView,
    aeo: AeoView, geo: GeoView, competitors: CompetitorsView, content: ContentPlannerView, links: InternalLinksView, backlinks: BacklinksView,
  };
  const ViewComp = views[view] || Dashboard;

  return (
    <AppCtx.Provider value={ctx}>
      <GlobalStyle />
      <div className="vr-root flex min-h-screen w-full">
        <Sidebar view={view} setView={setView} />

        {mobileNavOpen && (
          <div className="fixed inset-0 z-40 md:hidden" style={{ background: "rgba(20,22,30,0.5)" }} onClick={() => setMobileNavOpen(false)}>
            <div className="w-60 h-full" style={{ background: BRAND.surface }} onClick={(e) => e.stopPropagation()}>
              <Sidebar view={view} setView={(v) => { setView(v); setMobileNavOpen(false); }} />
            </div>
          </div>
        )}

        <div className="flex-1 min-w-0 flex flex-col">
          <div className="md:hidden flex items-center gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${BRAND.line}`, background: BRAND.surface }}>
            <button onClick={() => setMobileNavOpen(true)} className="vr-focus rounded-md p-1.5" style={{ border: `1px solid ${BRAND.line}` }}>
              <SlidersHorizontal size={16} />
            </button>
            <span className="vr-display font-semibold">VertexRank</span>
          </div>
          <TopBar view={view} />
          <main className="flex-1 px-5 md:px-8 py-6 vr-fade-in">
            <ViewComp />
          </main>
        </div>
      </div>
      <Toasts />
    </AppCtx.Provider>
  );
}

/* ============================== crash recovery ==============================
 * A render error anywhere in the tree above would otherwise blank the whole
 * page with Next.js's generic "Application error" screen — with no way back
 * in, since the "Clear all data" control lives inside the very tree that
 * just crashed. This catches that, shows what actually broke (so it's
 * diagnosable without opening the browser console), and gives a guaranteed
 * way out: reload, or wipe saved data and reload. Uses only inline styles —
 * deliberately not dependent on GlobalStyle having successfully rendered. */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || "Something went wrong." };
  }
  componentDidCatch(error, info) {
    console.error("VertexRank crashed:", error, info);
  }
  handleClearAndReload = () => {
    try { window.localStorage.removeItem(STORAGE_KEY); window.localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
    window.location.reload();
  };
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: BRAND.canvas, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
        <div style={{ maxWidth: 440, textAlign: "center" }}>
          <div style={{ width: 44, height: 44, borderRadius: 999, background: BRAND.redSoft, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
            <AlertTriangle size={20} color={BRAND.red} />
          </div>
          <h1 style={{ fontSize: 17, fontWeight: 600, color: BRAND.ink, margin: "0 0 8px" }}>Something went wrong</h1>
          <p style={{ fontSize: 13, color: BRAND.inkSoft, margin: "0 0 4px", wordBreak: "break-word" }}>{this.state.message}</p>
          <p style={{ fontSize: 12, color: BRAND.inkSoft, margin: "8px 0 20px" }}>
            This can happen with saved data from an older version of the app. Clearing saved data usually fixes it — your live scan can always be re-run.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button onClick={() => window.location.reload()}
              style={{ borderRadius: 6, padding: "8px 16px", fontSize: 13, fontWeight: 500, border: `1px solid ${BRAND.line}`, background: "#fff", color: BRAND.ink, cursor: "pointer" }}>
              Reload
            </button>
            <button onClick={this.handleClearAndReload}
              style={{ borderRadius: 6, padding: "8px 16px", fontSize: 13, fontWeight: 500, border: "none", background: BRAND.primary, color: "#fff", cursor: "pointer" }}>
              Clear saved data &amp; reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default function VertexRank() {
  return (
    <ErrorBoundary>
      <VertexRankApp />
    </ErrorBoundary>
  );
}
