import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

function append(root: string, event: LedgerEvent): void {
  appendFileSync(ledgerPath(root), JSON.stringify(event) + "\n", { encoding: "utf8", flag: "a" });
}

function readEvents(root: string): LedgerEvent[] {
  const path = ledgerPath(root);
  if (!existsSync(path)) return [];
  const events: LedgerEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as LedgerEvent;
      if (parsed && (parsed.type === "change" || parsed.type === "verification") && typeof parsed.at === "string") events.push(parsed);
    } catch { /* a torn final line is ignored, never fatal */ }
  }
  return events;
}

/** Record that code changed. Called by the edit apply path; the only
 *  door through which a change enters the ledger. */
export function recordChange(root: string, change: { path: string; replacementHash: string; source: string }): void {
  append(root, { type: "change", at: new Date().toISOString(), path: change.path, replacementHash: change.replacementHash, source: change.source });
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
 *  approved test runner for both kinds (build, test). */
export function recordVerification(root: string, run: { kind: "build" | "test"; passed: boolean; runId: string }): void {
  append(root, { type: "verification", at: new Date().toISOString(), kind: run.kind, passed: run.passed, runId: run.runId });
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
