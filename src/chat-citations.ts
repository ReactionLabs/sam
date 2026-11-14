import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDatabase } from "./sqlite.js";
import { ChatStore } from "./chats.js";
import { isManagedChat, type ChatSearchHit } from "./chat-manage.js";
import { recordActivity } from "./activity.js";

/**
 * Clickable chat-history citations (GitHub issue #92, Dip 2026-11-14).
 *
 * When a reply draws on an earlier conversation found through
 * sam_search_chats, the reply can carry ONE compact "Found in chat
 * history" citation beneath it, the way a Perplexity answer cites a
 * source - except SAM's sources are its own chats, and a citation is
 * only real when the system can prove it.
 *
 * The trust shape, enforced here and nowhere else:
 * - The ONLY citable sources are the hits chat search actually
 *   returned during THAT reply's run. executeOwnTool records them
 *   in the run registry below, keyed by the turn's chat + user
 *   message, and the turn consumes them exactly once.
 * - The model SELECTS a source by ending its reply with a marker,
 *   [[cite:<messageId>]]. The turn validates the named message id
 *   against the run's recorded hits: an id that is not among them
 *   (fabricated, stale, or from another turn) attaches NOTHING, the
 *   marker is stripped from the visible reply either way, and the
 *   rejection is ledgered so the class stays countable. A search
 *   that merely ran is never itself a citation - no marker, no
 *   citation, however good the hits were.
 * - Resolution re-checks access at READ time, not attach time: the
 *   source chat must still exist, still be a managed chat of the
 *   profile that produced the reply, not be archived, and still
 *   hold the cited message. Anything else resolves as "source
 *   unavailable" and exposes nothing about the source's contents.
 *
 * Citation plumbing never breaks a turn: every failure on the
 * attach path ledgers one chat-citation-failed line and reports
 * failure to the caller, which carries on without a citation.
 */

export const CITATION_GUIDANCE =
  "If your reply uses one of these chat-history hits, cite it: end your reply with the marker [[cite:MESSAGE_ID]], copying the messageId of the one hit you actually used (exactly one marker, on its own line). The marker is removed before the reply is shown and becomes a 'Found in chat history' link. Only cite a hit from this result - a marker naming anything else is rejected and attaches nothing. If you did not use a hit, add no marker.";

export interface StoredCitation {
  messageId: string;
  chatId: string;
  actor: string;
  sourceChatId: string;
  sourceMessageId: string;
  sourceTitle: string;
  createdAt: string;
}

export interface ResolvedCitation {
  sourceChatId: string;
  sourceMessageId: string;
  sourceTitle: string;
  available: boolean;
}

// ----------------------------------------------------------------
// Run registry: the hits one reply's run actually produced.
// In-process on purpose - a citation can only ever point at a hit
// from the run that is still being answered, so nothing here needs
// to survive a restart or be readable by another process.
// ----------------------------------------------------------------

const runHits = new Map<string, ChatSearchHit[]>();
const RUN_HITS_KEY_CAP = 100;
const RUN_HITS_PER_KEY_CAP = 60;

function runKey(chatId: string, userMessageId: string): string {
  return chatId + "|" + userMessageId;
}

export function recordSearchHits(chatId: string, userMessageId: string, hits: ChatSearchHit[]): void {
  if (!chatId || !userMessageId || !hits.length) return;
  const key = runKey(chatId, userMessageId);
  const existing = runHits.get(key) ?? [];
  existing.push(...hits);
  runHits.set(key, existing.slice(-RUN_HITS_PER_KEY_CAP));
  // Bounded like every run-scoped structure: an abandoned turn's
  // hits age out instead of accumulating for the process's life.
  while (runHits.size > RUN_HITS_KEY_CAP) {
    const oldest = runHits.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    runHits.delete(oldest);
  }
}

export function consumeSearchHits(chatId: string, userMessageId: string): ChatSearchHit[] {
  const key = runKey(chatId, userMessageId);
  const hits = runHits.get(key) ?? [];
  runHits.delete(key);
  return hits;
}

// ----------------------------------------------------------------
// The model's marker: [[cite:<messageId>]]. Extraction always
// strips markers from the visible text - a marker is plumbing,
// never something the owner should read, cited or not.
// ----------------------------------------------------------------

const CITE_MARKER = /\[\[cite:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]\]/g;

export function extractCitationMarkers(text: string): { text: string; messageIds: string[] } {
  const messageIds: string[] = [];
  const stripped = text.replace(CITE_MARKER, (_m, id: string) => { messageIds.push(id); return ""; });
  // A marker that sat on its own line leaves a husk of blank lines
  // at the end of the reply; trim the tail back to the real text.
  return { text: messageIds.length ? stripped.replace(/\s+$/, "") : text, messageIds };
}

export function validateCitation(hits: ChatSearchHit[], messageId: string): ChatSearchHit | null {
  return hits.find(h => h.messageId === messageId) ?? null;
}

export interface ProcessedReply {
  text: string;
  hit: ChatSearchHit | null;
  rejected: boolean;
}

/**
 * The turn's one citation pass over a finished reply: consume the
 * run's recorded hits, strip any markers, and validate the model's
 * selection against the hits. A marker naming a source outside the
 * run's results is a fabrication shape - it attaches nothing and
 * ledgers one citation-rejected line (never the reply text, never
 * the claimed id's target, which may not exist at all).
 */
export function processReplyCitations(root: string, input: { chatId: string; userMessageId: string | null; actor: string; text: string }): ProcessedReply {
  const hits = input.userMessageId ? consumeSearchHits(input.chatId, input.userMessageId) : [];
  const { text, messageIds } = extractCitationMarkers(input.text);
  if (!messageIds.length) return { text, hit: null, rejected: false };
  const hit = validateCitation(hits, messageIds[0]);
  if (hit) return { text, hit, rejected: false };
  recordActivity(root, input.actor, "citation-rejected",
    "Citation rejected in chat " + input.chatId.slice(0, 8) + ": the reply's marker named a source outside this run's chat-search results (" + hits.length + " hit(s) recorded); no citation attached");
  return { text, hit: null, rejected: true };
}

// ----------------------------------------------------------------
// The store: one row per cited reply, keyed by the reply's own
// message id. .sam/chat-citations.db through openDatabase, the
// F1 store discipline like every other store.
// ----------------------------------------------------------------

function citationsDbFile(root: string): string {
  return join(resolve(root), ".sam", "chat-citations.db");
}

export function chatCitationFailureSummary(phase: string, error: unknown): string {
  const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160);
  return "Chat citation " + phase + " failed: " + reason;
}

function recordCitationFailure(root: string, actor: string, phase: string, error: unknown): void {
  try { recordActivity(root, actor, "chat-citation-failed", chatCitationFailureSummary(phase, error)); } catch { /* the ledger never breaks a turn */ }
}

export function attachCitation(root: string, input: { messageId: string; chatId: string; actor: string; hit: ChatSearchHit }): boolean {
  try {
    mkdirSync(join(resolve(root), ".sam"), { recursive: true });
    const db = openDatabase(citationsDbFile(root));
    try {
      db.exec("CREATE TABLE IF NOT EXISTS chat_citations (message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, actor TEXT NOT NULL, source_chat_id TEXT NOT NULL, source_message_id TEXT NOT NULL, source_title TEXT NOT NULL, created_at TEXT NOT NULL)");
      db.prepare("INSERT OR REPLACE INTO chat_citations (message_id, chat_id, actor, source_chat_id, source_message_id, source_title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(input.messageId, input.chatId, input.actor, input.hit.chatId, input.hit.messageId, input.hit.title, new Date().toISOString());
    } finally { db.close(); }
    return true;
  } catch (error) {
    recordCitationFailure(root, input.actor, "attach", error);
    return false;
  }
}

interface CitationRow { message_id: string; chat_id: string; actor: string; source_chat_id: string; source_message_id: string; source_title: string; created_at: string }

function rowToStored(row: CitationRow): StoredCitation {
  return { messageId: row.message_id, chatId: row.chat_id, actor: row.actor, sourceChatId: row.source_chat_id, sourceMessageId: row.source_message_id, sourceTitle: row.source_title, createdAt: row.created_at };
}

export function citationForMessage(root: string, messageId: string): StoredCitation | null {
  if (!existsSync(citationsDbFile(root))) return null;
  const db = openDatabase(citationsDbFile(root), { readonly: true });
  try {
    const row = db.prepare("SELECT * FROM chat_citations WHERE message_id = ?").get(messageId) as CitationRow | undefined;
    return row ? rowToStored(row) : null;
  } finally { db.close(); }
}

export function citationsForChat(root: string, chatId: string): StoredCitation[] {
  if (!existsSync(citationsDbFile(root))) return [];
  const db = openDatabase(citationsDbFile(root), { readonly: true });
  try {
    const rows = db.prepare("SELECT * FROM chat_citations WHERE chat_id = ?").all(chatId) as CitationRow[];
    return rows.map(rowToStored);
  } finally { db.close(); }
}

/**
 * Read-time resolution against the access rules, the check that
 * decides whether a citation renders as a link or as "source
 * unavailable": the source chat must still exist, still belong to
 * the profile that produced the citing reply (visitor chats are
 * never managed, so never resolvable), not be archived away, and
 * still hold the cited message. The available view carries the
 * chat's CURRENT title; the unavailable view carries nothing the
 * reader could not already see.
 */
export function resolveCitation(root: string, stored: StoredCitation): ResolvedCitation {
  const base = { sourceChatId: stored.sourceChatId, sourceMessageId: stored.sourceMessageId, sourceTitle: stored.sourceTitle };
  const store = new ChatStore(root);
  try {
    const chat = store.get(stored.sourceChatId);
    if (!chat || chat.archived) return { ...base, available: false };
    if (!isManagedChat(root, stored.actor, chat)) return { ...base, available: false };
    const present = store.messages(stored.sourceChatId).some(m => m.id === stored.sourceMessageId);
    if (!present) return { ...base, available: false };
    return { sourceChatId: stored.sourceChatId, sourceMessageId: stored.sourceMessageId, sourceTitle: chat.title, available: true };
  } finally { store.close(); }
}

export function citationViewsForChat(root: string, chatId: string): Record<string, ResolvedCitation> {
  const views: Record<string, ResolvedCitation> = {};
  for (const stored of citationsForChat(root, chatId)) views[stored.messageId] = resolveCitation(root, stored);
  return views;
}

export function citationViewForMessage(root: string, messageId: string): ResolvedCitation | null {
  const stored = citationForMessage(root, messageId);
  return stored ? resolveCitation(root, stored) : null;
}
