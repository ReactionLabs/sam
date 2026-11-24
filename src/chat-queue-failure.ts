import { resolve } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";

// Failure visibility for the chat queue store
// (.sam/chat-queue.db), shared by its two store modules:
// chat-queue.ts (the queue itself: enqueue, drain, steer,
// reset, resume) and turn-control.ts (the generation and
// claim reads every turn re-checks at its round boundaries
// and before its final save). The helpers live here, in a
// module neither store module imports the other through, so
// both handles ledger through ONE seam with no import cycle
// (the turn-control header's own reason for its separate
// handle).
//
// Gap found 2026-11-15 (hourly run 09:04 EST): the store
// landed 2026-11-14 with the burst-queue + stuck-turn work,
// after the store census had enumerated its stores, and was
// never named by it. Every touch in both modules opened the
// file raw, no chat-queue-failed kind existed, and the
// dashboard callers fold its failures silently by design (the
// queue view catch reads a dead store as "no queue, no
// active turn"; the startup catch reads it as "nothing to
// resume"), so a dead store would strand queued owner
// messages and wedged claims with nothing counted - in the
// store whose own contract is that an owner message is never
// dropped silently. Now the touches own their failure (the
// census precedent): a failed touch ledgers ONE
// chat-queue-failed line (enqueue / takeQueued / setStatus /
// drain / reset / bumpTurnGeneration at phase write; list /
// queuedItems / claimRow / chatTurnActive / resume /
// turnGeneration / claimTokenFor at phase read; actor sam;
// the verbatim reason collapsed and capped; never any queue
// record - message content is the owner's words), tags the
// error, and rethrows exactly, so every caller's handling is
// unchanged and reads still fail closed where the caller does
// not fold them. A touch already ledgered by an inner door
// gains no second line (the two modules nest constantly:
// reset rides claimRow, chatTurnActive rides claimRow, the
// drain rides takeQueued). This store's reads create the
// file by design (schema on every open), so the absent shape
// is an empty read with no line, not a no-create read.
export type ChatQueuePhase = "read" | "write";

export function chatQueueFailureSummary(phase: ChatQueuePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Chat queue store " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a chat-queue-failed line carries (census sprint
 * 2026-11-17): recordChatQueueFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function chatQueueFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordChatQueueFailure(root: string, phase: ChatQueuePhase, error: unknown): void {
  const reason = chatQueueFailureReason(error);
  recordActivity(root, "sam", "chat-queue-failed", chatQueueFailureSummary(phase, reason));
}

// The chat queue failed history scorecard (2026-11-23, the
// measured-proof series): the chat queue store's touches
// ledger every failure as a "chat-queue-failed" line through
// the ONE writer above (chatQueueFailureSummary, fixed shape
// "Chat queue store <phase> failed: <reason>", capped 200;
// phases read / write, ridden by recordChatQueueFailure from
// chatQueueTouch / chatQueueTouchAsync across chat-queue.ts
// and turn-control.ts, actor sam) - and while self-work's
// classifyDefect labels single lines and the message /
// intervention / reset scorecards fold the queue's other
// kinds, no surface folds this kind, so a dead chat-queue.db -
// the burst queue every owner message is accounted in, the
// turn claims, and the reset generations two modules share -
// could fail every touch with nothing counting the class in
// aggregate, while the dashboard folds the failure as no
// queue and no active turn. Every failure line is by
// construction a store touch that did not complete, so the
// verdict is attention when any failure was ever recorded or
// any line is unparseable, else clear. This parser is strict:
// only the two phases the writer writes parse, and a
// non-empty reason is required and consumed, never printed -
// a reason can carry a store path and never surfaces here,
// and no queue record (message content is the owner's words)
// ever enters the fold. A line from any other kind never
// parses. A pure read: it creates nothing, updates nothing,
// and reads no queue record - the store seams themselves are
// untouched. (This store's reads create the queue file by
// design; the scorecard reads only the activity ledger, so
// its bare run creates nothing at all.)
export function parseChatQueueFailedSummary(summary: string): { phase: ChatQueuePhase } | null {
  const m = /^Chat queue store (read|write) failed: ([\s\S]+)$/.exec(summary);
  if (!m) return null;
  if (!(m[2] ?? "").trim()) return null;
  return { phase: m[1] as ChatQueuePhase };
}

export function chatQueueFailedHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "chat-queue-failed" });
  let failed = 0;
  let unparseable = 0;
  let read = 0;
  let write = 0;
  for (const line of lines) {
    const parsed = parseChatQueueFailedSummary(line.summary);
    if (parsed) {
      failed += 1;
      if (parsed.phase === "read") read += 1;
      else write += 1;
      continue;
    }
    unparseable += 1;
  }
  const parts: string[] = [];
  parts.push("Chat queue failed history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(failed) + " failed");
  parts.push(String(read) + " read");
  parts.push(String(write) + " write");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}

function tagChatQueueLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { chatQueueLedgered?: boolean }).chatQueueLedgered = true;
  }
}

export function isChatQueueLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { chatQueueLedgered?: boolean }).chatQueueLedgered === true;
}

function failChatQueue(root: string, phase: ChatQueuePhase, error: unknown): never {
  if (!isChatQueueLedgered(error)) recordChatQueueFailure(root, phase, error);
  tagChatQueueLedgered(error);
  throw error;
}

export function chatQueueTouch<T>(root: string, phase: ChatQueuePhase, fn: () => T): T {
  try { return fn(); }
  catch (error) { failChatQueue(resolve(root), phase, error); }
}

export async function chatQueueTouchAsync<T>(root: string, phase: ChatQueuePhase, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (error) { failChatQueue(resolve(root), phase, error); }
}
