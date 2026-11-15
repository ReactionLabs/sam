import { recordActivity } from "./activity.js";

// Failure visibility for the engine-connection store
// (.sam/engine-connection.db, UNIFICATION store 30): the
// non-secret route marker plus the provider choice for the
// C6 managed coding engine. The helpers live here, in a leaf
// module, because the store has two homes: engine-connect.ts
// owns the touches, and engine.ts carries the run layer's
// read-only mirror (selectedEngineProvider) - and
// engine-connect imports engineBinary from engine, so neither
// module can import the other's helpers without a cycle (the
// audit-store-failure precedent).
//
// Gap found 2026-11-15 (hourly run 13:04 EST): every touch
// opened the file raw, with no engine-connection-store-failed
// kind anywhere, so a dead store threw with the seam unnamed
// into detectSetup, auth status, the dashboard status path,
// the CLI overview and engine verbs, and the config wizard -
// and the engine.ts mirror folded every failure to the
// claude-code default, so a dead store on a Codex-selected
// install silently ran the wrong provider dressed as no
// choice ever recorded. Now the touches own their failure
// (the census precedent): a failed touch ledgers ONE
// engine-connection-store-failed line (the read doors at
// phase read, the write doors at phase write, the folding
// mirror at phase resolve; actor sam; the verbatim reason
// collapsed and capped; never any marker or provider content
// - the recorded binary path and provider are fence data),
// tags the error, and rethrows exactly, so every caller's
// handling is unchanged: direct reads still fail closed, and
// the mirror still folds to the default exactly as before,
// now countable (the dashboard-config coreActor precedent).
// A touch already ledgered gains no second line. The absent
// shape stays outside the seam: a read on an install with no
// store reads as no connection / the default provider,
// creating nothing, and torn rows still parse forgiving
// inside the touch (a parse null is data, not a failure).
export type EngineConnectionStorePhase = "read" | "write" | "resolve";

export function engineConnectionStoreFailureSummary(phase: EngineConnectionStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Engine connection store " + phase + " failed: " + clean).slice(0, 200);
}

export function recordEngineConnectionStoreFailure(root: string, phase: EngineConnectionStorePhase, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "engine-connection-store-failed", engineConnectionStoreFailureSummary(phase, reason));
}

function tagEngineConnectionStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { engineConnectionStoreLedgered?: boolean }).engineConnectionStoreLedgered = true;
  }
}

export function isEngineConnectionStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { engineConnectionStoreLedgered?: boolean }).engineConnectionStoreLedgered === true;
}

export function failEngineConnectionStore(root: string, phase: EngineConnectionStorePhase, error: unknown): never {
  if (!isEngineConnectionStoreLedgered(error)) recordEngineConnectionStoreFailure(root, phase, error);
  tagEngineConnectionStoreLedgered(error);
  throw error;
}
