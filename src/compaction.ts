import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatStore, type ChatCompaction, type ChatMessage } from "./chats.js";
import { MemoryStore } from "./memory.js";
import { episodeScope } from "./episodes.js";
import { readActivity, recordActivity } from "./activity.js";
import { activeSuppressions, needleMatches, recordSuppressionBlock, MemorySuppressedError, type CaptureSuppression } from "./capture-guard.js";
import { readLawSnapshot, verifyLawAcrossFold, recordFenceIntegrityFailure, fenceIntegrityFailureSummary, digestLaw, type LawSnapshot } from "./fence-integrity.js";
import { errorReason } from "./error-reason.js";

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
// - FAILURES LEDGER (gap found 2026-11-13, hourly run 11:04). The
//   fail-open above used to be the whole story: a throw at any of
//   the fold's three durable steps (the stored-compaction read,
//   the memory flush, the summary save) left no trace anywhere, so
//   a wedged fold - a locked or corrupt store is all it takes -
//   silently degraded every later turn on the chat (a flush
//   failure means the chat never compacts at all), and a save
//   failure after a landed flush re-wrote the same segment's
//   flush on every retry. Each failed step now writes ONE
//   "compaction-failed" activity line (phase + verbatim reason,
//   never message content or the digest) and rethrows exactly, so
//   the caller's fail-open and the CLI's error surface are
//   unchanged and the class is countable. The flush is retry-safe
//   in the same change: a live record already carrying the fold's
//   source IS the flush (its text is deterministic per segment),
//   so a retry after a save failure adds nothing.
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
  kept: Array<{ id: string; role: "user" | "assistant"; content: string; source: string }>;
  covered: number;
  compactedNow: boolean;
  foldedCount: number;
}

// One ledger line per failed durable step per fold attempt (the
// seam described in the header): the phase names which of the
// fold's writes died, the reason is the error's own words
// (collapsed, capped), and no message content or digest text ever
// enters the line - counts and the chat prefix only.
export function compactionFailureSummary(chatId: string, phase: string, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Compaction " + phase + " failed for chat " + chatId.slice(0, 8) + ": " + clean).slice(0, 200);
}

/**
 * The reason a compaction-failed line carries (census sprint
 * 2026-11-17): recordCompactionFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function compactionFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordCompactionFailure(root: string, actor: string, chatId: string, phase: string, error: unknown): void {
  const reason = compactionFailureReason(error);
  recordActivity(root, actor, "compaction-failed", compactionFailureSummary(chatId, phase, reason));
}

export type CompactionPhase = "read" | "flush" | "save";

// The compaction failed history scorecard (2026-11-23, the
// measured-proof series): the fold's three durable steps ledger
// every failure as a "compaction-failed" line through the ONE
// writer above (compactionFailureSummary, fixed shape "Compaction
// <phase> failed for chat <8-char prefix>: <reason>", capped 200;
// phases read / flush / save, ridden by recordCompactionFailure
// from the fold seams, actor the acting profile) - and while
// self-work's classifyDefect labels single lines and the success
// side carries its own fold (compactionScorecardText over the
// "compaction" kind), no surface folds this kind, so a wedged
// fold - a locked or corrupt store is all it takes - could fail
// every later turn on a chat (a flush failure means the chat
// never compacts at all) with nothing counting the class in
// aggregate. Every failure line is by construction a fold step
// that did not complete, so the verdict is attention when any
// failure was ever recorded or any line is unparseable, else
// clear. This parser is strict: only the three phases the writer
// writes parse, the chat segment must be exactly the writer's
// 8-char slice (a longer segment never parses), and a non-empty
// reason is required and consumed, never printed - a reason can
// carry a store path and never surfaces here, and no chat id
// beyond its counted prefix, message content, or digest text
// ever enters the fold (distinct chats surface as a number
// only). A line from any other kind never parses. A pure read:
// it creates nothing, updates nothing, and folds nothing - the
// fold seams themselves are untouched.
export function parseCompactionFailedSummary(summary: string): { phase: CompactionPhase; chat: string } | null {
  const m = /^Compaction (read|flush|save) failed for chat ([A-Za-z0-9_-]{8}): ([\s\S]+)$/.exec(summary);
  if (!m) return null;
  if (!(m[3] ?? "").trim()) return null;
  return { phase: m[1] as CompactionPhase, chat: m[2] ?? "" };
}

export function compactionFailedHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "compaction-failed" });
  let failed = 0;
  let unparseable = 0;
  let read = 0;
  let flush = 0;
  let save = 0;
  const chats = new Set<string>();
  for (const line of lines) {
    const parsed = parseCompactionFailedSummary(line.summary);
    if (parsed) {
      failed += 1;
      chats.add(parsed.chat);
      if (parsed.phase === "read") read += 1;
      else if (parsed.phase === "flush") flush += 1;
      else save += 1;
      continue;
    }
    unparseable += 1;
  }
  const parts: string[] = [];
  parts.push("Compaction failed history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(failed) + " failed");
  parts.push(String(read) + " read");
  parts.push(String(flush) + " flush");
  parts.push(String(save) + " save");
  parts.push(String(chats.size) + " distinct chats");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

// The fence snapshot reader for both sides of a fold: a profile
// with no preference store yet has no law to protect, so the
// snapshot is empty rather than the read creating the store on
// a path that is otherwise read-only until a fold lands.
export function snapshotLawIfStoreExists(root: string, profile: string): LawSnapshot {
  if (!existsSync(join(resolve(root), ".sam", "preferences.db"))) {
    return { profile, entries: [], digest: digestLaw([]) };
  }
  return readLawSnapshot(root, profile);
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
  let existing: ChatCompaction | null = null;
  try {
    const store = new ChatStore(root);
    try { existing = store.getCompaction(chatId); } finally { store.close(); }
  } catch (error) { recordCompactionFailure(root, profile, chatId, "read", error); throw error; }
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
      // FENCE VERBATIM (Program H item C): snapshot the profile's
      // standing law before the fold; it is verified byte-for-byte
      // after the save, below. Law never enters the summarizer -
      // this pair is the standing proof that it did not move,
      // with identifiers re-checked by name.
      const lawBefore = snapshotLawIfStoreExists(root, profile);
      const segment = history.slice(covered, boundary);
      const digest = digestSegment(segment);
      // FLUSH FIRST: the durable memory record exists before the
      // summary replaces these turns in any prompt. Retry-safe: a
      // live record already carrying this fold's source is the
      // flush (the digest for a given segment never changes), so a
      // fold retried after a save failure adds no duplicate.
      if (!visitor) {
        const flushSource = "compaction:" + chatId + ":" + boundary;
        const scope = episodeScope(profile);
        try {
          // The capture guard (Program H item A): suppressed
          // messages are dropped from the flush digest before it
          // is written - the flush is an automatic capture path,
          // so a standing do-not-store instruction binds it. The
          // in-prompt summary is the chat's own context and is
          // NOT filtered (the raw turns remain in the chat record
          // regardless); only the durable memory write is.
          const suppressions = activeSuppressions(root, profile);
          let flushDigest = digest;
          let suppressedHit: CaptureSuppression | null = null;
          if (suppressions.length) {
            const kept = segment.filter(m => {
              const hit = suppressions.find(s => needleMatches(s.needle, m.content));
              if (hit) { if (!suppressedHit) suppressedHit = hit; return false; }
              return true;
            });
            flushDigest = digestSegment(kept);
          }
          const mem = new MemoryStore(join(resolve(root), ".sam", "missions.db"));
          try {
            const alreadyFlushed = mem.list(undefined, [scope]).some(r => r.source === flushSource);
            if (!alreadyFlushed && flushDigest.trim()) mem.add({
              kind: "observation",
              content: "Chat compaction flush · chat " + chatId.slice(0, 8) + " · profile " + profile +
                " · messages " + (covered + 1) + "-" + boundary + "\n" + flushDigest,
              source: flushSource,
              scope,
            });
          } finally { mem.close(); }
          if (suppressedHit) recordSuppressionBlock(root, profile, "compaction", suppressedHit);
        } catch (error) {
          // The store-level backstop can still refuse the joined
          // digest (a needle whose words are spread across
          // messages): the flush is skipped and ledgered, the
          // fold itself proceeds - suppression binds the memory
          // write, not the chat's own compaction.
          if (error instanceof MemorySuppressedError) recordSuppressionBlock(root, profile, "compaction", error.hit);
          else { recordCompactionFailure(root, profile, chatId, "flush", error); throw error; }
        }
      }
      summary = mergeSummary(summary, digest, boundary);
      try {
        const saved = new ChatStore(root);
        try { saved.setCompaction(chatId, boundary, summary); } finally { saved.close(); }
      } catch (error) { recordCompactionFailure(root, profile, chatId, "save", error); throw error; }
      // FENCE VERBATIM, the after side: the profile's law must be
      // byte-identical to the before snapshot, identifiers
      // included. A moved fence refuses the fold's context (the
      // caller fails open to the raw tail under its standing
      // contract) and ledgers ONE fence-integrity-failed line -
      // a compaction that altered standing law is never quietly
      // trusted.
      const fenceCheck = verifyLawAcrossFold(root, profile, lawBefore, snapshotLawIfStoreExists);
      if (!fenceCheck.ok) {
        recordFenceIntegrityFailure(root, profile, profile, fenceCheck);
        throw new Error(fenceIntegrityFailureSummary(profile, fenceCheck));
      }
      foldedCount = boundary - covered;
      covered = boundary;
      compactedNow = true;
      recordActivity(root, profile, "compaction",
        compactionLedgerSummary(chatId, foldedCount, covered, history.length - covered, visitor));
    }
  }
  let kept = summary ? history.slice(covered) : history.slice(-COMPACT_TRIGGER_MESSAGES);
  // Safety bound: if no safe boundary existed, never hand the model an
  // unbounded tail - fall back to the pre-compaction window.
  if (kept.length > COMPACT_TRIGGER_MESSAGES + COMPACT_KEEP_MESSAGES) kept = kept.slice(-COMPACT_TRIGGER_MESSAGES);
  return { summary, kept: kept.map(m => ({ id: m.id, role: m.role, content: m.content, source: m.source ?? "unknown" })), covered, compactedNow, foldedCount };
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

// The ONE writer for a fold's activity line, so the scorecard's
// parser below can never drift from the seam it counts.
export function compactionLedgerSummary(chatId: string, foldedCount: number, covered: number, keptVerbatim: number, visitor: boolean): string {
  return "Compacted chat " + chatId.slice(0, 8) + ": folded " + foldedCount + " messages (" + covered + " covered), " +
    keptVerbatim + " kept verbatim" + (visitor ? ", visitor chat (no memory flush)" : ", memory flush written first");
}

// The compaction scorecard (2026-11-18, the measured-proof
// series): every successful fold ledgers one "compaction" line
// carrying the chat id prefix and the fold's counts - but no
// daily surface ever counted the folds, so a chat that stopped
// compacting, or a fold habit that started chewing far more
// history per fold, was invisible in aggregate. This text folds
// those lines to counts only: the total folds, counts per fixed
// route bucket (flushed / visitor / other), and the summed
// folded and kept-verbatim counts parsed from the fixed
// summaries. A summary matching no fixed shape counts as a fold
// under "other" and contributes no counts, and no chat id is
// ever printed. No stamp, no actor, and no verbatim summary
// enters the text, so a day no chat folds is byte-identical and
// P3-silent, and the first new fold is the news. A pure read:
// it creates nothing, spends no model call, and folds nothing -
// the ledger and the fold seam are untouched, and folding a
// chat stays compaction's job. The failure side is measured
// elsewhere: compaction-failed lines feed the self-work queue.
const COMPACTION_ROUTES = ["flushed", "visitor", "other"] as const;
export function parseCompactionSummary(summary: string): { folded: number; covered: number; kept: number; route: string } | null {
  const m = /^Compacted chat \S+: folded (\d+) messages \((\d+) covered\), (\d+) kept verbatim(, visitor chat \(no memory flush\)|, memory flush written first)$/.exec(summary);
  if (!m) return null;
  return { folded: Number(m[1]), covered: Number(m[2]), kept: Number(m[3]), route: m[4].startsWith(", visitor") ? "visitor" : "flushed" };
}
export function compactionScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "compaction" });
  const routes: Record<string, number> = {};
  let folded = 0;
  let kept = 0;
  for (const line of lines) {
    const parsed = parseCompactionSummary(line.summary);
    const route = parsed ? parsed.route : "other";
    routes[route] = (routes[route] ?? 0) + 1;
    if (parsed) { folded += parsed.folded; kept += parsed.kept; }
  }
  const routeText = (COMPACTION_ROUTES as readonly string[]).filter(r => routes[r]).map(r => r + " " + String(routes[r])).join(", ") || "none";
  const out: string[] = [];
  out.push("Compactions: " + (lines.length > 0 ? "attention" : "clear"));
  out.push("Folds: " + String(lines.length));
  out.push("By route: " + routeText);
  out.push("Messages folded: " + String(folded));
  out.push("Kept verbatim: " + String(kept));
  out.push("Note: counts only, cumulative over the activity ledger - the scorecard never folds a chat or prints a chat id or summary; a new fold is the news");
  return out.join("\n");
}

export function getCompaction(root: string, chatId: string): ChatCompaction | null {
  const store = new ChatStore(root);
  try { return store.getCompaction(chatId); } finally { store.close(); }
}
export function listCompactions(root: string): ChatCompaction[] {
  const store = new ChatStore(root);
  try { return store.listCompactions(); } finally { store.close(); }
}
