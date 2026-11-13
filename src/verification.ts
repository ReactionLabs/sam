import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordActivity } from "./activity.js";

/**
 * Verify-on-stop (Harness Implementation Order item 1, Dip 2026-11-09,
 * from the Harness Engineering Part 4 study: Hermes turns a text-only
 * final answer into a continuation when code changed without fresh
 * verification).
 *
 * The rule: work that changed code is never "done" on a text claim.
 * Every applied change is recorded here; every approved build/test run
 * records its verdict here. A session may close only when the ledger
 * says clean (nothing changed), verified (a fresh build AND a fresh
 * test both passed after the last change), or failed (a verification
 * after the last change failed - an explicit recorded failure closes
 * the session as failed, never as done). Unverified work cannot close.
 *
 * The ledger is append-only at .sam/verifications.jsonl, the same
 * shape as the activity ledger: changes and verdicts are events, and
 * the current state is a projection over them. The coding loop (Coder
 * C3) and the goldfish verifier (item 2) consume verificationGate;
 * nothing else in the system gets to invent its own "done".
 */

export type VerificationState = "clean" | "unverified" | "verified" | "failed";

export interface PendingChange { path: string; replacementHash: string; at: string; source: string }

export interface VerificationStatus {
  state: VerificationState;
  pendingChanges: PendingChange[];
  lastChangeAt: string | null;
  lastVerificationAt: string | null;
  buildPassedAfterChange: boolean;
  testPassedAfterChange: boolean;
}

type LedgerEvent =
  | { type: "change"; at: string; path: string; replacementHash: string; source: string }
  | { type: "verification"; at: string; kind: "build" | "test"; passed: boolean; runId: string };

function ledgerPath(root: string): string {
  const base = resolve(root);
  const dir = join(base, ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  return join(dir, "verifications.jsonl");
}

// The ledger follows the house contract, with verification's
// fail-closed twist (gap found 2026-11-13). APPENDING never
// breaks the work it records and never fails silently: a
// change or a verdict already happened in the world (the file
// is on disk, the build/test already ran), so a dead append
// ledgers one verification-failed line and the recorder
// returns whether the record landed, instead of throwing the
// work away or - the C2 code-run caller's old silent catch -
// losing the verdict with no trace anywhere. READING is the
// opposite call: a status folded from an unreadable ledger
// would read clean and lie in the unsafe direction, so a
// failed read ledgers one line and rethrows exactly -
// verification exists to fail closed, and the truth failure
// stays a failure, now countable instead of invisible.
export function verificationFailureSummary(phase: "read" | "append", eventLabel: string, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Verification " + phase + " failed for " + eventLabel + ": " + clean).slice(0, 200);
}

export function recordVerificationFailure(root: string, phase: "read" | "append", eventLabel: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "verification-failed", verificationFailureSummary(phase, eventLabel, reason));
}

function eventLabel(event: LedgerEvent): string {
  return event.type === "change"
    ? "change " + event.path + " (source " + event.source + ")"
    : "verification " + event.kind + " " + (event.passed ? "passed" : "failed") + " (run " + event.runId.slice(0, 8) + ")";
}

function append(root: string, event: LedgerEvent): boolean {
  try {
    appendFileSync(ledgerPath(root), JSON.stringify(event) + "\n", { encoding: "utf8", flag: "a" });
    return true;
  } catch (error) {
    recordVerificationFailure(root, "append", eventLabel(event), error);
    return false;
  }
}

function readEvents(root: string): LedgerEvent[] {
  let raw: string;
  try {
    const path = ledgerPath(root);
    if (!existsSync(path)) return [];
    raw = readFileSync(path, "utf8");
  } catch (error) {
    recordVerificationFailure(root, "read", "ledger", error);
    throw error;
  }
  const events: LedgerEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as LedgerEvent;
      if (parsed && (parsed.type === "change" || parsed.type === "verification") && typeof parsed.at === "string") events.push(parsed);
    } catch { /* a torn final line is ignored, never fatal */ }
  }
  return events;
}

/** Record that code changed. Called by the edit apply path; the only
 *  door through which a change enters the ledger. Returns whether
 *  the record landed; an append failure ledgers one
 *  verification-failed line and never throws (see above). */
export function recordChange(root: string, change: { path: string; replacementHash: string; source: string }): boolean {
  return append(root, { type: "change", at: new Date().toISOString(), path: change.path, replacementHash: change.replacementHash, source: change.source });
}

/** Every recorded change, in ledger order. The goldfish verifier
 *  binds its reviews to this list (hashes + count), so a review can
 *  never silently cover changes it never saw. */
export function listChanges(root: string): PendingChange[] {
  return readEvents(root)
    .filter(e => e.type === "change")
    .map(e => { const c = e as Extract<LedgerEvent, { type: "change" }>; return { path: c.path, replacementHash: c.replacementHash, at: c.at, source: c.source }; });
}

/** Record an approved verification run's verdict. Called by the
 *  approved test runner for both kinds (build, test). Returns
 *  whether the record landed; an append failure ledgers one
 *  verification-failed line and never throws (see above). */
export function recordVerification(root: string, run: { kind: "build" | "test"; passed: boolean; runId: string }): boolean {
  return append(root, { type: "verification", at: new Date().toISOString(), kind: run.kind, passed: run.passed, runId: run.runId });
}

export function verificationStatus(root: string): VerificationStatus {
  // Forward fold over the ledger. An epoch runs from the most recent
  // change: any change resets both pass flags, because verification
  // only counts when it is fresh (after the last change). A build
  // pass plus a test pass inside one epoch verifies the epoch and
  // clears the pending set; a failure inside the epoch marks it
  // failed until a full pass supersedes it.
  const pending = new Map<string, PendingChange>();
  let sawChange = false;
  let epochVerified = false;
  let buildPassed = false;
  let testPassed = false;
  let anyFailed = false;
  let lastChangeAt: string | null = null;
  let lastVerificationAt: string | null = null;
  for (const event of readEvents(root)) {
    if (event.type === "change") {
      sawChange = true;
      epochVerified = false;
      buildPassed = false;
      testPassed = false;
      anyFailed = false;
      lastChangeAt = event.at;
      pending.set(event.path, { path: event.path, replacementHash: event.replacementHash, at: event.at, source: event.source });
      continue;
    }
    lastVerificationAt = event.at;
    if (pending.size === 0) continue;
    if (!event.passed) { anyFailed = true; continue; }
    if (event.kind === "build") buildPassed = true; else testPassed = true;
    if (buildPassed && testPassed) {
      epochVerified = true;
      anyFailed = false;
      pending.clear();
    }
  }
  let state: VerificationState;
  if (!sawChange) state = "clean";
  else if (epochVerified && pending.size === 0) state = "verified";
  else if (anyFailed) state = "failed";
  else state = "unverified";
  return { state, pendingChanges: [...pending.values()], lastChangeAt, lastVerificationAt, buildPassedAfterChange: buildPassed, testPassedAfterChange: testPassed };
}

/** The single closable check. A session holding unverified changes
 *  may not close as done; failed closes only as failed. */
export function verificationGate(root: string): { closable: boolean; state: VerificationState; reason: string } {
  const status = verificationStatus(root);
  switch (status.state) {
    case "clean": return { closable: true, state: status.state, reason: "No code changes recorded." };
    case "verified": return { closable: true, state: status.state, reason: "Fresh build and test passed after the last change." };
    case "failed": return { closable: true, state: status.state, reason: "A verification after the last change failed; the session may close as failed, never as done." };
    case "unverified": return { closable: false, state: status.state, reason: "Code changed without fresh verification: " + status.pendingChanges.map(c => c.path).join(", ") + ". Run the approved build and test; a text-only completion does not close this session." };
  }
}
