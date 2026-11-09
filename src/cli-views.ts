import { ChatStore } from "./chats.js";
import { listActions, type ActionProposal } from "./actions.js";
import { readActivity, type ActivityLine } from "./activity.js";
import { heartbeatJobs, type HeartbeatJob } from "./heartbeat.js";
import { minis } from "./minis.js";
import { connectors } from "./connectors.js";

// CLI-first (Dip's rule): every capability lands on the CLI as a complete,
// scriptable operation before any surface rides on it. These views are the
// read models behind the CLI commands - the same shapes the dashboard shows,
// so the terminal, the dashboard, and a script all read one truth.
export function activityView(root: string, opts: { limit?: number; actor?: string; kind?: string } = {}): ActivityLine[] {
  let lines = readActivity(root, 500);
  if (opts.actor) lines = lines.filter(l => l.actor === opts.actor);
  if (opts.kind) lines = lines.filter(l => l.kind === opts.kind);
  return lines.slice(-(opts.limit ?? 20));
}
export function actionsView(root: string, opts: { pending?: boolean; chat?: string; actor?: string } = {}): ActionProposal[] {
  let items = listActions(root);
  if (opts.pending) items = items.filter(a => a.status === "pending");
  if (opts.chat) items = items.filter(a => a.chatId === opts.chat);
  if (opts.actor) items = items.filter(a => a.actor === opts.actor);
  return items;
}
export function chatView(root: string, chatId: string): { messages: unknown; actions: ActionProposal[] } {
  const db = new ChatStore(root);
  try { return { messages: db.messages(chatId), actions: listActions(root).filter(a => a.chatId === chatId) }; }
  finally { db.close(); }
}
export function turnActions(root: string, chatId: string, sinceISO: string): ActionProposal[] {
  return listActions(root).filter(a => a.chatId === chatId && a.createdAt >= sinceISO);
}
export function statusSnapshot(root: string): {
  at: string; pendingActions: ActionProposal[]; activity: ActivityLine[];
  heartbeatJobs: HeartbeatJob[]; people: string[];
  connectors: Array<{ name: string; enabled: boolean; credentialPresent: boolean }>;
} {
  return {
    at: new Date().toISOString(),
    pendingActions: listActions(root).filter(a => a.status === "pending"),
    activity: readActivity(root, 10),
    heartbeatJobs: heartbeatJobs(root),
    people: minis(root).map(m => m.name),
    connectors: connectors(root).map(c => ({ name: c.name, enabled: c.enabled, credentialPresent: !!process.env[c.tokenEnv] })),
  };
}
