import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { AgentLoopJournal } from "./agent-loop-journal.js";
import { executeOwnToolAsync, OWN_TOOLS } from "./own-tools.js";
import { toolNameOf } from "./tool-tiers.js";
import { recordActivity } from "./activity.js";
import { ChatStore } from "./chats.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Sub-agents (item 10). A profile spawns a child turn with its own
// prompt, a tool allowlist inherited from the parent or narrowed
// (never widened), and a budget carved out of the parent's pool.
// The child uses the same approval gate: a consequential proposal
// stays a card for the owner. The run is an AgentLoopJournal loop,
// so a restart can still see the checkpoint and fences an orphaned
// run as interrupted instead of replaying its tools.

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
}

export interface SubagentTurn { content: string | null; calls: Array<{ id: string; name: string; args: Record<string, unknown> }> }
export type SubagentCompleter = (model: string, messages: Array<Record<string, unknown>>, tools: Array<Record<string, unknown>>) => Promise<SubagentTurn>;

const live = new Set<string>();

function file(root: string): string { return join(resolve(root), ".sam", "subagents.json"); }
function journalPath(root: string): string { return join(resolve(root), ".sam", "subagents.db"); }

export function profileToolNames(): string[] {
  return OWN_TOOLS.map(toolNameOf).filter(name => name.length > 0);
}

function read(root: string): Subagent[] {
  if (!existsSync(file(root))) return [];
  try {
    const data = JSON.parse(readFileSync(file(root), "utf8")) as unknown;
    return Array.isArray(data) ? data as Subagent[] : [];
  } catch { return []; }
}
function save(root: string, items: Subagent[]): void {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  writeFileSync(file(root), JSON.stringify(items, null, 2), { mode: 0o600 });
}
function put(root: string, item: Subagent): void {
  const items = read(root).filter(s => s.id !== item.id);
  items.push(item);
  save(root, items);
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
  let changed = false;
  for (const item of items) {
    if (item.status !== "running" || live.has(item.id)) continue;
    finishLoop(root, item.loopId, "interrupted", "Process ended before completion; inspect evidence before resuming");
    item.status = "interrupted";
    item.result = "Process ended before completion; inspect evidence before resuming";
    item.finishedAt = new Date().toISOString();
    changed = true;
    recordActivity(root, item.profile, "subagent-interrupted", "Sub-agent " + item.id.slice(0, 8) + " was still running when the process ended; checkpoint kept, tools not replayed");
  }
  if (changed) save(root, items);
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

async function defaultComplete(env: NodeJS.ProcessEnv): Promise<SubagentCompleter> {
  const providerName = env.SAM_MODEL_PROVIDER ?? "";
  const endpoint = env.SAM_MODEL_ENDPOINT?.trim() || (providerName === "minimax" ? "https://api.minimax.io/v1/chat/completions" : "");
  const key = env.SAM_MODEL_API_KEY?.trim() || (providerName === "minimax" ? env.MINIMAX_API_KEY?.trim() : "") || "";
  const model = env.SAM_MODEL?.trim() || "";
  if (!endpoint || !model) throw new Error("Model not configured");
  const provider = new OpenAICompatibleProvider(endpoint, key, 60_000);
  return async (_model, messages, tools) => provider.completeConnectorTurn(model, messages, tools);
}

export async function spawnSubagent(root: string, input: { profile?: string; prompt: string; tools?: string[]; parentId?: string | null; chatId?: string | null; rounds?: number; maxCalls?: number }, opts?: { complete?: SubagentCompleter; env?: NodeJS.ProcessEnv }): Promise<Subagent> {
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
  const tools = narrowTools(input.tools, inherited);
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
  };
  put(root, item);
  live.add(item.id);
  recordActivity(root, profile, "subagent-spawn", "Sub-agent " + item.id.slice(0, 8) + " depth " + depth + " tools " + tools.length + " budget " + budget.rounds + "x" + budget.maxCalls);
  try {
    const complete = opts?.complete ?? await defaultComplete(opts?.env ?? process.env);
    const result = await runChild(root, item, complete);
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
    recordActivity(root, profile, "subagent-done", "Sub-agent " + item.id.slice(0, 8) + " returned: " + result.replace(/\s+/g, " ").slice(0, 180));
    if (chatId) {
      const db = new ChatStore(root);
      try { db.add(chatId, "assistant", ("Sub-agent result:\n" + result).slice(0, 12000)); }
      finally { db.close(); }
    }
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
    recordActivity(root, profile, "subagent-failed", "Sub-agent " + item.id.slice(0, 8) + " failed: " + message.slice(0, 180));
    throw error;
  } finally {
    live.delete(item.id);
  }
}

async function runChild(root: string, item: Subagent, complete: SubagentCompleter): Promise<string> {
  const defs = toolDefs(item.tools);
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "You are a sub-agent of profile " + item.profile + ". Do only this task. You may use only these tools: " + (item.tools.join(", ") || "(none)") + ". A tool not in that list does not exist for you. Consequential actions are proposals: sam_propose_action cards the owner and does not run until they approve. When the task is done, answer with the result and no further tool calls.\n\nTask: " + item.prompt },
    { role: "user", content: item.prompt },
  ];
  const journal = new AgentLoopJournal(journalPath(root));
  let callsUsed = 0;
  try {
    for (let round = 1; round <= item.budget.rounds; round++) {
      if (read(root).find(s => s.id === item.id)?.status !== "running") return "Cancelled";
      const turn = await complete("subagent", messages, defs);
      const calls = turn.calls ?? [];
      if (!calls.length) return (turn.content ?? "").trim() || "(no result)";
      messages.push({ role: "assistant", content: turn.content, tool_calls: calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
      for (const call of calls) {
        let body: unknown;
        if (!item.tools.includes(call.name)) body = { error: "Tool " + call.name + " is not on this sub-agent's allowlist" };
        else if (callsUsed >= item.budget.maxCalls) body = { error: "Sub-agent tool budget exhausted" };
        else {
          callsUsed++;
          try { body = await executeOwnToolAsync(root, item.profile, call.name, call.args ?? {}); }
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
  const items = read(root);
  const item = items.find(s => s.id === id);
  if (!item) throw new Error("Unknown sub-agent: " + id);
  if (item.status !== "running") throw new Error("Sub-agent is already " + item.status);
  item.status = "cancelled";
  item.result = "Cancelled by the owner";
  item.finishedAt = new Date().toISOString();
  save(root, items);
  finishLoop(root, item.loopId, "failed", "Cancelled by the owner");
  recordActivity(root, item.profile, "subagent-cancelled", "Cancelled sub-agent " + item.id.slice(0, 8));
  return item;
}
