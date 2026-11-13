import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { AgentLoopJournal } from "./agent-loop-journal.js";
import { executeOwnToolAsync, OWN_TOOLS, ownToolsChat } from "./own-tools.js";
import { LOADER_TOOL_DEF, LOADER_TOOL_NAME, partitionTools, toolNameOf } from "./tool-tiers.js";
import { recordActivity } from "./activity.js";
import { ChatStore } from "./chats.js";
import { connectors, connectorCredentialPresent } from "./connectors.js";
import { turnRoutes } from "./failover.js";
import { readProviderKey } from "./providers.js";
import { AsyncLocalStorage } from "node:async_hooks";
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
  const db = openRegistryStore(root);
  try {
    const rows = db.prepare("SELECT data FROM subagents ORDER BY rowid").all() as Array<{ data: string }>;
    const items: Subagent[] = [];
    for (const row of rows) { const item = rowToSubagent(row.data); if (item) items.push(item); }
    return items;
  } finally { db.close(); }
}
function readOne(root: string, id: string): Subagent | null {
  if (!storeExists(root)) return null;
  const db = openRegistryStore(root);
  try {
    const row = db.prepare("SELECT data FROM subagents WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? rowToSubagent(row.data) : null;
  } finally { db.close(); }
}
function put(root: string, item: Subagent): void {
  const db = openRegistryStore(root);
  try {
    db.prepare("INSERT INTO subagents (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(item.id, JSON.stringify(normalizeSubagent(item)));
  } finally { db.close(); }
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
    recordActivity(root, item.profile, "subagent-interrupted", "Sub-agent " + item.id.slice(0, 8) + " was still running when the process ended; checkpoint kept, tools not replayed");
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
  const used = items.filter(s => s.profile === profile && s.status !== "cancelled").reduce((sum, s) => ({
    rounds: sum.rounds + s.budget.rounds,
    maxCalls: sum.maxCalls + s.budget.maxCalls,
  }), { rounds: 0, maxCalls: 0 });
  const budget = {
    rounds: requested.rounds,
    maxCalls: requested.maxCalls,
  };
  if (!Number.isInteger(budget.rounds) || budget.rounds < 1 || budget.rounds > 6) throw new Error("Sub-agent rounds must be 1 to 6");
  if (!Number.isInteger(budget.maxCalls) || budget.maxCalls < 1 || budget.maxCalls > 16) throw new Error("Sub-agent calls must be 1 to 16");
  if (used.rounds + budget.rounds > PARENT_POOL.rounds || used.maxCalls + budget.maxCalls > PARENT_POOL.maxCalls)
    throw new Error("Sub-agent budget exceeds the parent's remaining pool (" + (PARENT_POOL.rounds - used.rounds) + " rounds, " + (PARENT_POOL.maxCalls - used.maxCalls) + " calls left)");
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
  const item: Subagent = {
    id: loopId, profile, parentId: parent?.id ?? null, depth, prompt, tools, budget,
    status: "running", result: null, loopId, createdAt: new Date().toISOString(), finishedAt: null, chatId,
    role, quiet: input.quiet === true,
  };
  put(root, item);
  live.add(item.id);
  recordActivity(root, profile, "subagent-spawn", "Sub-agent " + item.id.slice(0, 8) + " depth " + depth + " tools " + tools.length + " budget " + budget.rounds + "x" + budget.maxCalls);
  return item;
}

async function driveSubagent(root: string, item: Subagent, opts?: SpawnOpts): Promise<Subagent> {
  try {
    const env = opts?.env ?? process.env;
    const injected = opts?.complete;
    const result = injected
      ? await runChild(root, item, injected)
      : childTurnRoute(root, item.profile) === "plain"
        ? await runChildPlain(root, item, env)
        : await runChild(root, item, await connectorComplete(root, item.profile, env));
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
    recordActivity(root, item.profile, "subagent-done", "Sub-agent " + item.id.slice(0, 8) + " (" + item.role + ") returned: " + result.replace(/\s+/g, " ").slice(0, 160));
    if (item.chatId && !item.quiet) {
      const db = new ChatStore(root);
      try { db.add(item.chatId, "assistant", ("Sub-agent result:\n" + result).slice(0, 12000)); }
      finally { db.close(); }
    }
    if (item.chatId && item.quiet && !item.parentId) await postFoldedAnswer(root, item, opts?.fold, env);
    return item;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sub-agent failed";
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
    recordActivity(root, item.profile, "subagent-failed", "Sub-agent " + item.id.slice(0, 8) + " failed: " + message.slice(0, 180));
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
  recordActivity(root, item.profile, "subagent-folded", "Folded " + item.id.slice(0, 8) + " into chat " + item.chatId.slice(0, 8));
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
          catch (error) { body = { error: error instanceof Error ? error.message : "Tool failed" }; }
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
  recordActivity(root, item.profile, "subagent-cancelled", "Cancelled sub-agent " + item.id.slice(0, 8));
  return item;
}
