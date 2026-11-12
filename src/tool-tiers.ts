import { existsSync, readFileSync, renameSync, mkdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";

/**
 * Deferred tool loading (Harness Implementation Order item 4, Dip
 * 2026-11-09, from the harness study: past ~15 tools, load in
 * tiers - the same progressive disclosure the skill catalog uses).
 *
 * A chat's callable set is its own tools plus its connector's
 * tools; a pinned connector pushes that past 15 easily (11 own +
 * 10 connector = 21), and every definition rides on every round of
 * every turn whether it is relevant or not. So when the total set
 * passes the threshold, the turn sends only an upfront tier - the
 * core own tools, whatever this chat session has already loaded,
 * then the remaining tools in order up to the upfront limit - plus
 * one meta-tool, sam_load_tools. The rest are named in a bounded
 * deferred catalog line in the system message (names + short
 * descriptions, never hidden), and the model loads what it needs
 * by name. Loads persist per chat in .sam/tool-loads.db, so a
 * tool loaded once stays loaded for that chat's session.
 *
 * Executing a deferred tool without loading it first returns a
 * stub naming the loader - the model can only reach a deferred
 * tool by hallucinating its name, and the stub teaches the path
 * instead of failing the turn. Below the threshold nothing
 * changes: the full set rides upfront and there is no loader.
 */

export const TOOL_TIER_THRESHOLD = 15;
export const UPFRONT_LIMIT = 16;
// 16, not 14: the core tier grew to 14 when sam_reach joined it
// (2026-11-10), and at 14 a connector chat's upfront set was ALL own
// tools - every MCP tool of the pinned connector started deferred,
// taxing the exact chats the connector exists for. The limit leaves
// headroom for the connector's first tools after the core rides.
export const LOADER_TOOL_NAME = "sam_load_tools";

/** The own tools that are always upfront when tiering is active:
 *  the daily drivers (memory, workspace, notes, proposals). */
export const CORE_OWN_TOOLS = [
  "sam_memory_search",
  "sam_memory_list",
  "sam_search_chats",
  "sam_workspace_list",
  "sam_workspace_read",
  "sam_save_note",
  "sam_react",
  "sam_read_skill",
  "sam_reach",
  "sam_patch_note",
  "sam_propose_action",
  "sam_author_skill",
  "sam_code",
  "sam_coding_task",
];

export const LOADER_TOOL_DEF: Record<string, unknown> = {
  type: "function",
  function: {
    name: LOADER_TOOL_NAME,
    description: "Load additional tools into this chat session by their exact names from the deferred tools list in your instructions. Loaded tools become callable from your next step onward and stay loaded for this chat. Load only what the task needs.",
    parameters: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"], additionalProperties: false },
  },
};

export function toolNameOf(def: Record<string, unknown>): string {
  const fn = (def as { function?: { name?: unknown } }).function;
  return typeof fn?.name === "string" ? fn.name : "";
}

function toolDescriptionOf(def: Record<string, unknown>): string {
  const fn = (def as { function?: { description?: unknown } }).function;
  return typeof fn?.description === "string" ? fn.description : "";
}

export interface ToolPartition {
  active: boolean;
  upfront: Array<Record<string, unknown>>;
  upfrontNames: Set<string>;
  deferred: Array<{ name: string; description: string }>;
}

export function partitionTools(all: Array<Record<string, unknown>>, loadedNames: Set<string>): ToolPartition {
  if (all.length <= TOOL_TIER_THRESHOLD) {
    return { active: false, upfront: all, upfrontNames: new Set(all.map(toolNameOf)), deferred: [] };
  }
  const byName = new Map(all.map(def => [toolNameOf(def), def] as const));
  const picked: Array<Record<string, unknown>> = [];
  const pick = (name: string) => {
    const def = byName.get(name);
    if (def && !picked.includes(def)) picked.push(def);
  };
  for (const name of CORE_OWN_TOOLS) pick(name);
  for (const name of loadedNames) pick(name);
  for (const def of all) { if (picked.length >= UPFRONT_LIMIT) break; if (!picked.includes(def)) picked.push(def); }
  const upfront = picked.slice(0, UPFRONT_LIMIT);
  const upfrontNames = new Set(upfront.map(toolNameOf));
  const deferred = all
    .filter(def => !upfrontNames.has(toolNameOf(def)))
    .map(def => ({ name: toolNameOf(def), description: toolDescriptionOf(def).slice(0, 90) }));
  return { active: true, upfront, upfrontNames, deferred };
}

/** The bounded system-message line naming what can be loaded -
 *  progressive disclosure, same shape as the skill catalog. */
export function deferredCatalogLine(deferred: Array<{ name: string; description: string }>): string {
  if (!deferred.length) return "";
  const entries = deferred.map(d => d.name + (d.description ? ": " + d.description : ""));
  return (" More tools are available in this chat but not loaded yet: " + entries.join("; ") + ". Call " + LOADER_TOOL_NAME + " with the exact names to load them for this chat session before using them.").slice(0, 1600);
}

/** Loader-loop guard (Turn honesty remainder, live evidence
 *  2026-11-10): a history-poisoned chat can spend every round
 *  calling sam_load_tools and never act - the turn then ended
 *  dressed as a step/budget failure (activity 15:59-16:10 UTC:
 *  three turns whose only calls were the loader). Loading is
 *  preparation, not progress. One loader-only round is
 *  legitimate; the guard nudges on the next step, and a second
 *  consecutive loader-only round stops the turn and reports it
 *  honestly as a loader loop, never as a budget failure. */
export const LOADER_LOOP_LIMIT = 2;

export function isLoaderOnlyRound(names: string[]): boolean {
  return names.length > 0 && names.every(n => n === LOADER_TOOL_NAME);
}

export function loaderLoopNudge(): string {
  return "Loader-loop guard: your last step only loaded tools and used none of them. On your next step, call one of the tools you loaded, or answer from what you already have. Do not call " + LOADER_TOOL_NAME + " again unless a different tool that is not already loaded is essential to the task.";
}

export function loaderLoopLedgerSummary(executed: string[]): string {
  return "Loader loop stopped: " + LOADER_LOOP_LIMIT + " consecutive loader-only rounds, " + executed.length + " calls used (" + (executed.join(", ") || "none") + "); no non-loader tool ran in those rounds";
}

export function loaderLoopFallbackAnswer(executed: string[]): string {
  return "I stopped this turn because I kept loading tools without using them (" + executed.length + " calls made" + (executed.length ? ": " + executed.join(", ") : "") + ") - loading tools is not progress, so this answer is incomplete and no check was finished. Ask me to continue and I will start by using the tools already loaded for this chat.";
}

export function notLoadedStubContent(name: string): string {
  return JSON.stringify({
    error: "Tool not loaded in this chat session - the call was not executed",
    note: "Call " + LOADER_TOOL_NAME + " with names [\"" + name + "\"] first; loaded tools stay loaded for this chat. Then call " + name + " again.",
  });
}

// --- per-chat loaded set, persisted at .sam/tool-loads.db ---

function loadsFile(root: string): string { return join(resolve(root), ".sam", "tool-loads.json"); }
function loadsDbFile(root: string): string { return join(resolve(root), ".sam", "tool-loads.db"); }
// State convergence (UNIFICATION item 4, ninth store): the
// per-chat loaded set is SQLite (.sam/tool-loads.db, the
// actions/jobs pattern), one keyed row per chat holding that
// chat's loaded-names JSON. The old tool-loads.json
// ({version, chats}) was rewritten whole on every
// recordToolLoad that loaded a new tool, and every process
// that runs a turn writes it (the dashboard/chat process,
// the Telegram bridge, the web door - own-tools and
// connector turns alike), so two turns in different
// processes holding the same snapshot silently lost the
// second one's load: a tool loaded in one chat could
// vanish, and that chat paid the loader round again next
// turn. Here each record is an upsert of exactly the one
// chat row it merges, and connections carry a busy_timeout
// (the F1 cross-process lock seam) so a writer waits out a
// peer's transaction instead of dying on "database is
// locked". First open imports a legacy tool-loads.json
// entry by entry and renames it tool-loads.json.migrated -
// imported, never deleted; a malformed file imports
// nothing and is left in place (the old reader read a
// corrupt file as empty, so the shape matches). A pure
// read on an install with neither file creates nothing -
// the old read path even created the .sam directory as a
// side effect; that is gone for reads, and a record that
// loads nothing new writes nothing and creates no store.
// The P9 backup snapshots every .sam/*.db generically, so
// the migrated store is carried with no backup change.
function openToolLoadsStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(loadsDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS tool_loads (chat_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyToolLoads(db, root);
  return db;
}
function migrateLegacyToolLoads(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM tool_loads").get() as { n: number };
  if (n > 0) return;
  const file = loadsFile(root);
  if (!existsSync(file)) return;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!parsed || typeof parsed !== "object") return;
  const chats = (parsed as { chats?: unknown }).chats;
  if (!chats || typeof chats !== "object" || Array.isArray(chats)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO tool_loads (chat_id, data) VALUES (?, ?)");
  const importAll = db.transaction((entries: Array<[string, unknown]>) => {
    for (const [chatId, names] of entries) {
      if (!chatId || !Array.isArray(names)) continue;
      insert.run(chatId, JSON.stringify(names.filter(n => typeof n === "string")));
    }
  });
  importAll(Object.entries(chats as Record<string, unknown>));
  renameSync(file, file + ".migrated");
}
function toolLoadsStoreExists(root: string): boolean {
  return existsSync(loadsDbFile(root)) || existsSync(loadsFile(root));
}
function parseLoadedNames(data: string): string[] {
  try {
    const value: unknown = JSON.parse(data);
    return Array.isArray(value) ? value.filter(n => typeof n === "string") as string[] : [];
  } catch { return []; }
}

export function loadedTools(root: string, chatId: string): string[] {
  if (!toolLoadsStoreExists(root)) return [];
  const db = openToolLoadsStore(root);
  try {
    const row = db.prepare("SELECT data FROM tool_loads WHERE chat_id = ?").get(chatId) as { data: string } | undefined;
    return row ? parseLoadedNames(row.data) : [];
  } finally { db.close(); }
}

export function recordToolLoad(root: string, chatId: string, requested: string[], validNames: Set<string>): { loaded: string[]; unknown: string[] } {
  const current = new Set(loadedTools(root, chatId));
  const loaded: string[] = [];
  const unknown: string[] = [];
  for (const name of requested) {
    if (!validNames.has(name)) { unknown.push(name); continue; }
    if (!current.has(name)) { current.add(name); loaded.push(name); }
  }
  if (loaded.length) {
    const db = openToolLoadsStore(root);
    try {
      db.prepare("INSERT INTO tool_loads (chat_id, data) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data")
        .run(chatId, JSON.stringify([...current]));
    } finally { db.close(); }
  }
  return { loaded, unknown };
}
