import { existsSync, readFileSync, renameSync, mkdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";

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
  "sam_spawn_subagent",
];

export const LOADER_TOOL_DEF: Record<string, unknown> = {
  type: "function",
  function: {
    name: LOADER_TOOL_NAME,
    description: "Load additional tools into this chat session by their exact names from the deferred tools list in your instructions. Loaded tools become callable from your next step onward and stay loaded for the whole chat - loading a tool that is already loaded is a no-op that changes nothing, so never load the same tool twice. Load only what the task needs, then use it.",
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
  // Loaded tools take the remaining window slots NEWEST FIRST: the
  // window carries UPFRONT_LIMIT defs and the core set alone fills
  // 15, so an oldest-first slice silently cut every load after the
  // first out of the window while the loader still acked it as
  // loaded - the call then died on the not-loaded gate (live
  // evidence 2026-11-14, acceptance B1: sam_orchestrate loaded,
  // acked, and refused four times). A windowed-out load stays in
  // the loaded set (the gate honors the set, not just the window)
  // and re-loading it rotates it back into the window.
  const loadedArr = [...loadedNames];
  const room = Math.max(0, UPFRONT_LIMIT - picked.length);
  for (const name of loadedArr.slice(Math.max(0, loadedArr.length - room))) pick(name);
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
  return (" More tools are available in this chat but not loaded yet: " + entries.join("; ") + ". Call " + LOADER_TOOL_NAME + " with the exact names to load them for this chat session before using them. Loads persist for the whole chat: a tool you loaded stays loaded, and loading it again is a no-op.").slice(0, 1600);
}

/** The model provider refuses a request carrying more than 50
 *  messages (openai-compatible.ts request validation). A long
 *  owner turn appends an assistant message plus one tool message
 *  per call, every round, so a working turn crosses 50 messages
 *  mid-flight and used to die with a raw "Invalid connector model
 *  request" (acceptance evidence 2026-11-14: the recorded
 *  tool-load-loop ask, re-run on the fixed build, worked for 17
 *  rounds and then died on exactly this). The turn now folds its
 *  OLDEST completed rounds out of the request history before each
 *  call: whole assistant+tool blocks only, so the history stays
 *  well-formed, the head (system + the owner's ask) and the newest
 *  round always stay, and everything folded remains in the chat
 *  transcript and the activity ledger - only the model's working
 *  window shrinks. */
export const REQUEST_MESSAGE_CAP = 44;

export function trimRoundBlocks(messages: Array<Record<string, unknown>>, cap = REQUEST_MESSAGE_CAP): number {
  if (messages.length <= cap) return 0;
  let head = 0;
  while (head < messages.length && messages[head].role !== "assistant") head++;
  // Group the tail into blocks: an assistant message plus the tool
  // messages that answer it (stray notes ride the following block).
  const blocks: Array<[number, number]> = [];
  let i = head;
  while (i < messages.length) {
    if (messages[i].role === "assistant") {
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") j++;
      blocks.push([i, j]);
      i = j;
    } else i++;
  }
  let dropped = 0;
  // Drop oldest blocks (never the last one) until under the cap.
  while (messages.length > cap && blocks.length > 1) {
    const [start, end] = blocks.shift()!;
    messages.splice(start, end - start);
    dropped++;
    const width = end - start;
    for (const b of blocks) { b[0] -= width; b[1] -= width; }
  }
  return dropped;
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
  // A finished statement, per the Lane F ending doctrine (Defect 1,
  // 2026-11-14): the turn stopped itself to avoid thrash, and what it
  // says so is complete in itself - no "answer is incomplete", no
  // "ask me to continue". The tools stay loaded for the chat, so the
  // owner's next message starts from them without any ceremony.
  return "I stopped this turn because I kept loading tools without using them (" + executed.length + " calls made" + (executed.length ? ": " + executed.join(", ") : "") + ") - loading tools is not progress, and repeating it would only burn the turn. The tools I loaded stay loaded for this chat, so your next message picks up with them ready; nothing needs re-loading.";
}

/** The acknowledgement a repeat load returns (Defect 1): a loader call
 *  whose every valid name is already loaded for this chat is a no-op -
 *  it spends no budget, executes nothing, and says plainly that the
 *  tools are already there to be called. */
export function alreadyLoadedAck(already: string[], unknown: string[]): Record<string, unknown> {
  return {
    status: "already-loaded",
    alreadyAvailable: already,
    unknown,
    note: "These tools are already loaded for this chat and stay loaded - loading them again does nothing. Call the tool itself on your next step.",
  };
}

/** Preparation-loop guard (Defect 1 generalization, 2026-11-14): the
 *  recorded loop interleaved sam_orchestrate calls that created no
 *  lanes between the loads, which kept resetting the loader-only
 *  streak while the turn still made no progress. A round is
 *  preparation-only when every call it executed was preparation: a
 *  tool load, or a hire call (sam_orchestrate / sam_spawn_subagent)
 *  whose result is marked noProgress because it created nothing. */
export const PREPARATION_CALLS: ReadonlySet<string> = new Set([LOADER_TOOL_NAME, "sam_orchestrate", "sam_spawn_subagent"]);

export function isPreparationOnlyRound(roundCalls: string[], roundProgress: boolean): boolean {
  return roundCalls.length > 0 && !roundProgress && roundCalls.every(n => PREPARATION_CALLS.has(n));
}

export function prepLoopLedgerSummary(executed: string[], pureLoader: boolean): string {
  if (pureLoader) return loaderLoopLedgerSummary(executed);
  return "Preparation loop stopped: " + LOADER_LOOP_LIMIT + " consecutive preparation-only rounds, " + executed.length + " calls used (" + (executed.join(", ") || "none") + "); loads and hire calls that created nothing are preparation, not progress";
}

export function prepLoopSteer(): string {
  return "Preparation-loop guard: you have spent two steps in a row on preparation - loading tools, or hire calls that created nothing - without using a single loaded tool. Preparation is not progress. The loader is now OFF for the rest of this turn. On your next step, call one of the tools already loaded for this chat and do the work, or answer from what you already have.";
}

// The loader-loop scorecard (2026-11-18, the measured-proof
// series): the loader-loop guard and its preparation-loop
// generalization ledger every stopped turn - kind
// "loader-loop" for a pure loader trip, "preparation-loop"
// for the generalized one, the steered variant carrying the
// same base summary plus its suffix - but no daily surface
// ever counted the stops, so a chat that started looping on
// preparation again was invisible until the owner watched a
// turn die. This text folds both kinds' lines to counts
// only: the total, counts per fixed kind (loader /
// preparation, an unmatched shape "other"), and the summed
// calls the stopped turns spent. A summary matching neither
// fixed shape counts as a stop and contributes no calls,
// and is never printed. No stamp, no actor, no tool name,
// no verbatim summary enters the text, so a day no turn is
// stopped is byte-identical and P3-silent, and the first
// new stopped turn is the news. A pure read: it creates
// nothing, spends no model call, and retries nothing - the
// ledger and the guard seam are untouched.
export type LoaderLoopKind = "loader" | "preparation";
export function parseLoaderLoopSummary(summary: string): { kind: LoaderLoopKind; calls: number } | null {
  const loader = /^Loader loop stopped: \d+ consecutive loader-only rounds, (\d+) calls used/.exec(summary);
  if (loader) return { kind: "loader", calls: Number(loader[1]) };
  const prep = /^Preparation loop stopped: \d+ consecutive preparation-only rounds, (\d+) calls used/.exec(summary);
  if (prep) return { kind: "preparation", calls: Number(prep[1]) };
  return null;
}
export function loaderLoopScorecardText(root: string): string {
  const lines = [
    ...readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "loader-loop" }),
    ...readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "preparation-loop" }),
  ];
  const kinds = new Map<string, number>();
  let calls = 0;
  for (const line of lines) {
    const parsed = parseLoaderLoopSummary(line.summary);
    const kind = parsed ? parsed.kind : "other";
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    if (parsed) calls += parsed.calls;
  }
  const byKind = [...kinds.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const out: string[] = [];
  out.push("Loader loops: " + (lines.length > 0 ? "attention" : "clear"));
  out.push("Stopped turns: " + String(lines.length));
  out.push("By kind: " + (byKind.length ? byKind.map(([kind, n]) => kind + " " + String(n)).join(", ") : "none"));
  out.push("Calls used: " + String(calls));
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never retries a turn or prints a tool name; a new stopped turn is the news");
  return out.join("\n");
}

export function loaderDisabledStubContent(): string {
  return JSON.stringify({
    error: "Tool loading is off for the rest of this turn (preparation-loop guard) - the call was not executed",
    note: "The tools already loaded for this chat stay loaded. Call one of them, or answer from what you have.",
  });
}

/** Mid-turn owner steering (Defect 2): the note the loop appends when
 *  the owner's burst arrives at a tool-round boundary. The latest
 *  message governs; the earlier text stays as context. */
export function steerSystemNote(count: number): string {
  return "The owner sent " + (count === 1 ? "a new message" : count + " new messages") + " while you were working (they follow as user messages). The LATEST instruction governs: apply any correction, drop anything the owner neverminded, keep everything else moving, and do not restart work that is still valid.";
}

export function stopSystemNote(): string {
  return "The owner said stop. Do not start anything new. Close this turn now: say plainly what was done, what was not done, and what is still queued or running, in a few lines.";
}

export function stopFallbackAnswer(executed: string[]): string {
  return "Stopped, as asked. Work done so far this turn: " + (executed.length ? executed.join(", ") : "nothing had run yet") + ". Nothing else was started.";
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
// Tool-loads store failure visibility (gap found 2026-11-16,
// hourly run 01:04): the store above is the per-chat loaded
// set every tiered turn rides - loadedTools feeds the current
// loaded set on both chat loops (own-tools and
// connector-chat), recordToolLoad persists a fresh load, and
// touchToolLoads rotates a re-load back into the window -
// and every touch opened it raw. A dead tool-loads.db threw
// into whichever catch wrapped the turn with the seam
// unnamed, and no tool-loads-store-failed kind existed, so
// the class was uncountable, and any reader folding a dead
// store as "no loads" would silently unload every tool a
// chat already loaded dressed as a fresh session - the
// model pays loader rounds again and windowed tools fall
// out, with no trace it happened. Now the store's touches
// own their failure (the skill-authors precedent, helpers
// in this module): a failed touch ledgers ONE
// tool-loads-store-failed line (phase read for loadedTools,
// write for the touchToolLoads / recordToolLoad mutations;
// actor sam; the verbatim reason collapsed and capped;
// never any loaded-set record - chat ids and tool names
// are session data, not failure data), tags the error, and
// rethrows exactly, so every caller's handling is unchanged
// and reads still fail closed. A touch already ledgered by
// an inner door keeps its one line and gains no second
// (recordToolLoad's and touchToolLoads' current-set reads
// ride loadedTools). The exists check stays outside the
// seam: an absent store still reads as no loads with no
// line and creates nothing, and torn row payloads still
// parse forgiving - only the store touch is guarded.
export type ToolLoadsStorePhase = "read" | "write";

export function toolLoadsStoreFailureSummary(phase: ToolLoadsStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Tool loads store " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a tool-loads-store-failed line carries (census sprint
 * 2026-11-17): recordToolLoadsStoreFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function toolLoadsStoreFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordToolLoadsStoreFailure(root: string, phase: ToolLoadsStorePhase, error: unknown): void {
  const reason = toolLoadsStoreFailureReason(error);
  recordActivity(root, "sam", "tool-loads-store-failed", toolLoadsStoreFailureSummary(phase, reason));
}

function tagToolLoadsStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { toolLoadsStoreLedgered?: boolean }).toolLoadsStoreLedgered = true;
  }
}

export function isToolLoadsStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { toolLoadsStoreLedgered?: boolean }).toolLoadsStoreLedgered === true;
}

function failToolLoadsStore(root: string, phase: ToolLoadsStorePhase, error: unknown): never {
  if (!isToolLoadsStoreLedgered(error)) recordToolLoadsStoreFailure(root, phase, error);
  tagToolLoadsStoreLedgered(error);
  throw error;
}

function openToolLoadsGuarded(root: string, phase: ToolLoadsStorePhase): Database.Database {
  try { return openToolLoadsStore(root); }
  catch (error) { failToolLoadsStore(root, phase, error); }
}
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
  const db = openToolLoadsGuarded(root, "read");
  try {
    const row = db.prepare("SELECT data FROM tool_loads WHERE chat_id = ?").get(chatId) as { data: string } | undefined;
    return row ? parseLoadedNames(row.data) : [];
  } catch (error) { failToolLoadsStore(root, "read", error); }
  finally { db.close(); }
}

/** Rotate already-loaded names to the newest end of the stored
 *  load order, so a re-load brings a windowed-out tool back into
 *  the request window (see partitionTools). Order-only rewrite;
 *  the set itself never changes here. */
export function touchToolLoads(root: string, chatId: string, names: string[]): void {
  if (!names.length || !toolLoadsStoreExists(root)) return;
  const current = loadedTools(root, chatId);
  if (!current.length) return;
  const wanted = names.filter(n => current.includes(n));
  if (!wanted.length) return;
  const next = [...current.filter(n => !wanted.includes(n)), ...wanted];
  if (next.every((n, i) => n === current[i])) return;
  const db = openToolLoadsGuarded(root, "write");
  try {
    db.prepare("INSERT INTO tool_loads (chat_id, data) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data")
      .run(chatId, JSON.stringify(next));
  } catch (error) { failToolLoadsStore(root, "write", error); }
  finally { db.close(); }
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
    const db = openToolLoadsGuarded(root, "write");
    try {
      db.prepare("INSERT INTO tool_loads (chat_id, data) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data")
        .run(chatId, JSON.stringify([...current]));
    } catch (error) { failToolLoadsStore(root, "write", error); }
    finally { db.close(); }
  }
  return { loaded, unknown };
}
