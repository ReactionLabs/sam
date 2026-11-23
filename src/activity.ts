import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { errorReason } from "./error-reason.js";

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
/** The reason an activity-failed line carries (gap found
 *  2026-11-17, hourly run 10:04 EST): recordActivityFailure
 *  took error.message alone, discarding error.cause, so a
 *  dead ledger read whose wrapper hid its cause was
 *  countable but never diagnosable - in the ledger's own
 *  self-report line, the worst place to lose a cause. Now
 *  it composes through errorReason (the 04:04 bridge seam,
 *  extracted to its leaf module error-reason.ts in this
 *  same change because telegram.ts imports this module and
 *  the ledger cannot import the seam back without a cycle):
 *  causeless errors keep their plain message, a non-Error
 *  reads through String, bot-token segments are redacted,
 *  and no ledger content ever enters the line. */
export function activityFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordActivityFailure(root: string, error: unknown): void {
  recordActivity(root, "sam", "activity-failed", activityFailureSummary(activityFailureReason(error)));
}

// The activity failed history scorecard (2026-11-22, the
// measured-proof series): the ledger's own read seam ledgers
// every dead read as an "activity-failed" line through the ONE
// writer activityFailureSummary above, ridden by the one seam
// recordActivityFailure - but the class was never folded, so
// how often the ledger itself failed to read was invisible in
// aggregate: a blind instrument reports perfect health, and
// self-work's defect queue counts the lines one by one with no
// trend surface. The parser learns only the writer's one fixed
// shape (the fixed head plus a non-empty reason, consumed and
// never printed - the reason can name paths and surfaces). A
// line from any other kind never parses. The fold is counts
// only: no stamp, no actor, no reason, no verbatim summary.
export function parseActivityFailedSummary(summary: string): { matched: true } | null {
  const m = /^Activity read failed: ([\s\S]+)$/.exec(summary);
  if (!m) return null;
  const reason = m[1] ?? "";
  if (!reason.trim()) return null;
  return { matched: true };
}

export function activityFailedHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "activity-failed" });
  let failed = 0;
  let unparseable = 0;
  for (const line of lines) {
    const parsed = parseActivityFailedSummary(line.summary);
    if (parsed) {
      failed += 1;
      continue;
    }
    unparseable += 1;
  }
  const parts: string[] = [];
  parts.push("Activity failed history: " + (failed > 0 || unparseable > 0 ? "attention" : "clear"));
  parts.push(String(failed) + " failed");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
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
