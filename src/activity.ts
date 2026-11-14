import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The activity ledger: one append-only line per thing SAM did, so the owner can
// answer "what did you do today and why" from a single place. Turns, proposals,
// approvals, executions, heartbeat work - all of it lands here. Writing is
// best-effort by design: the ledger must never break the work it records.
export interface ActivityLine { at: string; actor: string; kind: string; summary: string }
function ledgerPath(root: string): string { return join(resolve(root), ".sam", "activity.jsonl"); }
export function recordActivity(root: string, actor: string, kind: string, summary: string): void {
  try {
    mkdirSync(join(resolve(root), ".sam"), { recursive: true });
    const line: ActivityLine = { at: new Date().toISOString(), actor, kind, summary: summary.slice(0, 300) };
    appendFileSync(ledgerPath(root), JSON.stringify(line) + "\n");
  } catch { /* the ledger never breaks a turn */ }
}
/** One bounded line naming a failed activity-ledger read: the
 *  phase, and the verbatim reason collapsed to one line and
 *  capped. Never any ledger content - the failure line names
 *  the seam that died, not what the ledger holds. */
export function activityFailureSummary(reason: string): string {
  const flat = String(reason ?? "").replace(/\s+/g, " ").trim() || "unknown error";
  return ("Activity read failed: " + flat).slice(0, 300);
}

/** Ledger one activity-failed line for a dead read, through
 *  recordActivity itself. Best-effort by construction: the
 *  line lands when the append path still lives; when the
 *  whole file is dead the append is swallowed like every
 *  append (the ledger never breaks the work it records) and
 *  the caller's rethrow is the witness. Never throws. */
export function recordActivityFailure(root: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "activity-failed", activityFailureSummary(reason));
}

export interface ActivityFilter { actor?: string; kind?: string }
export function readActivity(root: string, limit = 30, filter: ActivityFilter = {}): ActivityLine[] {
  const file = ledgerPath(root);
  // The read seam follows the house contract fail-closed (gap
  // found 2026-11-13, hourly run 22:04): this ledger is the
  // record every failure kind lands in, folded as truth by
  // self-work's defect queue, observability, status, and the
  // CLI - a dead read folded to [] reads as "SAM did nothing
  // and nothing ever failed", the unsafe lie, while the class
  // stayed uncountable. So a failed filesystem touch attempts
  // ONE activity-failed line and rethrows exactly. An absent
  // ledger still reads [] - a fresh install genuinely did
  // nothing - and per-line torn parsing stays forgiving; only
  // the filesystem touch is guarded.
  let raw: string | null;
  try {
    raw = existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch (error) {
    recordActivityFailure(root, error);
    throw error;
  }
  if (raw === null) return [];
  // Filter BEFORE the limit: slicing the raw tail first would starve a
  // per-profile view whenever other actors were busier (P8 console filter).
  let lines = raw.split("\n").filter(Boolean).map(line => {
    try { return JSON.parse(line) as ActivityLine; } catch { return null; }
  }).filter((x): x is ActivityLine => x !== null);
  if (filter.actor) lines = lines.filter(l => l.actor === filter.actor);
  if (filter.kind) lines = lines.filter(l => l.kind === filter.kind);
  return lines.slice(-limit);
}
