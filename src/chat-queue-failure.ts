import { resolve } from "node:path";
import { recordActivity } from "./activity.js";

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

export function recordChatQueueFailure(root: string, phase: ChatQueuePhase, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "chat-queue-failed", chatQueueFailureSummary(phase, reason));
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
