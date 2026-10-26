// Workspace backup: export everything VertexRank has saved (websites, crawls, analyses, actions...) to one JSON file
// and restore it later — on the same browser after clearing site data, or on another device. The data otherwise lives
// only in this browser's localStorage, so this file is the safety net.
//
// What is in a backup: your workspace data only. API keys and tokens are server-side environment variables and are
// never part of it. A backup contains crawled page text, so treat the file as private.
//
// Pure functions (no DOM, no React): unit-tested in tests/workspaceBackup.test.mjs. The same normalisation is used for
// data loaded from localStorage and for imported files, so a restored backup can't put the app in a state a normal
// load couldn't.

import { migrateLegacyBundle, normalizeSiteKey } from "./crawlState.js";

export const BACKUP_APP = "vertexrank";
export const BACKUP_FORMAT = 1;
export const MAX_BACKUP_BYTES = 60 * 1024 * 1024;
const MAX_WEBSITES = 100;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Turns any parsed workspace object (from localStorage or a backup file) into a safe { websites, bundles, currentWebsiteId }.
 * Every bundle is merged over a fresh emptyBundle() so a field added to the app after the data was saved falls back to a
 * safe default instead of `undefined`.
 */
export function normalizeWorkspace(parsed, { emptyBundle }) {
  if (!isObj(parsed)) return null;
  const websites = (Array.isArray(parsed.websites) ? parsed.websites : []).filter((w) => isObj(w) && w.id).slice(0, MAX_WEBSITES);
  const rawBundles = isObj(parsed.bundles) ? parsed.bundles : {};
  const bundles = {};
  for (const site of websites) {
    const b = rawBundles[site.id];
    const base = emptyBundle();
    bundles[site.id] = migrateLegacyBundle({
      ...base,
      ...(isObj(b) ? b : {}),
      scores: { ...base.scores, ...(isObj(b?.scores) ? b.scores : {}) },
      keywords: Array.isArray(b?.keywords) ? b.keywords : [],
      aeoQuestions: Array.isArray(b?.aeoQuestions) ? b.aeoQuestions : [],
      competitors: Array.isArray(b?.competitors) ? b.competitors : [],
      contentIdeas: Array.isArray(b?.contentIdeas) ? b.contentIdeas : [],
      internalLinks: Array.isArray(b?.internalLinks) ? b.internalLinks : [],
      backlinks: Array.isArray(b?.backlinks) ? b.backlinks : [],
      actions: Array.isArray(b?.actions) ? b.actions : [],
      contentRoadmap: Array.isArray(b?.contentRoadmap) ? b.contentRoadmap : null,
    });
  }
  const currentWebsiteId = websites.some((w) => w.id === parsed.currentWebsiteId) ? parsed.currentWebsiteId : (websites[0]?.id ?? null);
  return { websites, bundles, currentWebsiteId };
}

/** The backup file's content for the given workspace state. */
export function createBackup({ websites, bundles, currentWebsiteId }, now = new Date()) {
  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    exportedAt: now.toISOString(),
    websites: websites || [],
    bundles: bundles || {},
    currentWebsiteId: currentWebsiteId ?? null,
  };
}

export function backupFilename(now = new Date()) {
  return `vertexrank-backup-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * Validates and normalises the text of a backup file.
 * Returns { ok: true, state, meta } or { ok: false, error } with a message suitable for showing the user.
 */
export function parseBackupText(text, { emptyBundle }, { maxBytes = MAX_BACKUP_BYTES } = {}) {
  const raw = String(text ?? "");
  if (raw.length > maxBytes) return { ok: false, error: "That file is too large to be a VertexRank backup." };
  let parsed;
  try {
    // Same relabel the localStorage loader applies to data saved before the product was renamed.
    parsed = JSON.parse(raw.replace(/RankPilot AI/g, "VertexRank AI"));
  } catch {
    return { ok: false, error: "That file isn't valid JSON, so it can't be a VertexRank backup." };
  }
  if (!isObj(parsed) || parsed.app !== BACKUP_APP) return { ok: false, error: "That file isn't a VertexRank backup." };
  if (!Number.isInteger(parsed.format) || parsed.format < 1) return { ok: false, error: "This backup has no readable format version." };
  if (parsed.format > BACKUP_FORMAT) return { ok: false, error: "This backup was made by a newer version of VertexRank. Update the app first, then import it." };
  if (!Array.isArray(parsed.websites)) return { ok: false, error: "This backup doesn't contain a list of websites." };
  const state = normalizeWorkspace(parsed, { emptyBundle });
  const dropped = parsed.websites.length - state.websites.length;
  return {
    ok: true,
    state,
    meta: {
      exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : null,
      websites: state.websites.length,
      droppedWebsites: Math.max(0, dropped),
      pagesCrawled: Object.values(state.bundles).reduce((n, b) => n + (b?.siteCrawl?.pagesCrawled || 0), 0),
      actions: Object.values(state.bundles).reduce((n, b) => n + (b?.actions?.length || 0), 0),
    },
  };
}

/**
 * "Add what's missing" import: websites in `incoming` that aren't already here are added with their data; a website is skipped
 * when its id or its URL already exists (the existing one is never overwritten). The current selection is kept.
 */
export function mergeWorkspaces(current, incoming) {
  const websites = [...current.websites];
  const bundles = { ...current.bundles };
  const ids = new Set(websites.map((w) => w.id));
  const urls = new Set(websites.map((w) => normalizeSiteKey(w.url)));
  const added = []; const skipped = [];
  for (const w of incoming.websites) {
    if (ids.has(w.id)) { skipped.push({ url: w.url, reason: "already exists" }); continue; }
    if (urls.has(normalizeSiteKey(w.url))) { skipped.push({ url: w.url, reason: "a website with this URL already exists" }); continue; }
    websites.push(w);
    bundles[w.id] = incoming.bundles[w.id];
    ids.add(w.id); urls.add(normalizeSiteKey(w.url)); added.push(w.id);
  }
  return {
    websites, bundles,
    currentWebsiteId: current.currentWebsiteId ?? websites[0]?.id ?? null,
    added, skipped,
  };
}

/** "3 days ago" style text for the last-backup reminder. */
export function timeAgo(iso, now = new Date()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
