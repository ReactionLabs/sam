import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { ChatStore } from "./chats.js";
import { readActivity, recordActivity } from "./activity.js";
import { runChatTurn } from "./agent-turn.js";
import { readDashboardConfig } from "./dashboard-config.js";
import { abortChatTurnRequests, bumpTurnGeneration, createTurnControl, OWNER_TURN_DEADLINE_MS } from "./turn-control.js";
import { chatQueueTouch, chatQueueTouchAsync } from "./chat-queue-failure.js";
import { errorReason } from "./telegram.js";
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

export type QueueItemStatus = "queued" | "folded" | "steered" | "dropped" | "consumed" | "failed" | "cancelled";
export interface QueueItem {
  id: string; chatId: string; content: string; source: string;
  status: QueueItemStatus; createdAt: string; settledAt: string | null;
  // The chat_messages row this item's turn saved for it, stamped
  // at save time (chat trust sprint, Item 3). The link is what
  // lets a surface decorate the send's own bubble with its queue
  // state - and resend it - instead of rendering the send twice.
  // NULL on rows that predate the column.
  messageId: string | null;
}

const STALE_CLAIM_MS = 15 * 60 * 1000;
const NEVERMIND_RE = /^\s*(nevermind|never mind|nvm|forget it|scratch that)\b/i;
const STOP_RE = /^\s*(stop|halt|cancel)(\s+(it|that|everything|now))?\s*[.!]?\s*$/i;

// The fast status lane (Dip, 2026-11-14): while a turn runs, a
// short message that is plainly the owner checking whether Sam
// is stuck must be answered by the RUNTIME, immediately, from
// queue/claim/activity state - never folded into the very turn
// it asks about, where it would wait minutes for a status it
// needed in seconds. The matcher is deliberately narrow and
// deterministic: a short message, whole-text, from the owner's
// own recorded phrasings. Anything ambiguous is not a status
// check and follows the normal steer path.
const STATUS_RES: readonly RegExp[] = [
  /^(are|r)\s+(you|u)\s+(stuck|working|ok|okay|alive|there)$/,
  /^(you|u)\s+(seem|look)\s+stuck\b/,
  /^(are|r)\s+(you|u)\s+still\s+(working|there)$/,
  /^what'?s\s+happening$/,
  /^what\s+is\s+happening$/,
  /^(do|did)\s+(you|u)\s+see\s+what\s+happ\w+$/,
  /^you\s+there$/,
  /^still\s+there$/,
  /^hello$/,
];
export function isStatusCheck(content: string): boolean {
  const t = content.trim().toLowerCase().replace(/\s+/g, " ").replace(/[!.,]+$/, "").replace(/\?+$/, "").trim();
  if (!t || t.length > 48) return false;
  return STATUS_RES.some(re => re.test(t));
}
function formatRunDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
}
/** The runtime's own status answer: how long the turn has run,
 *  the last ledger fact naming this chat, and what is queued
 *  behind it. No model call, so it lands in milliseconds. */
function statusReplyFor(root: string, chatId: string): string {
  const claim = claimRow(root, chatId);
  const runningFor = claim ? formatRunDuration(Date.now() - new Date(claim.claimedAt).getTime()) : "a moment";
  const queued = queuedItems(root, chatId).length;
  let lastFact = "";
  try {
    const hit = [...readActivity(root, 80)].reverse().find(l => l.summary.includes(chatId.slice(0, 8)));
    if (hit) lastFact = " Last thing on my record for this chat: " + hit.summary.slice(0, 180) + ".";
  } catch { /* the ledger never breaks the status lane */ }
  return "Still here. Yes, a turn is still running in this chat: it has been going " + runningFor + "." + lastFact +
    (queued ? " " + queued + " message(s) are queued behind it." : "") +
    " If you want it stopped cold, press Reset and I will drop it mid-step.";
}

function dbFile(root: string): string { return join(resolve(root), ".sam", "chat-queue.db"); }
function openStore(root: string): Database.Database {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  const db = openDatabase(dbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS queue_items (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, settled_at TEXT);" +
    "CREATE TABLE IF NOT EXISTS turn_claims (chat_id TEXT PRIMARY KEY, token TEXT NOT NULL, claimed_at TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0);");
  // Chat trust sprint (Item 3): queue_items gained message_id,
  // the chat_messages row a turn saved for the item. Stores that
  // predate the column get it added; their rows read NULL and
  // the surfaces fall back to matching by content, as before.
  const cols = db.prepare("PRAGMA table_info(queue_items)").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === "message_id")) db.exec("ALTER TABLE queue_items ADD COLUMN message_id TEXT");
  return db;
}
function rowToItem(row: Record<string, unknown>): QueueItem {
  return {
    id: String(row.id), chatId: String(row.chat_id), content: String(row.content), source: String(row.source),
    status: String(row.status) as QueueItemStatus, createdAt: String(row.created_at),
    settledAt: row.settled_at === null || row.settled_at === undefined ? null : String(row.settled_at),
    messageId: row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
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

// Queued message failures carry their reason (gap found
// 2026-11-16, hourly run 11:04 EST): the drain catch bound no
// error at all, so every live message-failed line read as the
// bare accounting sentence and named nothing - the class was
// countable but never diagnosable from its own line. The
// reason rides errorReason (the 2026-11-16 04:04 bridge seam,
// cured at turn-failed 09:04): the cause chain is walked
// bounded and deduped, errno-style codes are appended, and
// bot-token segments are redacted, so a queued turn dying on
// transport reads with its cause named. The accounting half
// of the sentence is byte-identical, the composed summary
// caps at 200 like the house failure summaries, and the
// person's message content never enters the line.
export function messageFailedSummary(chatId: string, count: number, error: unknown): string {
  return ("A queued turn in chat " + chatId.slice(0, 8) + " failed: " + errorReason(error) + "; its " + count + " message(s) are marked failed in the queue, not lost").slice(0, 200);
}

export function listChatQueue(root: string, chatId: string, limit = 12): QueueItem[] {
  return chatQueueTouch(root, "read", () => {
    const db = openStore(root);
    try {
      const rows = db.prepare("SELECT * FROM queue_items WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(chatId, limit) as Array<Record<string, unknown>>;
      return rows.map(rowToItem).reverse();
    } finally { db.close(); }
  });
}
function queuedItems(root: string, chatId: string): QueueItem[] {
  return chatQueueTouch(root, "read", () => {
    const db = openStore(root);
    try {
      const rows = db.prepare("SELECT * FROM queue_items WHERE chat_id = ? AND status = 'queued' ORDER BY created_at, rowid").all(chatId) as Array<Record<string, unknown>>;
      return rows.map(rowToItem);
    } finally { db.close(); }
  });
}
/** Take every queued item for the chat, in arrival order, marking them
 *  with the given settled status (folded into a starting turn, or
 *  steered into a running one). */
function takeQueued(root: string, chatId: string, as: "folded" | "steered"): QueueItem[] {
  return chatQueueTouch(root, "write", () => {
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
  });
}
function setStatus(root: string, id: string, status: QueueItemStatus): void {
  chatQueueTouch(root, "write", () => {
    const db = openStore(root);
    try { db.prepare("UPDATE queue_items SET status = ?, settled_at = ? WHERE id = ?").run(status, new Date().toISOString(), id); }
    finally { db.close(); }
  });
}
/** Stamp a queue item with the chat_messages row its turn just
 *  saved (chat trust sprint, Item 3). Called from the two save
 *  seams: the drain's onUserMessageSaved callback for folded
 *  items, and the steer provider below for steered ones. */
function setItemMessageId(root: string, id: string, messageId: string): void {
  chatQueueTouch(root, "write", () => {
    const db = openStore(root);
    try { db.prepare("UPDATE queue_items SET message_id = ? WHERE id = ?").run(messageId, id); }
    finally { db.close(); }
  });
}
function claimRow(root: string, chatId: string): { claimedAt: string; cancelRequested: boolean; token: string } | null {
  return chatQueueTouch(root, "read", () => {
    const db = openStore(root);
    try {
      const row = db.prepare("SELECT claimed_at, cancel_requested, token FROM turn_claims WHERE chat_id = ?").get(chatId) as { claimed_at: string; cancel_requested: number; token: string } | undefined;
      return row ? { claimedAt: row.claimed_at, cancelRequested: row.cancel_requested === 1, token: String(row.token) } : null;
    } finally { db.close(); }
  });
}
export function chatTurnActive(root: string, chatId: string): boolean {
  return chatQueueTouch(root, "read", () => {
    if (drainsInFlight.has(chatId)) return true;
    const claim = claimRow(root, chatId);
    return !!claim && Date.now() - new Date(claim.claimedAt).getTime() < STALE_CLAIM_MS;
  });
}

export interface EnqueueResult { id: string; status: QueueItemStatus; effect?: "nevermind" | "stop" | "status"; reply?: string }

/** Accept one owner message. Always accepted; the return says how it
 *  was accounted for. Control messages (nevermind / stop) are consumed
 *  by the queue itself and never reach a turn as work. A plain status
 *  check during a running turn is answered by the runtime on the
 *  spot (the fast status lane) and likewise never waits on a turn. */
export function enqueueChatMessage(root: string, input: { chatId: string; content: string; source?: string; deadlineMs?: number }): EnqueueResult {
  return chatQueueTouch(root, "write", () => enqueueChatMessageInner(root, input));
}

function enqueueChatMessageInner(root: string, input: { chatId: string; content: string; source?: string; deadlineMs?: number }): EnqueueResult {
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
    if (isStatusCheck(input.content) && chatTurnActive(root, input.chatId)) {
      // Fast status lane: the exchange is persisted as a real
      // user/assistant pair (the owner asked, the runtime
      // answered), the queue item is consumed, and the running
      // turn is not touched.
      const reply = statusReplyFor(root, input.chatId);
      db.prepare("INSERT INTO queue_items (id, chat_id, content, source, status, created_at, settled_at) VALUES (?, ?, ?, ?, 'consumed', ?, ?)").run(id, input.chatId, input.content, source, now, now);
      const store = new ChatStore(root);
      try { store.add(input.chatId, "user", input.content, source); store.add(input.chatId, "assistant", reply); }
      finally { store.close(); }
      ledger(root, actor, "message-status", "Owner status check in chat " + input.chatId.slice(0, 8) + " answered by the runtime while a turn runs; the turn was not disturbed and the model was not called");
      return { id, status: "consumed", effect: "status", reply };
    }
    db.prepare("INSERT INTO queue_items (id, chat_id, content, source, status, created_at, settled_at) VALUES (?, ?, ?, ?, 'queued', ?, NULL)").run(id, input.chatId, input.content, source, now);
  } finally { db.close(); }
  kickChatDrain(root, input.chatId, input.deadlineMs);
  return { id, status: "queued" };
}

/** The steer provider a running turn polls at its round boundaries:
 *  hands the loop whatever queued while it worked (persisting those
 *  messages to the chat first, so the transcript order is the arrival
 *  order) plus the owner's stop flag when one is set. */
function makeSteerProvider(root: string, chatId: string): SteerProvider {
  return () => chatQueueTouch(root, "write", () => {
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
      try { for (const item of items) { const added = store.add(chatId, "user", item.content, item.source); setItemMessageId(root, item.id, added.id); } }
      finally { store.close(); }
    }
    if (!items.length && !cancel) return null;
    return { contents: items.map(item => item.content), cancel };
  });
}

const drainsInFlight = new Set<string>();

/** Start the chat's drain if it is not already running in this
 *  process. Fire-and-forget by design: surfaces return immediately
 *  and watch the queue through the chat payload. */
export function kickChatDrain(root: string, chatId: string, deadlineMs?: number): void {
  if (drainsInFlight.has(chatId)) return;
  void drainChatQueue(root, chatId, deadlineMs === undefined ? undefined : { deadlineMs }).catch(() => { /* a drain failure is ledgered per turn; the queue rows remain */ });
}

/** Run turns until the chat's queue is empty. One claim per chat;
 *  each iteration folds everything queued into one turn, then loops
 *  (messages that arrived during the turn run as the next turn
 *  automatically - no re-send). */
export async function drainChatQueue(root: string, chatId: string, opts?: { deadlineMs?: number }): Promise<void> {
  return chatQueueTouchAsync(root, "write", () => drainChatQueueInner(root, chatId, opts));
}

async function drainChatQueueInner(root: string, chatId: string, opts?: { deadlineMs?: number }): Promise<void> {
  if (drainsInFlight.has(chatId)) return;
  drainsInFlight.add(chatId);
  const claimToken = randomUUID();
  const db = openStore(root);
  try {
    db.prepare("INSERT INTO turn_claims (chat_id, token, claimed_at, cancel_requested) VALUES (?, ?, ?, 0) ON CONFLICT(chat_id) DO UPDATE SET token = excluded.token, claimed_at = excluded.claimed_at")
      .run(chatId, claimToken, new Date().toISOString());
  } finally { db.close(); }
  try {
    for (;;) {
      const items = takeQueued(root, chatId, "folded");
      if (!items.length) break;
      const actor = actorForChat(root, chatId);
      if (items.length > 1) ledger(root, actor, "message-fold", items.length + " owner messages folded into one turn in chat " + chatId.slice(0, 8) + ", in arrival order; the latest governs");
      try {
        // Every queue turn rides a turn control scoped to this
        // drain's claim: the interactive deadline, and reset
        // invalidation the moment the claim token stops matching.
        const control = createTurnControl(root, chatId, { claimToken, deadlineMs: opts?.deadlineMs ?? OWNER_TURN_DEADLINE_MS });
        // Chat trust sprint (Item 3): an item that already has
        // its message row (a resent failed send) re-drives over
        // that row - the turn reuses it and no second copy of
        // the same words is ever saved; a burst item with a row
        // is likewise already in the transcript the turn reads,
        // so it is not re-added either. Fresh items are stamped
        // with the row their turn saves, in the order the turn
        // reports the saves (primary first, then burst rows).
        const stampTargets = items.filter(item => !item.messageId);
        let stampIndex = 0;
        await runChatTurn(root, chatId, items[0].content, {
          source: items[0].source,
          burst: items.slice(1).filter(item => !item.messageId).map(item => item.content),
          steer: makeSteerProvider(root, chatId),
          control,
          existingUserMessageId: items[0].messageId ?? undefined,
          onUserMessageSaved: (messageId) => {
            const target = stampTargets[stampIndex++];
            if (target) setItemMessageId(root, target.id, messageId);
          },
        });
      } catch (e) {
        // runChatTurn already ledgered the failure (turn-failed); the
        // queue rows are marked failed so the surface shows them as
        // accounted-for, never silently gone. The queue's own line
        // carries the reason too (gap found 2026-11-16, hourly run
        // 11:04 EST): all 6 live message-failed lines named nothing
        // at all, so the class was countable but diagnosable only
        // by correlating timestamps with the turn-failed sibling.
        for (const item of items) setStatus(root, item.id, "failed");
        ledger(root, actor, "message-failed", messageFailedSummary(chatId, items.length, e));
      }
    }
  } finally {
    // Release the claim only when the queue is truly drained; the
    // recheck closes the enqueue-during-release race. The delete
    // matches this drain's token: a reset (or a successor drain)
    // that replaced the claim is never undone by this release.
    const remaining = queuedItems(root, chatId).length;
    if (!remaining) {
      const release = openStore(root);
      try { release.prepare("DELETE FROM turn_claims WHERE chat_id = ? AND token = ?").run(chatId, claimToken); }
      finally { release.close(); }
    }
    drainsInFlight.delete(chatId);
    if (remaining) kickChatDrain(root, chatId);
  }
}

export const TURN_RESET_MESSAGE = "I stopped that turn. Nothing was deleted. Send the next message when you are ready.";
export interface ChatResetResult { wasActive: boolean; ranForMs: number | null; cancelledQueued: number; abortedRequests: number }

/** The Reset button (Dip, 2026-11-14: "we need to be able to
 *  stop that"). One press, effective immediately, in this order:
 *  the chat's turn generation bumps (every running turn is
 *  invalid wherever it executes, and its late reply can never
 *  save), the in-flight model request is aborted through the
 *  per-chat registry, the claim is deleted (the chat is ready
 *  the moment the press returns, not at the next round
 *  boundary), still-queued messages are cancelled (their rows
 *  stay visible in the chat, struck as cancelled), one plain
 *  status message lands in the transcript, and one turn-reset
 *  line lands in the ledger. Nothing is deleted; the transcript
 *  is preserved. A press with nothing running and nothing
 *  queued is a quiet no-op. */
export function resetChatTurn(root: string, chatId: string): ChatResetResult {
  return chatQueueTouch(root, "write", () => resetChatTurnInner(root, chatId));
}

function resetChatTurnInner(root: string, chatId: string): ChatResetResult {
  const actor = actorForChat(root, chatId);
  const claim = claimRow(root, chatId);
  const wasActive = !!claim || drainsInFlight.has(chatId);
  const ranForMs = claim ? Math.max(0, Date.now() - new Date(claim.claimedAt).getTime()) : null;
  bumpTurnGeneration(root, chatId);
  const abortedRequests = abortChatTurnRequests(chatId);
  const db = openStore(root);
  let cancelledQueued = 0;
  try {
    cancelledQueued = db.transaction(() => {
      db.prepare("DELETE FROM turn_claims WHERE chat_id = ?").run(chatId);
      return db.prepare("UPDATE queue_items SET status = 'cancelled', settled_at = ? WHERE chat_id = ? AND status = 'queued'").run(new Date().toISOString(), chatId).changes;
    })();
  } finally { db.close(); }
  if (wasActive || cancelledQueued > 0) {
    const store = new ChatStore(root);
    try { store.add(chatId, "assistant", TURN_RESET_MESSAGE); }
    finally { store.close(); }
    ledger(root, actor, "turn-reset", "Owner reset chat " + chatId.slice(0, 8) + ": turn stopped" + (ranForMs !== null ? " after " + formatRunDuration(ranForMs) : "") + ", claim released on the press, " + abortedRequests + " in-flight request(s) aborted, " + cancelledQueued + " queued message(s) cancelled; nothing was deleted");
  }
  return { wasActive, ranForMs, cancelledQueued, abortedRequests };
}

/** Resend (chat trust sprint, Item 3): a failed owner message
 *  goes back on the queue AS ITSELF - the same queue item, the
 *  same saved chat_messages row - so the re-driven turn answers
 *  under the original bubble and the transcript never gains a
 *  second copy of the same words. Only a failed item can be
 *  resent; anything else is refused by name. The item's
 *  created_at moves to now: the resend is a new send act, and
 *  the drain takes queued items in arrival order. */
export function resendFailedMessage(root: string, chatId: string, itemId: string): QueueItem {
  const item = chatQueueTouch(root, "write", () => {
    const db = openStore(root);
    try {
      const row = db.prepare("SELECT * FROM queue_items WHERE id = ?").get(itemId) as Record<string, unknown> | undefined;
      if (!row || String(row.chat_id) !== chatId) throw Error("Failed message not found");
      const found = rowToItem(row);
      if (found.status !== "failed") throw Error("Only a failed message can be resent");
      const now = new Date().toISOString();
      db.prepare("UPDATE queue_items SET status = 'queued', settled_at = NULL, created_at = ? WHERE id = ?").run(now, itemId);
      return { ...found, status: "queued" as QueueItemStatus, settledAt: null, createdAt: now };
    } finally { db.close(); }
  });
  ledger(root, actorForChat(root, chatId), "message-resent", "Owner resent a failed message in chat " + chatId.slice(0, 8) + "; the saved message is queued again over its original row - no second copy is saved");
  kickChatDrain(root, chatId);
  return item;
}

/** One send, one bubble (chat trust sprint, Item 1): fold the
 *  queue's view of a chat into its message list before a surface
 *  renders it. A queue item that has its message row - stamped
 *  at save time, or matched here by content, source, and order
 *  for rows that predate the stamp - DECORATES that row with its
 *  status and id, and leaves the queue list: the send renders
 *  exactly once, as its own bubble, wearing its state. Items
 *  with no row in the transcript (still queued, cancelled or
 *  dropped before ever running) stay in the queue list and
 *  render as themselves, once. Matching is consumption-ordered:
 *  items are processed in arrival order and each message row
 *  takes at most one decoration, so two identical sends in a
 *  row each land on their own bubble. */
export function mergeQueueIntoMessages<T extends { id: string; role: string; content: string; source?: unknown; created_at: string }>(
  messages: T[], queue: QueueItem[],
): { messages: Array<T & { queueStatus?: QueueItemStatus; queueId?: string }>; queue: QueueItem[] } {
  const byId = new Map(messages.map((m, i) => [m.id, i] as const));
  const matched = new Set<string>();
  const decorated = messages.map(m => ({ ...m })) as Array<T & { queueStatus?: QueueItemStatus; queueId?: string }>;
  const remaining: QueueItem[] = [];
  const attach = (index: number, item: QueueItem): void => {
    matched.add(messages[index].id);
    if (item.status === "queued" || item.status === "failed" || item.status === "steered" || item.status === "cancelled") {
      decorated[index].queueStatus = item.status;
      decorated[index].queueId = item.id;
    }
  };
  for (const item of queue) {
    if (item.messageId) {
      const index = byId.get(item.messageId);
      if (index !== undefined && !matched.has(messages[index].id)) { attach(index, item); continue; }
      // The stamped row is outside this message list: a send
      // still waiting or failed must surface once, from its
      // queue row, rather than vanish.
      if (item.status === "failed" || item.status === "queued") remaining.push(item);
      continue;
    }
    if (item.status === "failed" || item.status === "steered") {
      const index = decorated.findIndex((m, i) => !matched.has(messages[i].id) && m.role === "user" && m.content === item.content && String(m.source ?? "") === item.source && m.created_at >= item.createdAt);
      if (index >= 0) { attach(index, item); continue; }
    }
    remaining.push(item);
  }
  return { messages: decorated, queue: remaining };
}

/** Dashboard startup: resume drains for chats whose queued messages
 *  outlived a restart. Returns the chats resumed. */
export function resumeChatQueues(root: string): string[] {
  const chatIds = chatQueueTouch(root, "read", () => {
    const db = openStore(root);
    try {
      return (db.prepare("SELECT DISTINCT chat_id FROM queue_items WHERE status = 'queued'").all() as Array<{ chat_id: string }>).map(r => r.chat_id);
    } finally { db.close(); }
  });
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
