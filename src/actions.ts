import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MemoryStore } from "./memory.js";
import { PreferenceStore } from "./preferences.js";
import { addHeartbeatJob } from "./heartbeat.js";
import { ChatStore } from "./chats.js";
import { recordActivity } from "./activity.js";

// Hands, with a gate. SAM (any profile) can PROPOSE an action; nothing executes
// until the owner approves it in the dashboard or by CLI. The executor allowlist
// is deliberately internal-only: save a memory note, set a standing law, create
// a heartbeat job, or post a message into one of SAM's own chats. No external
// sends, no service control, no money, no trading - widening this list is an
// owner decision, never a model decision. Every step lands in the activity
// ledger, so a proposal's whole life is auditable.
export type ActionKind = "note" | "law" | "heartbeat" | "say";
export type ActionStatus = "pending" | "done" | "rejected" | "failed";
export interface ActionProposal {
  id: string; actor: string; kind: ActionKind; title: string; detail: string;
  status: ActionStatus; createdAt: string; decidedAt: string | null; result: string | null;
}
const KINDS: ActionKind[] = ["note", "law", "heartbeat", "say"];
function actionsFile(root: string): string { return join(resolve(root), ".sam", "actions.json"); }
export function listActions(root: string): ActionProposal[] {
  const file = actionsFile(root);
  if (!existsSync(file)) return [];
  try { const data = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(data) ? data as ActionProposal[] : []; }
  catch { return []; }
}
function saveActions(root: string, items: ActionProposal[]): void {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  writeFileSync(actionsFile(root), JSON.stringify(items, null, 2), { mode: 0o600 });
}
export function proposeAction(root: string, input: { actor: string; kind: string; title: string; detail: string }): ActionProposal {
  if (!KINDS.includes(input.kind as ActionKind)) throw new Error("Invalid action kind");
  const title = (input.title ?? "").trim();
  const detail = (input.detail ?? "").trim();
  if (!title || title.length > 200) throw new Error("Invalid action title");
  if (!detail || detail.length > 4000) throw new Error("Invalid action detail");
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.actor) && input.actor !== "sam") throw new Error("Invalid actor");
  const item: ActionProposal = {
    id: randomUUID(), actor: input.actor, kind: input.kind as ActionKind, title, detail,
    status: "pending", createdAt: new Date().toISOString(), decidedAt: null, result: null,
  };
  const items = listActions(root); items.push(item); saveActions(root, items);
  recordActivity(root, input.actor, "proposal", "Proposed " + item.kind + ": " + title);
  return item;
}
function execute(root: string, a: ActionProposal): string {
  if (a.kind === "note") {
    const store = new MemoryStore(join(resolve(root), ".sam", "missions.db"));
    try {
      const scope = a.actor === "sam" ? "core" : "profile:" + a.actor;
      const rec = store.add({ kind: "observation", content: a.detail, source: "owner-approved action " + a.id, scope });
      return "Memory note saved (" + rec.id + ")";
    } finally { store.close(); }
  }
  if (a.kind === "law") {
    const store = new PreferenceStore(root);
    try { store.note(a.actor, a.detail, "rule", "owner-approved action " + a.id); return "Standing law set for " + a.actor; }
    finally { store.close(); }
  }
  if (a.kind === "heartbeat") {
    const spec = JSON.parse(a.detail) as { name: string; minutes: number; profile: string; prompt: string; channelId?: string | null };
    const job = addHeartbeatJob(root, spec.name, Number(spec.minutes), spec.profile, spec.prompt, spec.channelId ?? null);
    return "Heartbeat job created (" + job.id + ")";
  }
  const spec = JSON.parse(a.detail) as { chatId: string; text: string };
  const db = new ChatStore(root);
  try { db.add(spec.chatId, "assistant", spec.text); return "Message posted to chat " + spec.chatId; }
  finally { db.close(); }
}
export function decideAction(root: string, id: string, approve: boolean): ActionProposal {
  const items = listActions(root);
  const a = items.find(x => x.id === id);
  if (!a) throw new Error("Unknown action");
  if (a.status !== "pending") throw new Error("Action already decided");
  a.decidedAt = new Date().toISOString();
  if (!approve) {
    a.status = "rejected"; a.result = "Rejected by owner";
    saveActions(root, items);
    recordActivity(root, "owner", "rejected", a.kind + ": " + a.title);
    return a;
  }
  try { a.result = execute(root, a); a.status = "done"; }
  catch (e) { a.status = "failed"; a.result = e instanceof Error ? e.message : "Execution failed"; }
  saveActions(root, items);
  recordActivity(root, "owner", a.status === "done" ? "approved" : "failed", a.kind + ": " + a.title + " - " + (a.result ?? ""));
  return a;
}
