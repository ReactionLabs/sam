import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { ChatStore } from "./chats.js";
import { recordActivity } from "./activity.js";
import { runChatTurn } from "./agent-turn.js";
import { readDashboardConfig } from "./dashboard-config.js";
import type { SteerProvider } from "./budgets.js";

// Message bursts (Defect 2, Dip 2026-11-14: "i want to be able to fire
// as many messages as i need to. Think about how i use u").
// The owner talks in bursts: short messages seconds apart, corrections
// mid-flight, outright neverminds, topic jumps. The old dashboard
// refused a second message while a turn ran (HTTP 409) and the
// composer silently swallowed it, so exactly those follow-ups were
// lost. This module is the queue every owner surface writes to
// instead: a message is accepted at any time, busy or not, and is
// never dropped silently - it is accounted for in this store and in
// the chat transcript.
//
// Semantics, deterministic (control words are code, not model):
// - a burst that lands before a turn starts folds into that turn: the
//   first item is the turn's message, the rest ride as burst rows
//   (consecutive user messages, arrival order, the latest governing);
// - a message that lands mid-turn is taken at the next tool-round
//   boundary and steers the running turn (the loop ledgers one
//   message-steer line per batch);
// - a nevermind drops the most recent still-queued message (both are
//   ledgered; the neverminded item does no work);
// - a stop cancels the running turn at its next round boundary (or
//   drops the whole queue when no turn is running);
// - the queue drains in order, automatically - no re-send, ever.
// One drain per chat per process; the claim row is the cross-restart
// record, and a claim older than the stale window may be taken over.

export type QueueItemStatus = "queued" | "folded" | "steered" | "dropped" | "consumed" | "failed";
export interface QueueItem {
  id: string; chatId: string; content: string; source: string;
  status: QueueItemStatus; createdAt: string; settledAt: string | null;
}

const STALE_CLAIM_MS = 15 * 60 * 1000;
const NEVERMIND_RE = /^\s*(nevermind|never mind|nvm|forget it|scratch that)\b/i;
const STOP_RE = /^\s*(stop|halt|cancel)(\s+(it|that|everything|now))?\s*[.!]?\s*$/i;

function dbFile(root: string): string { return join(resolve(root), ".sam", "chat-queue.db"); }
function openStore(root: string): Database.Database {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  const db = openDatabase(dbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS queue_items (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, settled_at TEXT);" +
    "CREATE TABLE IF NOT EXISTS turn_claims (chat_id TEXT PRIMARY KEY, token TEXT NOT NULL, claimed_at TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0);");
  return db;
}
function rowToItem(row: Record<string, unknown>): QueueItem {
  return {
    id: String(row.id), chatId: String(row.chat_id), content: String(row.content), source: String(row.source),
    status: String(row.status) as QueueItemStatus, createdAt: String(row.created_at),
    settledAt: row.settled_at === null || row.settled_at === undefined ? null : String(row.settled_at),
  };
}
function actorForChat(root: string, chatId: string): string {
  try {
    const db = new ChatStore(root);
    try { return db.list().find(c => c.id === chatId)?.agent_name ?? readDashboardConfig(root).defaultAgent ?? "sam"; }
    finally { db.close(); }
  } catch { return "sam"; }
}
function ledger(root: string, actor: string, kind: string, summary: string): void {
  try { recordActivity(root, actor, kind, summary); } catch { /* the ledger never breaks the queue */ }
}

export function listChatQueue(root: string, chatId: string, limit = 12): QueueItem[] {
  const db = openStore(root);
  try {
    const rows = db.prepare("SELECT * FROM queue_items WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(chatId, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToItem).reverse();
  } finally { db.close(); }
}
function queuedItems(root: string, chatId: string): QueueItem[] {
  const db = openStore(root);
  try {
    const rows = db.prepare("SELECT * FROM queue_items WHERE chat_id = ? AND status = 'queued' ORDER BY created_at, rowid").all(chatId) as Array<Record<string, unknown>>;
    return rows.map(rowToItem);
  } finally { db.close(); }
}
/** Take every queued item for the chat, in arrival order, marking them
 *  with the given settled status (folded into a starting turn, or
 *  steered into a running one). */
function takeQueued(root: string, chatId: string, as: "folded" | "steered"): QueueItem[] {
  const db = openStore(root);
  try {
    const now = new Date().toISOString();
    return db.transaction(() => {
      const rows = db.prepare("SELECT * FROM queue_items WHERE chat_id = ? AND status = 'queued' ORDER BY created_at, rowid").all(chatId) as Array<Record<string, unknown>>;
      const items = rows.map(rowToItem);
      const mark = db.prepare("UPDATE queue_items SET status = ?, settled_at = ? WHERE id = ?");
      for (const item of items) mark.run(as, now, item.id);
      return items.map(item => ({ ...item, status: as, settledAt: now }));
    })();
  } finally { db.close(); }
}
function setStatus(root: string, id: string, status: QueueItemStatus): void {
  const db = openStore(root);
  try { db.prepare("UPDATE queue_items SET status = ?, settled_at = ? WHERE id = ?").run(status, new Date().toISOString(), id); }
  finally { db.close(); }
}
function claimRow(root: string, chatId: string): { claimedAt: string; cancelRequested: boolean } | null {
  const db = openStore(root);
  try {
    const row = db.prepare("SELECT claimed_at, cancel_requested FROM turn_claims WHERE chat_id = ?").get(chatId) as { claimed_at: string; cancel_requested: number } | undefined;
    return row ? { claimedAt: row.claimed_at, cancelRequested: row.cancel_requested === 1 } : null;
  } finally { db.close(); }
}
export function chatTurnActive(root: string, chatId: string): boolean {
  if (drainsInFlight.has(chatId)) return true;
  const claim = claimRow(root, chatId);
  return !!claim && Date.now() - new Date(claim.claimedAt).getTime() < STALE_CLAIM_MS;
}

export interface EnqueueResult { id: string; status: QueueItemStatus; effect?: "nevermind" | "stop" }

/** Accept one owner message. Always accepted; the return says how it
 *  was accounted for. Control messages (nevermind / stop) are consumed
 *  by the queue itself and never reach a turn as work. */
export function enqueueChatMessage(root: string, input: { chatId: string; content: string; source?: string }): EnqueueResult {
  const actor = actorForChat(root, input.chatId);
  const id = randomUUID();
  const now = new Date().toISOString();
  const source = input.source ?? "api";
  const db = openStore(root);
  try {
    if (NEVERMIND_RE.test(input.content)) {
      const target = db.prepare("SELECT id FROM queue_items WHERE chat_id = ? AND status = 'queued' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(input.chatId) as { id: string } | undefined;
      db.prepare("INSERT INTO queue_items (id, chat_id, content, source, status, created_at, settled_at) VALUES (?, ?, ?, ?, 'consumed', ?, ?)").run(id, input.chatId, input.content, source, now, now);
      if (target) db.prepare("UPDATE queue_items SET status = 'dropped', settled_at = ? WHERE id = ?").run(now, target.id);
      ledger(root, actor, "message-nevermind", target
        ? "Owner neverminded a queued message in chat " + input.chatId.slice(0, 8) + "; the queued message was dropped before doing any work"
        : "Owner sent a nevermind in chat " + input.chatId.slice(0, 8) + " with nothing queued to drop");
      return { id, status: "consumed", effect: "nevermind" };
    }
    if (STOP_RE.test(input.content)) {
      db.prepare("INSERT INTO queue_items (id, chat_id, content, source, status, created_at, settled_at) VALUES (?, ?, ?, ?, 'consumed', ?, ?)").run(id, input.chatId, input.content, source, now, now);
      const claim = db.prepare("SELECT chat_id FROM turn_claims WHERE chat_id = ?").get(input.chatId);
      if (claim) {
        db.prepare("UPDATE turn_claims SET cancel_requested = 1 WHERE chat_id = ?").run(input.chatId);
        ledger(root, actor, "message-stop", "Owner said stop in chat " + input.chatId.slice(0, 8) + "; the running turn was asked to close at its next step");
      } else {
        const dropped = db.prepare("UPDATE queue_items SET status = 'dropped', settled_at = ? WHERE chat_id = ? AND status = 'queued'").run(now, input.chatId);
        ledger(root, actor, "message-stop", "Owner said stop in chat " + input.chatId.slice(0, 8) + " with no turn running; " + dropped.changes + " queued message(s) dropped");
      }
      return { id, status: "consumed", effect: "stop" };
    }
    db.prepare("INSERT INTO queue_items (id, chat_id, content, source, status, created_at, settled_at) VALUES (?, ?, ?, ?, 'queued', ?, NULL)").run(id, input.chatId, input.content, source, now);
  } finally { db.close(); }
  kickChatDrain(root, input.chatId);
  return { id, status: "queued" };
}

/** The steer provider a running turn polls at its round boundaries:
 *  hands the loop whatever queued while it worked (persisting those
 *  messages to the chat first, so the transcript order is the arrival
 *  order) plus the owner's stop flag when one is set. */
function makeSteerProvider(root: string, chatId: string): SteerProvider {
  return () => {
    const db = openStore(root);
    let cancel = false;
    try {
      const row = db.prepare("SELECT cancel_requested FROM turn_claims WHERE chat_id = ?").get(chatId) as { cancel_requested: number } | undefined;
      cancel = row?.cancel_requested === 1;
      if (cancel) db.prepare("UPDATE turn_claims SET cancel_requested = 0 WHERE chat_id = ?").run(chatId);
    } finally { db.close(); }
    const items = takeQueued(root, chatId, "steered");
    if (items.length) {
      const store = new ChatStore(root);
      try { for (const item of items) store.add(chatId, "user", item.content, item.source); }
      finally { store.close(); }
    }
    if (!items.length && !cancel) return null;
    return { contents: items.map(item => item.content), cancel };
  };
}

const drainsInFlight = new Set<string>();

/** Start the chat's drain if it is not already running in this
 *  process. Fire-and-forget by design: surfaces return immediately
 *  and watch the queue through the chat payload. */
export function kickChatDrain(root: string, chatId: string): void {
  if (drainsInFlight.has(chatId)) return;
  void drainChatQueue(root, chatId).catch(() => { /* a drain failure is ledgered per turn; the queue rows remain */ });
}

/** Run turns until the chat's queue is empty. One claim per chat;
 *  each iteration folds everything queued into one turn, then loops
 *  (messages that arrived during the turn run as the next turn
 *  automatically - no re-send). */
export async function drainChatQueue(root: string, chatId: string): Promise<void> {
  if (drainsInFlight.has(chatId)) return;
  drainsInFlight.add(chatId);
  const db = openStore(root);
  try {
    db.prepare("INSERT INTO turn_claims (chat_id, token, claimed_at, cancel_requested) VALUES (?, ?, ?, 0) ON CONFLICT(chat_id) DO UPDATE SET token = excluded.token, claimed_at = excluded.claimed_at")
      .run(chatId, randomUUID(), new Date().toISOString());
  } finally { db.close(); }
  try {
    for (;;) {
      const items = takeQueued(root, chatId, "folded");
      if (!items.length) break;
      const actor = actorForChat(root, chatId);
      if (items.length > 1) ledger(root, actor, "message-fold", items.length + " owner messages folded into one turn in chat " + chatId.slice(0, 8) + ", in arrival order; the latest governs");
      try {
        await runChatTurn(root, chatId, items[0].content, {
          source: items[0].source,
          burst: items.slice(1).map(item => item.content),
          steer: makeSteerProvider(root, chatId),
        });
      } catch {
        // runChatTurn already ledgered the failure (turn-failed); the
        // queue rows are marked failed so the surface shows them as
        // accounted-for, never silently gone.
        for (const item of items) setStatus(root, item.id, "failed");
        ledger(root, actor, "message-failed", "A queued turn in chat " + chatId.slice(0, 8) + " failed; its " + items.length + " message(s) are marked failed in the queue, not lost");
      }
    }
  } finally {
    // Release the claim only when the queue is truly drained; the
    // recheck closes the enqueue-during-release race.
    const remaining = queuedItems(root, chatId).length;
    if (!remaining) {
      const release = openStore(root);
      try { release.prepare("DELETE FROM turn_claims WHERE chat_id = ?").run(chatId); }
      finally { release.close(); }
    }
    drainsInFlight.delete(chatId);
    if (remaining) kickChatDrain(root, chatId);
  }
}

/** Dashboard startup: resume drains for chats whose queued messages
 *  outlived a restart. Returns the chats resumed. */
export function resumeChatQueues(root: string): string[] {
  const db = openStore(root);
  let chatIds: string[] = [];
  try {
    chatIds = (db.prepare("SELECT DISTINCT chat_id FROM queue_items WHERE status = 'queued'").all() as Array<{ chat_id: string }>).map(r => r.chat_id);
  } finally { db.close(); }
  for (const chatId of chatIds) kickChatDrain(root, chatId);
  return chatIds;
}

/** Test/harness helper: resolve when the chat has no queued items and
 *  no drain in flight in this process. */
export async function awaitChatQueue(root: string, chatId: string, timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!drainsInFlight.has(chatId) && queuedItems(root, chatId).length === 0) return;
    if (Date.now() - start > timeoutMs) throw new Error("Chat queue did not drain in " + timeoutMs + "ms");
    await new Promise(r => setTimeout(r, 25));
  }
}
