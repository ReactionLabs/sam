import { resolve } from "node:path";
import { recordActivity } from "./activity.js";

// Failure visibility for the singleton audit stores, shared
// by the five modules that each carry one copy of the same
// openAuditStore shape: self-audit.ts (.sam/self-audit.db),
// prompt-audit.ts (.sam/prompt-audit.db), context-audit.ts
// (.sam/context-audit.db), loop-audit.ts (.sam/loop-audit.db),
// and eval-battery.ts (.sam/eval-battery.db, the same shape
// under openBatteryStore). Each store holds exactly one row
// (id = 1): the latest scorecard of one of SAM's measuring
// instruments - the capability map self-work picks rest on,
// the prompt / context / loop scorecards, and the eval
// battery's ship verdict. The helpers live here, in a module
// none of the five imports the others through, so every
// handle ledgers through ONE seam with no import cycle (the
// chat-queue-failure precedent).
//
// Gap found 2026-11-15 (hourly run 10:04 EST): the store
// census closed at 04:04 with every store then in the tree
// guarded by name, and the 09:04 run named this family as
// the remaining tail - five copies of one shape, one row
// each, no -failed kind anywhere. Every read and save opened
// its file raw, so a dead audit store threw with the seam
// unnamed, and a reader folding it as "no audit recorded"
// would silently empty an instrument's whole history dressed
// as a version that never ran. Now the touches own their
// failure (the census precedent): a failed touch ledgers ONE
// audit-store-failed line naming the store (read<X>Audit at
// phase read; the save inside each run<X>Audit /
// runEvalBattery at phase write; actor sam; the verbatim
// reason collapsed and capped; never any audit record -
// findings can quote the owner's surfaces), tags the error,
// and rethrows exactly, so every caller's handling is
// unchanged and reads still fail closed. A touch already
// ledgered by an inner door gains no second line. The
// absent shape stays outside the seam: each module's exists
// check still reads a never-run audit as null creating
// nothing, and torn rows still parse forgiving inside the
// touch (a parse null is data, not a failure).
export type AuditStoreName = "self-audit" | "prompt-audit" | "context-audit" | "loop-audit" | "eval-battery";
export type AuditStorePhase = "read" | "write";

export function auditStoreFailureSummary(store: AuditStoreName, phase: AuditStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Audit store " + store + " " + phase + " failed: " + clean).slice(0, 200);
}

export function recordAuditStoreFailure(root: string, store: AuditStoreName, phase: AuditStorePhase, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "audit-store-failed", auditStoreFailureSummary(store, phase, reason));
}

function tagAuditStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { auditStoreLedgered?: boolean }).auditStoreLedgered = true;
  }
}

export function isAuditStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { auditStoreLedgered?: boolean }).auditStoreLedgered === true;
}

function failAuditStore(root: string, store: AuditStoreName, phase: AuditStorePhase, error: unknown): never {
  if (!isAuditStoreLedgered(error)) recordAuditStoreFailure(root, store, phase, error);
  tagAuditStoreLedgered(error);
  throw error;
}

export function auditStoreTouch<T>(root: string, store: AuditStoreName, phase: AuditStorePhase, fn: () => T): T {
  try { return fn(); }
  catch (error) { failAuditStore(resolve(root), store, phase, error); }
}
