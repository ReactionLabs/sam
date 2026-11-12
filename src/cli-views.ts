import { ChatStore } from "./chats.js";
import { listActions, type ActionProposal } from "./actions.js";
import { readActivity, type ActivityLine } from "./activity.js";
import { buildStatusPayload } from "./status.js";

// CLI-first (Dip's rule): every capability lands on the CLI as a complete,
// scriptable operation before any surface rides on it. These views are the
// read models behind the CLI commands - the same shapes the dashboard shows,
// so the terminal, the dashboard, and a script all read one truth.
export function activityView(root: string, opts: { limit?: number; actor?: string; kind?: string } = {}): ActivityLine[] {
  return readActivity(root, opts.limit ?? 20, { actor: opts.actor, kind: opts.kind });
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
/** CLI overview. The same payload the dashboard route /api/status returns. */
export function statusSnapshot(root: string) {
  return buildStatusPayload(root);
}
