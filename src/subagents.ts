import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { AgentLoopJournal } from "./agent-loop-journal.js";
import { executeOwnToolAsync, OWN_TOOLS, ownToolsChat } from "./own-tools.js";
import { LOADER_TOOL_DEF, LOADER_TOOL_NAME, partitionTools, toolNameOf } from "./tool-tiers.js";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./telegram.js";
import { ChatStore } from "./chats.js";
import { connectors, connectorCredentialPresent } from "./connectors.js";
import { turnRoutes } from "./failover.js";
import { readProviderKey } from "./providers.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { OWNER_CHAT_BUDGET, OWNER_CHAT_CEILING } from "./budgets.js";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";

// Sub-agents (item 10, F3). During a normal chat turn SAM can start an
// invisible helper (research, a build step, a review) and keep talking.
// The helper inherits the parent's tools or a narrower list, spends a
// carved budget, and stays under the depth and concurrency caps. The
// owner sees at most "Working on it." and then the folded answer.
// Helper text is ledgered, not chatted. A consequential proposal still
// waits on the approval card. The run is an AgentLoopJournal loop, so
// a restart can still see the checkpoint and fences an orphaned run as
// interrupted instead of replaying its tools.
//
// F3: a child used to take the connector model request even when the
// workspace had no connector. That request dies at 20 tools (a profile
// inherits more than that) and it is the wrong door for a fresh
// workspace. A child runs on the plain chat path (ownToolsChat) when
// no connector is pinned. A pin that names a connector this workspace
// actually holds still uses the connector request.

export const SUBAGENT_MAX_DEPTH = 2;
export const SUBAGENT_MAX_CONCURRENT = 2;
export const PARENT_POOL = { rounds: 6, maxCalls: 16 };

// --- Turn-scoped spawn pool (Defect 3, Dip live catch 2026-11-14) ---
// The pool a hire carves from used to be a LIFETIME ledger: carveBudget
// summed every sub-agent a profile had ever spawned (done, failed, and
// interrupted included) against the background-sized PARENT_POOL, so a
// profile that had ever hired {6, 16} of workers could never hire again
// ("0 rounds, 1 calls left" on every plan, forever). Lane F had already
// raised OWNER turns to 30 rounds / 120 calls with tranche continuation
// to 60/300, but the carve never got the owner sizing. The pool is now
// scoped to the hiring context, the same shape as the turn budgets in
// budgets.ts:
//   - an owner chat turn hires from a pool the size of its own tranche
//     budget ({30, 120}), refilled when the turn crosses into its next
//     tranche, with cumulative carves across the whole turn capped by
//     the turn's ceiling ({60, 300});
//   - background, heartbeat, scoped, CLI, and child contexts hire from
//     the small pool ({6, 16}) per invocation;
//   - inside one scope, done and failed carves still count (a worker's
//     budget is spent whether it landed or not) and a cancelled carve
//     still frees (the coordinator's retire-and-replace path);
//   - with no context at all (older callers, tests), counting falls
//     back to the newest scope the profile has carved in, so the books
//     a job leaves behind still read correctly after it closes.
export interface SpawnPoolContext {
  /** Turn key for owner contexts; the fixed scope id otherwise. */
  turnKey: string;
  /** Current tranche (owner contexts); the loops advance it as the
   *  turn crosses its own budget tranches, and the hire doors may
   *  advance it once to satisfy a worthwhile plan (Lane F continuation). */
  tranche: number;
  pool: SubagentBudget;
  ceiling: SubagentBudget | null;
  owner: boolean;
}
const spawnPoolStorage = new AsyncLocalStorage<SpawnPoolContext>();
let ambientScope: string | null = null;
function ambientScopeId(): string {
  if (!ambientScope) ambientScope = "ambient:" + randomUUID();
  return ambientScope;
}
export function ownerSpawnPool(turnKey: string): SpawnPoolContext {
  return { turnKey, tranche: 0, pool: { ...OWNER_CHAT_BUDGET }, ceiling: { ...OWNER_CHAT_CEILING }, owner: true };
}
export function smallSpawnPool(scope: string): SpawnPoolContext {
  return { turnKey: scope, tranche: 0, pool: { ...PARENT_POOL }, ceiling: null, owner: false };
}
export function currentSpawnPool(): SpawnPoolContext | null {
  return spawnPoolStorage.getStore() ?? null;
}
export function withSpawnPool<T>(ctx: SpawnPoolContext, fn: () => T): T {
  return spawnPoolStorage.run(ctx, fn);
}
/** The effective carve scope a context counts against right now. */
export function spawnScopeOf(ctx: SpawnPoolContext): string {
  return ctx.owner ? ctx.turnKey + "#t" + ctx.tranche : ctx.turnKey;
}
/** Advance an owner context into its next tranche (a fresh pool the
 *  same size as the turn's own next tranche). Bounded: a plan that
 *  fits no tranche is refused honestly instead of looping. */
export function advanceSpawnPoolTranche(ctx: SpawnPoolContext): boolean {
  if (!ctx.owner || ctx.tranche >= 8) return false;
  ctx.tranche++;
  return true;
}
/** A pool refusal carries its numbers as data: the hire doors turn it
 *  into a value result (never a dead-end error) and the preparation-loop
 *  guard reads the same mark. */
export class SpawnPoolError extends Error {
  readonly poolRefusal = true;
  constructor(message: string, readonly remaining: SubagentBudget, readonly asks: SubagentBudget, readonly ceilingHit = false) {
    super(message);
    this.name = "SpawnPoolError";
  }
}
export function isPoolRefusal(error: unknown): error is SpawnPoolError {
  return error instanceof SpawnPoolError;
}
/** Carves charged inside one scope (or, context-free, inside the
 *  newest scope the profile has carved in; unstamped legacy records
 *  count only when no stamped scope exists for the profile yet). */
function scopeUsed(items: Subagent[], profile: string, ctx: SpawnPoolContext | null): { used: SubagentBudget; scope: string } {
  const mine = items.filter(s => s.profile === profile);
  const hasStamped = mine.some(s => s.poolScope);
  let scope: string;
  if (ctx) scope = spawnScopeOf(ctx);
  else if (hasStamped) scope = mine.filter(s => s.poolScope).slice(-1)[0].poolScope as string;
  else scope = ambientScopeId();
  const inScope = (s: Subagent): boolean => {
    if (ctx || hasStamped) return s.poolScope === scope;
    return s.poolScope === scope || !s.poolScope; // ambient era: this process's carves plus legacy unstamped records
  };
  const used = mine
    .filter(s => s.status !== "cancelled" && inScope(s))
    .reduce((sum, s) => ({ rounds: sum.rounds + s.budget.rounds, maxCalls: sum.maxCalls + s.budget.maxCalls }), { rounds: 0, maxCalls: 0 });
  return { used, scope };
}
/** The pool the current context (or the fallback scope) has left. */
export function spawnPoolRemaining(items: Subagent[], profile: string, ctx?: SpawnPoolContext | null): SubagentBudget & { scope: string } {
  const resolved = ctx === undefined ? currentSpawnPool() : ctx;
  const pool = resolved?.pool ?? PARENT_POOL;
  const { used, scope } = scopeUsed(items, profile, resolved);
  return { rounds: Math.max(0, pool.rounds - used.rounds), maxCalls: Math.max(0, pool.maxCalls - used.maxCalls), scope };
}

export interface SubagentBudget { rounds: number; maxCalls: number }
export interface Subagent {
  id: string;
  profile: string;
  parentId: string | null;
  depth: number;
  prompt: string;
  tools: string[];
  budget: SubagentBudget;
  status: "running" | "done" | "failed" | "cancelled" | "interrupted";
  result: string | null;
  loopId: string | null;
  createdAt: string;
  finishedAt: string | null;
  chatId: string | null;
  role: "research" | "build" | "review" | "task";
  quiet: boolean;
  /** The spawn-pool scope this worker's budget was carved from
   *  (Defect 3): pool accounting counts carves per scope, never as a
   *  lifetime ledger. Absent on records written before the change. */
  poolScope?: string;
  /** The hiring turn's key (owner scopes): cumulative carves across
   *  the turn's tranches are capped by the turn ceiling. */
  poolTurn?: string;
}

export interface SubagentTurn { content: string | null; calls: Array<{ id: string; name: string; args: Record<string, unknown> }> }
export type SubagentCompleter = (model: string, messages: Array<Record<string, unknown>>, tools: Array<Record<string, unknown>>) => Promise<SubagentTurn>;

const live = new Set<string>();
const inflight = new Map<string, Promise<Subagent>>();
const parentSlot = new AsyncLocalStorage<string>();

/** The sub-agent whose tool call is running, so a helper it spawns is a child, not a sibling. */
export function currentParentId(): string | null {
  return parentSlot.getStore() ?? null;
}

export const ROLE_TOOLS: Record<"research" | "build" | "review", string[]> = {
  research: ["sam_memory_search", "sam_memory_list", "sam_workspace_list", "sam_workspace_read", "sam_reach"],
  build: ["sam_workspace_list", "sam_workspace_read", "sam_code", "sam_memory_list"],
  review: ["sam_workspace_read", "sam_memory_list"],
};

export function defaultRoleTools(role: "research" | "build" | "review", inherited: string[]): string[] {
  return ROLE_TOOLS[role].filter(name => inherited.includes(name));
}

function file(root: string): string { return join(resolve(root), ".sam", "subagents.json"); }
function registryDbFile(root: string): string { return join(resolve(root), ".sam", "subagent-registry.db"); }
function journalPath(root: string): string { return join(resolve(root), ".sam", "subagents.db"); }

export function profileToolNames(): string[] {
  return OWN_TOOLS.map(toolNameOf).filter(name => name.length > 0);
}

// State convergence (UNIFICATION item 4, thirty-third store): the
// sub-agent registry is SQLite (.sam/subagent-registry.db - a NEW
// file, because .sam/subagents.db is already the AgentLoopJournal's
// database and the two stores must never share a file - the coding
// pattern otherwise: better-sqlite3, WAL, busy_timeout 5000, one
// row per sub-agent holding the record's full JSON, rowid order =
// the old file order). The old subagents.json was rewritten whole
// on every spawn, every finish, and every orphan sweep, and three
// turn-running processes write this store (dashboard/chat, the
// Telegram bridge, the CLI), so two writers holding the same
// snapshot silently lost the second one's record: a cancelled
// helper could resurrect as running, a finished helper's result
// could revert, and a lost record freed the parent-pool budget it
// had carved. Here each mutation is a single-row INSERT or
// UPDATE. First open imports a legacy subagents.json in file
// order and renames it subagents.json.migrated - imported, never
// deleted; a malformed file or a non-array payload imports
// nothing and is left in place (reading as no helpers, exactly
// the old forgiving contract). A pure read on an install with
// neither file creates nothing. The P9 backup snapshots every
// .sam/*.db generically, so the migrated store is carried with
// no backup change.
// Subagents store failure visibility (gap found 2026-11-16,
// hourly run 02:04): the store above is the sub-agent registry
// every hire door rides - read feeds listSubagents (dashboard
// status, CLI overview, the run inspector, orchestration, and
// the orphan sweep), readOne feeds get/cancel/update, and put
// persists every spawn, finish, cancel, and orphan fencing -
// and every touch opened it raw. A dead subagent-registry.db
// threw into whichever catch wrapped the caller with the seam
// unnamed, and no subagents-store-failed kind existed, so the
// class was uncountable, and any reader folding a dead store
// as "no helpers" would silently empty the registry dressed
// as an idle install - running helpers vanish, their carved
// spawn-pool budget reads as unspent so the pool can be
// double-carved, and finished results revert to nothing.
// Now the store's touches own their failure (the tool-loads
// precedent, helpers in this module): a failed touch ledgers
// ONE subagents-store-failed line (phase read for read /
// readOne, write for put; actor sam; the verbatim reason
// collapsed and capped; never any sub-agent record - prompts,
// results, and tool lists are the helper's data, not failure
// data), tags the error, and rethrows exactly, so every
// caller's handling is unchanged and reads still fail closed.
// A touch already ledgered by an inner door keeps its one
// line and gains no second (updateSubagent rides readOne
// then put; the orphan sweep rides read then put;
// getSubagent rides listSubagents). The exists check stays
// outside the seam: an absent store still reads as no
// helpers with no line and creates nothing, torn row
// payloads still parse forgiving, and a malformed legacy
// file still imports nothing - only the store touch is
// guarded.
export type SubagentsStorePhase = "read" | "write";

export function subagentsStoreFailureSummary(phase: SubagentsStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Subagents store " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a subagents-store-failed line carries (census sprint
 * 2026-11-17): recordSubagentsStoreFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function subagentsStoreFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordSubagentsStoreFailure(root: string, phase: SubagentsStorePhase, error: unknown): void {
  const reason = subagentsStoreFailureReason(error);
  recordActivity(root, "sam", "subagents-store-failed", subagentsStoreFailureSummary(phase, reason));
}

function tagSubagentsStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { subagentsStoreLedgered?: boolean }).subagentsStoreLedgered = true;
  }
}

export function isSubagentsStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { subagentsStoreLedgered?: boolean }).subagentsStoreLedgered === true;
}

function failSubagentsStore(root: string, phase: SubagentsStorePhase, error: unknown): never {
  if (!isSubagentsStoreLedgered(error)) recordSubagentsStoreFailure(root, phase, error);
  tagSubagentsStoreLedgered(error);
  throw error;
}

function openRegistryGuarded(root: string, phase: SubagentsStorePhase): Database.Database {
  try { return openRegistryStore(root); }
  catch (error) { failSubagentsStore(root, phase, error); }
}
function openRegistryStore(root: string): Database.Database {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  const db = openDatabase(registryDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS subagents (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacySubagents(db, root);
  return db;
}
function normalizeSubagent(item: Subagent): Subagent {
  return { ...item, role: item.role ?? "task", quiet: item.quiet === true };
}
function migrateLegacySubagents(db: Database.Database, root: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM subagents").get() as { n: number };
  if (n > 0) return;
  const legacy = file(root);
  if (!existsSync(legacy)) return;
  let data: unknown;
  try { data = JSON.parse(readFileSync(legacy, "utf8")); } catch { return; }
  if (!Array.isArray(data)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO subagents (id, data) VALUES (?, ?)");
  const importAll = db.transaction((rows: unknown[]) => {
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Partial<Subagent>;
      if (typeof item.id !== "string" || !item.id) continue;
      insert.run(item.id, JSON.stringify(normalizeSubagent(item as Subagent)));
    }
  });
  importAll(data);
  renameSync(legacy, legacy + ".migrated");
}
function rowToSubagent(data: string): Subagent | null {
  try { const value: unknown = JSON.parse(data); return value && typeof value === "object" ? normalizeSubagent(value as Subagent) : null; }
  catch { return null; }
}
function storeExists(root: string): boolean {
  return existsSync(registryDbFile(root)) || existsSync(file(root));
}
function read(root: string): Subagent[] {
  if (!storeExists(root)) return [];
  const db = openRegistryGuarded(root, "read");
  try {
    const rows = db.prepare("SELECT data FROM subagents ORDER BY rowid").all() as Array<{ data: string }>;
    const items: Subagent[] = [];
    for (const row of rows) { const item = rowToSubagent(row.data); if (item) items.push(item); }
    return items;
  } catch (error) { failSubagentsStore(root, "read", error); }
  finally { db.close(); }
}
function readOne(root: string, id: string): Subagent | null {
  if (!storeExists(root)) return null;
  const db = openRegistryGuarded(root, "read");
  try {
    const row = db.prepare("SELECT data FROM subagents WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? rowToSubagent(row.data) : null;
  } catch (error) { failSubagentsStore(root, "read", error); }
  finally { db.close(); }
}
function put(root: string, item: Subagent): void {
  const db = openRegistryGuarded(root, "write");
  try {
    db.prepare("INSERT INTO subagents (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(item.id, JSON.stringify(normalizeSubagent(item)));
  } catch (error) { failSubagentsStore(root, "write", error); }
  finally { db.close(); }
}
// The store's update door (the updateCodingTask precedent): patch
// one record by id through the store's own shape. Returns the
// updated record, or null when no such sub-agent exists - and a
// miss on an install with no store at all creates nothing.
export function updateSubagent(root: string, id: string, patch: Partial<Subagent>): Subagent | null {
  if (!storeExists(root)) return null;
  const current = readOne(root, id);
  if (!current) return null;
  const next: Subagent = { ...current, ...patch, id: current.id };
  put(root, next);
  return next;
}

function finishLoop(root: string, loopId: string | null, state: "completed" | "failed" | "interrupted", result: string): void {
  if (!loopId) return;
  const journal = new AgentLoopJournal(journalPath(root));
  try { journal.finish(loopId, state, result.slice(0, 8000)); }
  catch { /* already terminal, or the restart fence already closed it */ }
  finally { journal.close(); }
}

/** A running child with no live runner in this process is an orphan.
 *  The journal's terminal transition is the same one interruptOrphans
 *  uses: interrupted, with the evidence left in place, never replayed. */
export function listSubagents(root: string, profile?: string): Subagent[] {
  const items = read(root);
  for (const item of items) {
    if (item.status !== "running" || live.has(item.id)) continue;
    finishLoop(root, item.loopId, "interrupted", "Process ended before completion; inspect evidence before resuming");
    item.status = "interrupted";
    item.result = "Process ended before completion; inspect evidence before resuming";
    item.finishedAt = new Date().toISOString();
    put(root, item);
    recordActivity(root, item.profile, "subagent-interrupted", subagentInterruptedLedgerSummary(item.id));
  }
  return profile ? items.filter(s => s.profile === profile) : items;
}

export function getSubagent(root: string, id: string): Subagent | null {
  return listSubagents(root).find(s => s.id === id) ?? null;
}

function narrowTools(requested: string[] | undefined, inherited: string[]): string[] {
  if (!requested || requested.length === 0) return [...inherited];
  const unique = [...new Set(requested)];
  const widened = unique.filter(name => !inherited.includes(name));
  if (widened.length) throw new Error("Tool allowlist cannot widen past the parent: " + widened.join(", "));
  if (!unique.length) throw new Error("Tool allowlist is empty");
  return unique;
}

function carveBudget(items: Subagent[], profile: string, requested: SubagentBudget): SubagentBudget {
  const budget = {
    rounds: requested.rounds,
    maxCalls: requested.maxCalls,
  };
  if (!Number.isInteger(budget.rounds) || budget.rounds < 1 || budget.rounds > 6) throw new Error("Sub-agent rounds must be 1 to 6");
  if (!Number.isInteger(budget.maxCalls) || budget.maxCalls < 1 || budget.maxCalls > 16) throw new Error("Sub-agent calls must be 1 to 16");
  // Turn-scoped pool (Defect 3): the carve is charged to the hiring
  // context's current scope, sized by that context (owner tranche or
  // the small pool) - never to a lifetime ledger. The per-helper caps
  // above stay as sanity bounds on any single worker.
  const ctx = currentSpawnPool();
  const pool = ctx?.pool ?? PARENT_POOL;
  const { used } = scopeUsed(items, profile, ctx);
  if (used.rounds + budget.rounds > pool.rounds || used.maxCalls + budget.maxCalls > pool.maxCalls)
    throw new SpawnPoolError("Sub-agent budget exceeds the parent's remaining pool (" + Math.max(0, pool.rounds - used.rounds) + " rounds, " + Math.max(0, pool.maxCalls - used.maxCalls) + " calls left)", { rounds: Math.max(0, pool.rounds - used.rounds), maxCalls: Math.max(0, pool.maxCalls - used.maxCalls) }, { ...budget });
  if (ctx?.ceiling) {
    const turnUsed = items
      .filter(s => s.profile === profile && s.status !== "cancelled" && s.poolTurn === ctx.turnKey)
      .reduce((sum, s) => ({ rounds: sum.rounds + s.budget.rounds, maxCalls: sum.maxCalls + s.budget.maxCalls }), { rounds: 0, maxCalls: 0 });
    if (turnUsed.rounds + budget.rounds > ctx.ceiling.rounds || turnUsed.maxCalls + budget.maxCalls > ctx.ceiling.maxCalls)
      throw new SpawnPoolError("Sub-agent budget exceeds the turn's total hiring ceiling (" + Math.max(0, ctx.ceiling.rounds - turnUsed.rounds) + " rounds, " + Math.max(0, ctx.ceiling.maxCalls - turnUsed.maxCalls) + " calls left of the ceiling)", { rounds: Math.max(0, ctx.ceiling.rounds - turnUsed.rounds), maxCalls: Math.max(0, ctx.ceiling.maxCalls - turnUsed.maxCalls) }, { ...budget }, true);
  }
  return budget;
}

function toolDefs(names: string[]): Array<Record<string, unknown>> {
  const allowed = new Set(names);
  return OWN_TOOLS.filter(def => allowed.has(toolNameOf(def)));
}

function profileRecord(root: string, profile: string): { provider: string | null; model: string | null; connectorId: string | null } | null {
  const db = new ChatStore(root);
  try {
    const agent = db.agents().find(a => a.name === profile);
    if (!agent) return null;
    return { provider: agent.provider ?? null, model: agent.model ?? null, connectorId: agent.connector_id ?? null };
  } finally { db.close(); }
}

/** Plain when this profile has no pin, or the pin names a connector
 *  the workspace does not hold. Connector only when the pin resolves
 *  to a connector that is actually registered here. */
export function childTurnRoute(root: string, profile: string): "plain" | "connector" {
  const connectorId = profileRecord(root, profile)?.connectorId ?? null;
  if (!connectorId) return "plain";
  const pinned = connectors(root).find(c => c.id === connectorId);
  if (!pinned) return "plain";
  return "connector";
}

function childInstruction(item: Subagent): string {
  return "You are a sub-agent of profile " + item.profile + ". Do only this task. You may use only these tools: " + (item.tools.join(", ") || "(none)") + ". A tool not in that list does not exist for you. Consequential actions are proposals: sam_propose_action cards the owner and does not run until they approve. The owner never sees this turn." + (item.role === "review" ? " You are the internal reviewer. The first line of your answer must be exactly `VERDICT: approve` or `VERDICT: request-changes`, then the reasons." : " When the task is done, answer with the result and no further tool calls.") + "\n\nTask: " + item.prompt;
}

async function defaultComplete(env: NodeJS.ProcessEnv): Promise<SubagentCompleter> {
  const providerName = env.SAM_MODEL_PROVIDER ?? "";
  const endpoint = env.SAM_MODEL_ENDPOINT?.trim() || (providerName === "minimax" ? "https://api.minimax.io/v1/chat/completions" : "");
  const key = env.SAM_MODEL_API_KEY?.trim() || (providerName === "minimax" ? env.MINIMAX_API_KEY?.trim() : "") || "";
  const model = env.SAM_MODEL?.trim() || "";
  if (!endpoint || !model) throw new Error("Model not configured");
  const provider = new OpenAICompatibleProvider(endpoint, key, 60_000);
  return async (_model, messages, tools) => provider.completeConnectorTurn(model, messages, tools);
}

async function connectorComplete(root: string, profile: string, env: NodeJS.ProcessEnv): Promise<SubagentCompleter> {
  const connectorId = profileRecord(root, profile)?.connectorId ?? null;
  const pinned = connectorId ? connectors(root).find(c => c.id === connectorId) : undefined;
  if (!pinned || !pinned.enabled || !(pinned.tokenEnv ? !!env[pinned.tokenEnv] : connectorCredentialPresent(root, pinned))) throw new Error("Profile connector unavailable");
  return defaultComplete(env);
}

type SpawnInput = { profile?: string; prompt: string; tools?: string[]; parentId?: string | null; chatId?: string | null; rounds?: number; maxCalls?: number; role?: Subagent["role"]; quiet?: boolean };
type SpawnOpts = { complete?: SubagentCompleter; env?: NodeJS.ProcessEnv; fold?: (item: Subagent) => Promise<string> };

let testRunner: SpawnOpts | null = null;
/** Tests inject the child model and the fold. Production leaves this unset. */
export function setSubagentRunnerForTests(opts: SpawnOpts | null): void { testRunner = opts; }
function runner(opts?: SpawnOpts): SpawnOpts | undefined {
  return testRunner ? { ...testRunner, ...opts } : opts;
}

function normalizeSubagentProfileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
/** The ONE source for why a helper cannot be spawned for
 *  this profile: the name is not in the profile registry
 *  ("sam", the implicit core profile, plus every registered
 *  agent), so a helper bound to it would serve no one - the
 *  record sits in the registry under a profile that is no
 *  profile, its subagent-spawn ledger line carries that same
 *  phantom actor, the child resolves no registered profile
 *  (no instructions, connector pin, or law), and its carved
 *  budget and work are accounted to that phantom. The
 *  terminal spawn door (CLI `subagent spawn --profile`)
 *  rides this source and refuses before spawning anything.
 *  When exactly one valid profile matches the bad name
 *  folded for case and separators, the refusal names it
 *  ("Second Shift" -> "second-shift"). Null means the
 *  profile can be named. spawnSubagent itself stays
 *  permissive by design: a profile removed after a helper
 *  names it leaves the record with its stored profile, the
 *  sam_spawn_subagent chat tool names its profile by
 *  construction (the speaking chat's own profile), and the
 *  orchestration lane runner carries its job's stored
 *  profile - so spawnSubagent is NOT gated. */
export function subagentProfileBlocker(root: string, profile: string): string | null {
  const db = new ChatStore(root);
  let names: string[];
  try { names = ["sam", ...db.agents().map(a => a.name).filter(n => n !== "sam")]; } finally { db.close(); }
  if (names.includes(profile)) return null;
  const target = normalizeSubagentProfileName(profile ?? "");
  const matches = target ? names.filter(n => normalizeSubagentProfileName(n) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Unknown profile \"" + profile + "\" in subagent detail. Valid profiles: " + names.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}

function openSubagent(root: string, input: SpawnInput): Subagent {
  const prompt = input.prompt?.trim() ?? "";
  if (!prompt || prompt.length > 2000) throw new Error("Sub-agent prompt must be 1 to 2000 characters");
  const profile = input.profile?.trim() || "sam";
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(profile)) throw new Error("Invalid profile");
  const items = read(root);
  const parent = input.parentId ? items.find(s => s.id === input.parentId) ?? null : null;
  if (input.parentId && !parent) throw new Error("Unknown parent sub-agent");
  if (parent && parent.profile !== profile) throw new Error("A child keeps its parent's profile");
  const depth = parent ? parent.depth + 1 : 1;
  if (depth > SUBAGENT_MAX_DEPTH) throw new Error("Sub-agent depth cap is " + SUBAGENT_MAX_DEPTH);
  const running = items.filter(s => s.profile === profile && s.status === "running").length;
  if (running >= SUBAGENT_MAX_CONCURRENT) throw new Error("Sub-agent concurrency cap is " + SUBAGENT_MAX_CONCURRENT);
  const inherited = parent ? parent.tools : profileToolNames();
  const role = input.role ?? "task";
  const requested = input.tools ?? (role === "research" || role === "build" || role === "review" ? defaultRoleTools(role, inherited) : undefined);
  const tools = narrowTools(requested, inherited);
  const budget = carveBudget(items, profile, { rounds: input.rounds ?? 2, maxCalls: input.maxCalls ?? 4 });
  const chatId = input.chatId ?? null;
  if (chatId) {
    const db = new ChatStore(root);
    try { if (!db.get(chatId)) throw new Error("Unknown chat"); }
    finally { db.close(); }
  }
  const journal = new AgentLoopJournal(journalPath(root));
  let loopId: string | null = null;
  try {
    loopId = journal.create(prompt.slice(0, 4000)).id;
  } finally { journal.close(); }
  const poolCtx = currentSpawnPool();
  const item: Subagent = {
    id: loopId, profile, parentId: parent?.id ?? null, depth, prompt, tools, budget,
    status: "running", result: null, loopId, createdAt: new Date().toISOString(), finishedAt: null, chatId,
    role, quiet: input.quiet === true,
    poolScope: scopeUsed(items, profile, poolCtx).scope,
    poolTurn: poolCtx?.owner ? poolCtx.turnKey : undefined,
  };
  put(root, item);
  live.add(item.id);
  recordActivity(root, profile, "subagent-spawn", subagentSpawnLedgerSummary(item.id, depth, tools.length, budget));
  return item;
}

// Sub-agent failures carry their cause (gap found 2026-11-16,
// hourly run 14:04 EST): driveSubagent's catch took
// error.message alone over a child chat turn that can die on
// transport, and that one bare message fed three records -
// the subagent-failed activity line, the helper's stored
// result, and the finishLoop journal fold - so a child dying
// on an undici failure read "fetch failed" in all three and
// named nothing. The reason now composes through errorReason
// (the 04:04 bridge seam): the cause chain is walked bounded
// and deduped, errno-style codes are appended, and bot-token
// segments are redacted, so a child dying on a DNS failure
// names the lookup in all three records in the same shape.
// Causeless errors read byte-identically, a non-Error throw
// keeps the existing "Sub-agent failed" fallback, and the
// helper's prompt never enters any failure record.
export function subagentFailureReason(error: unknown): string {
  return error instanceof Error ? errorReason(error) : "Sub-agent failed";
}

export function subagentFailedSummary(id: string, error: unknown): string {
  return "Sub-agent " + id.slice(0, 8) + " failed: " + subagentFailureReason(error).slice(0, 180);
}

// The ONE writers for the other five lifecycle lines, so
// the scorecard's parsers below can never drift from the
// seams they count. Each shape is byte-identical to what
// its seam wrote inline before these writers existed: the
// spawn (id prefix, depth, tool count, carved budget), the
// done (id prefix, role, the result collapsed and capped),
// the folded (id prefix, chat prefix), the cancelled (the
// fixed prefix plus the id prefix, at the cancelSubagent
// seam), and the interrupted (the full fixed sentence, at
// the listSubagents orphan sweep). The cancelled and
// interrupted writers landed 2026-11-22 (hourly run 00:04
// EST): those two endings were the last lifecycle shapes
// still written inline, unnamed by any parser or fold. The
// failed line already rides subagentFailedSummary above.
export function subagentSpawnLedgerSummary(id: string, depth: number, toolCount: number, budget: { rounds: number; maxCalls: number }): string {
  return "Sub-agent " + id.slice(0, 8) + " depth " + depth + " tools " + toolCount + " budget " + budget.rounds + "x" + budget.maxCalls;
}
export function subagentDoneLedgerSummary(id: string, role: string, result: string): string {
  return "Sub-agent " + id.slice(0, 8) + " (" + role + ") returned: " + result.replace(/\s+/g, " ").slice(0, 160);
}
export function subagentFoldedLedgerSummary(id: string, chatId: string): string {
  return "Folded " + id.slice(0, 8) + " into chat " + chatId.slice(0, 8);
}
export function subagentCancelledLedgerSummary(id: string): string {
  return "Cancelled sub-agent " + id.slice(0, 8);
}
export function subagentInterruptedLedgerSummary(id: string): string {
  return "Sub-agent " + id.slice(0, 8) + " was still running when the process ended; checkpoint kept, tools not replayed";
}

// The sub-agent scorecard (2026-11-18, the measured-proof
// series; extended to the full lifecycle 2026-11-22, hourly
// run 00:04 EST): every invisible helper SAM spawns ledgers
// its lifecycle across six activity kinds - spawn, done,
// failed, folded, cancelled, interrupted - carrying the
// child's id prefix and, on the done and failed lines, free
// text (the result's head, the failure reason). The first
// cut folded only the first four: a cancelled child (the
// owner's deliberate stop) and an interrupted child (a
// process death the orphan sweep fenced, checkpoint kept,
// tools not replayed) showed as spawns that never closed,
// and how many helpers ever ended either way was invisible
// in aggregate - the registry store holds only each child's
// current status, so these ledger lines are the only count
// either ending ever gets. No daily surface ever counted
// them, so delegation going silent, a rising child failure
// share, or spawns that never close was invisible in
// aggregate. The text folds counts only: per-stage counts
// and the distinct-child count as a NUMBER only, parsed
// from the fixed summaries. A summary matching no fixed
// shape for its kind counts under that kind and contributes
// no child count, and no stamp, actor, id, role, chat
// prefix, result text, reason, or verbatim summary is ever
// printed - a child's result and reason are its work
// product and its failure's detail, and neither belongs in
// a trending surface. The verdict is attention when any
// child failed, any child was interrupted, or any line is
// unparseable, else clear - a cancellation is the owner's
// act and is counted, not alarmed (the team-member
// precedent); an interruption is a process death and is
// itself the signal (the door-history precedent). No stamp
// and no actor enters the text, so a quiet day is
// byte-identical and P3-silent, and a failed or interrupted
// child, a malformed line, or a mix shift is the news. A
// pure read: it creates nothing, spends no model call, and
// spawns nothing - the ledger and the lifecycle seams are
// untouched, and spawning a helper stays the turn's job.
export function parseSubagentSummary(kind: string, summary: string): { child: string } | null {
  if (kind === "subagent-spawn") {
    const m = /^Sub-agent (\S+) depth \d+ tools \d+ budget \d+x\d+$/.exec(summary);
    return m ? { child: m[1] } : null;
  }
  if (kind === "subagent-done") {
    const m = /^Sub-agent (\S+) \(\S+\) returned: /.exec(summary);
    return m ? { child: m[1] } : null;
  }
  if (kind === "subagent-failed") {
    const m = /^Sub-agent (\S+) failed: /.exec(summary);
    return m ? { child: m[1] } : null;
  }
  if (kind === "subagent-folded") {
    const m = /^Folded (\S+) into chat \S+$/.exec(summary);
    return m ? { child: m[1] } : null;
  }
  if (kind === "subagent-cancelled") {
    const m = /^Cancelled sub-agent (\S+)$/.exec(summary);
    return m ? { child: m[1] } : null;
  }
  if (kind === "subagent-interrupted") {
    const m = /^Sub-agent (\S+) was still running when the process ended; checkpoint kept, tools not replayed$/.exec(summary);
    return m ? { child: m[1] } : null;
  }
  return null;
}
export function subagentScorecardText(root: string): string {
  const stages: [string, string][] = [
    ["subagent-spawn", "Spawned"],
    ["subagent-done", "Done"],
    ["subagent-failed", "Failed"],
    ["subagent-folded", "Folded"],
    ["subagent-cancelled", "Cancelled"],
    ["subagent-interrupted", "Interrupted"],
  ];
  const children = new Set<string>();
  let failed = 0;
  let interrupted = 0;
  let unparseable = 0;
  const out: string[] = [];
  const counts: string[] = [];
  for (const [kind, label] of stages) {
    const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind });
    for (const line of lines) {
      const parsed = parseSubagentSummary(kind, line.summary);
      if (!parsed) { unparseable += 1; continue; }
      children.add(parsed.child);
    }
    if (kind === "subagent-failed") failed = lines.length;
    if (kind === "subagent-interrupted") interrupted = lines.length;
    counts.push(label + ": " + String(lines.length));
  }
  out.push("Sub-agents: " + (failed > 0 || interrupted > 0 || unparseable > 0 ? "attention" : "clear"));
  out.push(...counts);
  out.push("Distinct children: " + String(children.size));
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never spawns a helper, never prints a child id, a role, a result, or a reason; a failed or interrupted child, a malformed line, or a mix shift is the news");
  return out.join("\n");
}

// Child tool failures carry their cause (gap found 2026-11-17,
// hourly run 07:04 EST): runChild's dispatch catch took
// error.message alone for an Error and the bare "Tool failed"
// label for a non-Error, discarding error.cause, so a child's
// tool dying on transport (fetch failed with its real reason
// on the cause) or a store death carrying an errno-style code
// read back to the child model as the wrapper alone - and the
// tool result is the only record of that death (it also rides
// the loop journal's tool_call detail). The error now composes
// through errorReason (the 04:04 bridge seam) via
// childToolFailureError: the "Tool failed" prefix stays, the
// reason follows it, a non-Error throw keeps String(error),
// bot-token segments are redacted, and the tool's arguments
// never enter the error.
export function childToolFailureError(error: unknown): string {
  return "Tool failed: " + errorReason(error);
}

async function driveSubagent(root: string, item: Subagent, opts?: SpawnOpts): Promise<Subagent> {
  try {
    const env = opts?.env ?? process.env;
    const injected = opts?.complete;
    // A child hires from its OWN carved budget, never from its
    // parent's scope: its context shadows the hiring one for the
    // length of its turn (Defect 3 pool scoping).
    const childCtx = smallSpawnPool("sub:" + item.id);
    childCtx.pool = { ...item.budget };
    const result = injected
      ? await withSpawnPool(childCtx, () => runChild(root, item, injected))
      : childTurnRoute(root, item.profile) === "plain"
        ? await withSpawnPool(childCtx, () => runChildPlain(root, item, env))
        : await withSpawnPool(childCtx, async () => runChild(root, item, await connectorComplete(root, item.profile, env)));
    const latest = read(root).find(s => s.id === item.id);
    if (latest?.status === "cancelled") {
      item.status = "cancelled";
      item.result = latest.result;
      item.finishedAt = latest.finishedAt;
      return item;
    }
    item.status = "done";
    item.result = result;
    item.finishedAt = new Date().toISOString();
    put(root, item);
    finishLoop(root, item.loopId, "completed", result);
    recordActivity(root, item.profile, "subagent-done", subagentDoneLedgerSummary(item.id, item.role, result));
    if (item.chatId && !item.quiet) {
      const db = new ChatStore(root);
      try { db.add(item.chatId, "assistant", ("Sub-agent result:\n" + result).slice(0, 12000)); }
      finally { db.close(); }
    }
    if (item.chatId && item.quiet && !item.parentId) await postFoldedAnswer(root, item, opts?.fold, env);
    return item;
  } catch (error) {
    const message = subagentFailureReason(error);
    const latest = read(root).find(s => s.id === item.id);
    if (latest?.status === "cancelled") {
      item.status = "cancelled";
      item.result = latest.result;
      item.finishedAt = latest.finishedAt;
      return item;
    }
    item.status = "failed";
    item.result = message;
    item.finishedAt = new Date().toISOString();
    put(root, item);
    finishLoop(root, item.loopId, "failed", message);
    recordActivity(root, item.profile, "subagent-failed", subagentFailedSummary(item.id, error));
    throw error;
  } finally {
    live.delete(item.id);
  }
}

/** Owner-facing text only. Helper prompts, tool chatter, and verdict labels stay out of the chat. */
export function ownerFold(result: string): string {
  const lines = result.split("\n").map(line => line.trim()).filter(Boolean);
  const body = lines.filter(line => !/^VERDICT:/i.test(line)).join(" ").replace(/\s+/g, " ").trim();
  return (body || "Working on it.").slice(0, 2000);
}

async function defaultFold(env: NodeJS.ProcessEnv, item: Subagent): Promise<string> {
  try {
    const complete = await defaultComplete(env);
    const turn = await complete("fold", [
      { role: "system", content: "Write one reply to the owner. Do not mention helpers, sub-agents, internal reviews, or verdict labels. If the notes say changes are still needed, say what remains in your own words. Otherwise give the outcome." },
      { role: "user", content: item.result ?? "" },
    ], []);
    const text = (turn.content ?? "").trim();
    if (!text || /\bsub-agent\b|\bhelper\b|VERDICT:/i.test(text)) return ownerFold(item.result ?? "");
    return text.slice(0, 4000);
  } catch {
    return ownerFold(item.result ?? "");
  }
}

async function postFoldedAnswer(root: string, item: Subagent, fold: ((item: Subagent) => Promise<string>) | undefined, env: NodeJS.ProcessEnv): Promise<void> {
  if (!item.chatId || !item.result) return;
  let text = "";
  try { text = (fold ? await fold(item) : await defaultFold(env, item)).trim(); }
  catch { text = ownerFold(item.result); }
  if (!text || /\bsub-agent\b|VERDICT:/i.test(text)) text = ownerFold(item.result);
  const db = new ChatStore(root);
  try { db.add(item.chatId, "assistant", text.slice(0, 4000)); }
  finally { db.close(); }
  recordActivity(root, item.profile, "subagent-folded", subagentFoldedLedgerSummary(item.id, item.chatId));
}

/**
 * Start a helper without waiting. The chat turn returns at once with the id.
 * When the helper finishes, one folded answer is posted into the chat.
 */
export function startBackgroundSubagent(root: string, input: SpawnInput, opts?: SpawnOpts): { id: string; status: "working"; ownerLine: string } {
  const item = openSubagent(root, { ...input, quiet: true });
  const job = driveSubagent(root, item, runner(opts)).catch(error => {
    const latest = read(root).find(s => s.id === item.id);
    if (latest && latest.status !== "running") return latest;
    throw error;
  });
  inflight.set(item.id, job);
  return { id: item.id, status: "working", ownerLine: "Working on it." };
}

export function whenSubagentSettled(id: string): Promise<Subagent> {
  const job = inflight.get(id);
  if (!job) throw new Error("Sub-agent is not running in this process: " + id);
  return job;
}

export async function spawnSubagent(root: string, input: SpawnInput, opts?: SpawnOpts): Promise<Subagent> {
  return driveSubagent(root, openSubagent(root, input), runner(opts));
}

/** The plain chat path: the same own-tools turn a chat uses when no
 *  connector is pinned. It partitions a full tool set, so a child that
 *  inherits every own tool does not die on the connector request cap,
 *  and it never asks for a connector credential. */
async function runChildPlain(root: string, item: Subagent, env: NodeJS.ProcessEnv): Promise<string> {
  const pins = profileRecord(root, item.profile);
  const conn = turnRoutes(root, env, item.profile, pins ? { provider: pins.provider, model: pins.model } : null, "chat")[0];
  if (conn.unavailable || !conn.endpoint || !conn.model) throw new Error(conn.unavailable ?? "Model not configured");
  const model = conn.model;
  const provider = new OpenAICompatibleProvider(conn.endpoint, readProviderKey(env, conn.keyEnv) ?? "", 60_000);
  const history = [
    { role: "system" as const, content: childInstruction(item) },
    { role: "user" as const, content: item.prompt },
  ];
  const journal = new AgentLoopJournal(journalPath(root));
  try {
    const reply = await parentSlot.run(item.id, () => ownToolsChat(
      root, item.profile, provider, model, history,
      undefined, item.chatId ?? undefined,
      { rounds: item.budget.rounds, maxCalls: item.budget.maxCalls },
      undefined, undefined, item.tools,
    ));
    try { journal.event(item.loopId!, "plain_path", "Child turn ran on the plain chat path"); } catch { /* a closed loop does not break the child */ }
    return reply.trim() || "(no result)";
  } finally { journal.close(); }
}

async function runChild(root: string, item: Subagent, complete: SubagentCompleter): Promise<string> {
  const allowedDefs = toolDefs(item.tools);
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: childInstruction(item) },
    { role: "user", content: item.prompt },
  ];
  const journal = new AgentLoopJournal(journalPath(root));
  const loaded = new Set<string>();
  let callsUsed = 0;
  try {
    for (let round = 1; round <= item.budget.rounds; round++) {
      if (read(root).find(s => s.id === item.id)?.status !== "running") return "Cancelled";
      const part = partitionTools(allowedDefs, loaded);
      const defs = part.active ? [...part.upfront, LOADER_TOOL_DEF] : part.upfront;
      const turn = await complete("subagent", messages, defs);
      const calls = turn.calls ?? [];
      if (!calls.length) return (turn.content ?? "").trim() || "(no result)";
      messages.push({ role: "assistant", content: turn.content, tool_calls: calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
      for (const call of calls) {
        let body: unknown;
        if (call.name === LOADER_TOOL_NAME) {
          const names = Array.isArray(call.args?.names) ? call.args.names.filter((n): n is string => typeof n === "string") : [];
          const newly: string[] = [];
          const unknown: string[] = [];
          for (const name of names) {
            if (!item.tools.includes(name)) unknown.push(name);
            else if (!loaded.has(name)) { loaded.add(name); newly.push(name); }
          }
          body = { status: "loaded", loaded: newly, unknown, note: "Loaded tools are callable from your next step onward." };
        } else if (!item.tools.includes(call.name)) body = { error: "Tool " + call.name + " is not on this sub-agent's allowlist" };
        else if (callsUsed >= item.budget.maxCalls) body = { error: "Sub-agent tool budget exhausted" };
        else {
          callsUsed++;
          try { body = await parentSlot.run(item.id, () => executeOwnToolAsync(root, item.profile, call.name, call.args ?? {}, undefined, item.chatId ?? undefined)); }
          catch (error) { body = { error: childToolFailureError(error) }; }
          const detail = call.name + " " + JSON.stringify(body).slice(0, 400);
          try { journal.event(item.loopId!, "tool_call", detail); } catch { /* a closed loop does not break the child */ }
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(body).slice(0, 4000) });
      }
      try { journal.progress(item.loopId!, round, callsUsed); } catch { /* progress is a checkpoint, not the result */ }
    }
    return "Sub-agent stopped at its round budget (" + item.budget.rounds + ") after " + callsUsed + " tool calls.";
  } finally { journal.close(); }
}

export function cancelSubagent(root: string, id: string): Subagent {
  const item = readOne(root, id);
  if (!item) throw new Error("Unknown sub-agent: " + id);
  if (item.status !== "running") throw new Error("Sub-agent is already " + item.status);
  item.status = "cancelled";
  item.result = "Cancelled by the owner";
  item.finishedAt = new Date().toISOString();
  put(root, item);
  finishLoop(root, item.loopId, "failed", "Cancelled by the owner");
  recordActivity(root, item.profile, "subagent-cancelled", subagentCancelledLedgerSummary(item.id));
  return item;
}
