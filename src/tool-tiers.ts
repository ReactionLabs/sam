import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";

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
 * by name. Loads persist per chat in .sam/tool-loads.json, so a
 * tool loaded once stays loaded for that chat's session.
 *
 * Executing a deferred tool without loading it first returns a
 * stub naming the loader - the model can only reach a deferred
 * tool by hallucinating its name, and the stub teaches the path
 * instead of failing the turn. Below the threshold nothing
 * changes: the full set rides upfront and there is no loader.
 */

export const TOOL_TIER_THRESHOLD = 15;
export const UPFRONT_LIMIT = 14;
export const LOADER_TOOL_NAME = "sam_load_tools";

/** The own tools that are always upfront when tiering is active:
 *  the daily drivers (memory, workspace, notes, proposals). */
export const CORE_OWN_TOOLS = [
  "sam_memory_search",
  "sam_memory_list",
  "sam_workspace_list",
  "sam_workspace_read",
  "sam_save_note",
  "sam_propose_action",
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

export function notLoadedStubContent(name: string): string {
  return JSON.stringify({
    error: "Tool not loaded in this chat session - the call was not executed",
    note: "Call " + LOADER_TOOL_NAME + " with names [\"" + name + "\"] first; loaded tools stay loaded for this chat. Then call " + name + " again.",
  });
}

// --- per-chat loaded set, persisted at .sam/tool-loads.json ---

interface ToolLoadsFile { version: 1; chats: Record<string, string[]> }

function loadsPath(root: string): string {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  return join(dir, "tool-loads.json");
}

function readLoads(root: string): ToolLoadsFile {
  const path = loadsPath(root);
  if (!existsSync(path)) return { version: 1, chats: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ToolLoadsFile;
    if (parsed && typeof parsed === "object" && parsed.chats && typeof parsed.chats === "object") return { version: 1, chats: parsed.chats };
  } catch { /* corrupt state reads as empty, never fatal */ }
  return { version: 1, chats: {} };
}

export function loadedTools(root: string, chatId: string): string[] {
  const names = readLoads(root).chats[chatId];
  return Array.isArray(names) ? names.filter(n => typeof n === "string") : [];
}

export function recordToolLoad(root: string, chatId: string, requested: string[], validNames: Set<string>): { loaded: string[]; unknown: string[] } {
  const file = readLoads(root);
  const current = new Set(Array.isArray(file.chats[chatId]) ? file.chats[chatId] : []);
  const loaded: string[] = [];
  const unknown: string[] = [];
  for (const name of requested) {
    if (!validNames.has(name)) { unknown.push(name); continue; }
    if (!current.has(name)) { current.add(name); loaded.push(name); }
  }
  if (loaded.length) {
    file.chats[chatId] = [...current];
    const path = loadsPath(root);
    const temp = path + ".tmp";
    writeFileSync(temp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(temp, path);
  }
  return { loaded, unknown };
}
