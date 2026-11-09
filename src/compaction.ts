import { join, resolve } from "node:path";
import { ChatStore, type ChatCompaction, type ChatMessage } from "./chats.js";
import { MemoryStore } from "./memory.js";
import { episodeScope } from "./episodes.js";
import { recordActivity } from "./activity.js";

// Context compression with a memory flush (Plan Phase A, item 2 - the
// Hermes/OpenClaw runtime spine). Before this, agent-turn built every
// prompt from history.slice(-24): older turns vanished silently, and at
// 100 stored messages the turn threw "Chat history limit reached" - a
// long chat did not degrade, it died (the door handler even rotated to
// a fresh chat on that throw, losing the thread).
//
// The shape, following the plan doc and SAM's own precedents:
// - FLUSH BEFORE SUMMARIZE. When a fold happens, the folded segment's
//   digest is written to the MemoryStore FIRST, as an observation
//   scoped to the acting profile exactly like an episode (core for
//   sam, profile:<name> otherwise), source compaction:<chat>:<end>.
//   That is the soft tier of Dip's two-tier note ruling (2026-11-09
//   14:10): an observation saved freely, ledgered, owner-revocable
//   by archiving. The flush never creates law, never supersedes a
//   record, and never captures a preference - hard changes stay on
//   the approval gate, and turn-time capture already handled the
//   owner's words when they were said. Visitor chats flush NOTHING
//   (P12: a customer's words never become memory), though their
//   prompt still compacts.
// - DETERMINISTIC SUMMARY. The digest is extractive (the P4 episodes
//   precedent - no model call, same input same text): the owner's
//   own words and SAM's replies as capped excerpts, in order. It is
//   stored per chat in chats.db (chat_compactions), so the nightly
//   backup carries it, and injected into the prompt as a system
//   message ahead of the kept turns. Raw messages are NEVER deleted;
//   the summary only replaces them in the prompt, and the chat UI
//   still shows the full history.
// - PAIRS NEVER SPLIT. The fold boundary lands on a user message, so
//   the folded segment ends with an assistant reply and the kept
//   segment opens with a user message: a user/assistant exchange is
//   never cut in half. That is the persisted form of the plan's
//   "tool-call pairs are never split" - tool pairs themselves are
//   transient inside a turn and never reach the chat store.
// - FAIL OPEN. Any compaction error leaves the caller with the raw
//   tail, exactly the pre-compaction behavior; a broken summary must
//   never break a turn.
export const COMPACT_KEEP_MESSAGES = 12;
export const COMPACT_TRIGGER_MESSAGES = 24;
export const COMPACT_TRIGGER_CHARS = 16000;
export const COMPACT_SUMMARY_MAX_CHARS = 3600;
const EXCERPT_CHARS = 180;

function excerpt(text: string, cap = EXCERPT_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > cap ? clean.slice(0, cap - 1) + "…" : clean;
}

// One digest line per message, in order - the substance is the words
// themselves, the owner's first, in their own phrasing.
export function digestSegment(messages: Array<{ role: string; content: string }>): string {
  return messages.map(m => "- " + (m.role === "user" ? "owner" : "SAM") + ': "' + excerpt(m.content) + '"').join("\n");
}

function summaryHeader(covered: number): string {
  return "Compacted context: " + covered + " earlier " + (covered === 1 ? "message" : "messages") +
    " from this chat were folded into the summary below. The raw turns remain in the chat record.";
}
const OVERFLOW_LINE = "- (oldest folded exchanges omitted from this summary to keep it bounded; their flush is in memory and the raw turns remain in the chat record)";

// Merge a new segment digest into the stored summary, bounded: when
// the cap bites, the OLDEST digest lines drop and a marker says so -
// nothing vanishes silently, and the flush in memory holds the full
// segment digests regardless.
export function mergeSummary(previous: string | null, segmentDigest: string, covered: number): string {
  const prevLines = previous ? previous.split("\n").filter(l => l.startsWith("- ") && l !== OVERFLOW_LINE) : [];
  const lines = [...prevLines, ...segmentDigest.split("\n").filter(Boolean)];
  const build = (body: string[], overflow: boolean) =>
    [summaryHeader(covered), ...(overflow ? [OVERFLOW_LINE] : []), ...body].join("\n");
  let overflow = false;
  while (lines.length && build(lines, overflow).length > COMPACT_SUMMARY_MAX_CHARS) { lines.shift(); overflow = true; }
  return build(lines, overflow);
}

// The largest fold end at or below target that starts a fresh exchange
// (a user message) and folds at least one full exchange past covered.
// -1 when there is no safe boundary.
export function foldBoundary(history: Array<{ role: string }>, covered: number, target: number): number {
  for (let i = Math.min(target, history.length - 1); i > covered + 1; i--) {
    if (history[i].role === "user" && history[i - 1].role === "assistant") return i;
  }
  return -1;
}

export interface ChatContext {
  summary: string | null;
  kept: Array<{ role: "user" | "assistant"; content: string }>;
  covered: number;
  compactedNow: boolean;
  foldedCount: number;
}

// Build the prompt context for one turn: the stored summary (if any)
// plus the kept raw tail, folding first when the history crossed a
// trigger. Purely a read model over the chat store plus, on a fold,
// the flush + compaction writes described above.
export function buildChatContext(
  root: string,
  opts: { chatId: string; profile: string; visitor: boolean; history: ChatMessage[]; force?: boolean },
): ChatContext {
  const { chatId, profile, visitor, history } = opts;
  const store = new ChatStore(root);
  let existing: ChatCompaction | null = null;
  try { existing = store.getCompaction(chatId); } finally { store.close(); }
  // A stored record past the end of this history cannot belong to it
  // (branch/copy mismatch): ignore it rather than hide live turns.
  let covered = existing && existing.covered <= history.length ? existing.covered : 0;
  let summary = covered > 0 ? existing!.summary : null;
  const chars = history.reduce((n, m) => n + m.content.length, 0);
  const need = !!opts.force || history.length > COMPACT_TRIGGER_MESSAGES || chars > COMPACT_TRIGGER_CHARS || history.length >= 100;
  let compactedNow = false, foldedCount = 0;
  if (need && history.length - COMPACT_KEEP_MESSAGES > covered) {
    const boundary = foldBoundary(history, covered, history.length - COMPACT_KEEP_MESSAGES);
    if (boundary > covered) {
      const segment = history.slice(covered, boundary);
      const digest = digestSegment(segment);
      // FLUSH FIRST: the durable memory record exists before the
      // summary replaces these turns in any prompt.
      if (!visitor) {
        const mem = new MemoryStore(join(resolve(root), ".sam", "missions.db"));
        try {
          mem.add({
            kind: "observation",
            content: "Chat compaction flush · chat " + chatId.slice(0, 8) + " · profile " + profile +
              " · messages " + (covered + 1) + "-" + boundary + "\n" + digest,
            source: "compaction:" + chatId + ":" + boundary,
            scope: episodeScope(profile),
          });
        } finally { mem.close(); }
      }
      summary = mergeSummary(summary, digest, boundary);
      const saved = new ChatStore(root);
      try { saved.setCompaction(chatId, boundary, summary); } finally { saved.close(); }
      foldedCount = boundary - covered;
      covered = boundary;
      compactedNow = true;
      recordActivity(root, profile, "compaction",
        "Compacted chat " + chatId.slice(0, 8) + ": folded " + foldedCount + " messages (" + covered + " covered), " +
        (history.length - covered) + " kept verbatim" + (visitor ? ", visitor chat (no memory flush)" : ", memory flush written first"));
    }
  }
  let kept = summary ? history.slice(covered) : history.slice(-COMPACT_TRIGGER_MESSAGES);
  // Safety bound: if no safe boundary existed, never hand the model an
  // unbounded tail - fall back to the pre-compaction window.
  if (kept.length > COMPACT_TRIGGER_MESSAGES + COMPACT_KEEP_MESSAGES) kept = kept.slice(-COMPACT_TRIGGER_MESSAGES);
  return { summary, kept: kept.map(m => ({ role: m.role, content: m.content })), covered, compactedNow, foldedCount };
}

// CLI/manual door onto the same fold: force a compaction of a stored
// chat now, using its stored profile and visitor flag.
export function forceCompactChat(root: string, chatId: string): ChatContext & { chatId: string } {
  const store = new ChatStore(root);
  let history: ChatMessage[], profile = "sam", visitor = false;
  try {
    const chat = store.list().find(c => c.id === chatId);
    if (!chat) throw new Error("Chat not found");
    profile = chat.agent_name ?? "sam";
    visitor = chat.visitor === 1;
    history = store.messages(chatId);
  } finally { store.close(); }
  return { chatId, ...buildChatContext(root, { chatId, profile, visitor, history, force: true }) };
}

export function getCompaction(root: string, chatId: string): ChatCompaction | null {
  const store = new ChatStore(root);
  try { return store.getCompaction(chatId); } finally { store.close(); }
}
export function listCompactions(root: string): ChatCompaction[] {
  const store = new ChatStore(root);
  try { return store.listCompactions(); } finally { store.close(); }
}
