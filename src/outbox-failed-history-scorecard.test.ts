import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { outboxFailedHistoryScorecardText, outboxFailureSummary, parseOutboxFailedSummary } from "./delivery-outbox.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The outbox failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): a failed touch
// of the delivery outbox ledgers as an outbox-failed line
// through the ONE writer outboxFailureSummary, and
// self-work ranks the class as a defect - but the class
// was never folded, so how often the durable record every
// changed channel delivery passes through failed to land
// or to read back was invisible in aggregate; the outbox
// scorecard folds the store's records, not these ledger
// lines. Every failure line is by construction an outbox
// touch that did not land, so the verdict is attention
// when any failure was ever recorded or any line is
// unparseable, else clear. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is
// ONE line carrying counts only: no stamp, no actor, no
// label, no job name, no delivery id, and no verbatim
// reason - the summaries carry labels naming jobs and
// deliveries, which the fold consumes into a distinct
// count and never prints. The scorecard path is a pure
// read - it creates nothing, sends nothing, retries
// nothing, and settles nothing; every state here is built
// through the ledger's own public door (recordActivity)
// with the seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-outbox-failed-history-"));
}

const BARE = "Outbox failed history: clear, 0 append, 0 read, 0 distinct labels, 0 total";

test("outbox failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = outboxFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = outboxFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held outbox scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outbox failed history scorecard: the writer's failures fold to counts per phase, and no label, job name, or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = outboxFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "outbox-failed", outboxFailureSummary("read", "ledger", "EISDIR: illegal operation on a directory, sekrit path"));
    recordActivity(dir, "trading", "outbox-failed", outboxFailureSummary("append", "queued delivery for heartbeat 'stack watch'", "ENOENT: no such file"));
    recordActivity(dir, "sam", "outbox-failed", outboxFailureSummary("append", "delivered event for delivery 12345678", "EISDIR: illegal operation on a directory"));
    recordActivity(dir, "sam", "outbox-failed", outboxFailureSummary("append", "delivered event for delivery 12345678", "EISDIR: illegal operation on a directory"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = outboxFailedHistoryScorecardText(dir);
    assert.equal(text, "Outbox failed history: attention, 3 append, 1 read, 3 distinct labels, 4 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("ENOENT"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("stack watch"), false, "no job name surfaces");
    assert.equal(text.includes("12345678"), false, "no delivery id surfaces");
    assert.equal(text.includes("ledger"), false, "no label surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outbox failed history scorecard: the writer's own 200-char cap still folds from the label head", () => {
  const dir = scratch();
  try {
    const summary = outboxFailureSummary("append", "queued delivery for heartbeat 'stack watch'", "x".repeat(500));
    assert.equal(summary.length, 200, "the writer caps its line at 200");
    recordActivity(dir, "sam", "outbox-failed", summary);
    const parsed = parseOutboxFailedSummary(summary);
    assert.deepEqual(parsed, { phase: "append", label: "queued delivery for heartbeat 'stack watch'" });
    const text = outboxFailedHistoryScorecardText(dir);
    assert.equal(text, "Outbox failed history: attention, 1 append, 0 read, 1 distinct labels, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outbox failed history scorecard: an unmatched shape, an unknown label, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "outbox-failed", outboxFailureSummary("read", "ledger", "EISDIR: illegal operation on a directory"));
    recordActivity(dir, "sam", "outbox-failed", "Some wholly novel outbox shape naming sekrit_evidence");
    recordActivity(dir, "sam", "outbox-failed", "Delivery outbox append failed for some other store: boom sekrit");
    recordActivity(dir, "sam", "outbox-failed", "Delivery outbox read failed for ledger:   ");
    const text = outboxFailedHistoryScorecardText(dir);
    assert.equal(text, "Outbox failed history: attention, 0 append, 1 read, 1 distinct labels, 4 total, 3 unparseable");
    assert.equal(text.includes("novel outbox"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("other store"), false, "an unknown label is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outbox failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shapes parse", () => {
  assert.equal(
    outboxFailureSummary("read", "ledger", "EISDIR: illegal operation on a directory"),
    "Delivery outbox read failed for ledger: EISDIR: illegal operation on a directory",
  );
  assert.deepEqual(parseOutboxFailedSummary(outboxFailureSummary("append", "queued delivery for heartbeat 'stack watch'", "boom")), { phase: "append", label: "queued delivery for heartbeat 'stack watch'" });
  assert.deepEqual(parseOutboxFailedSummary(outboxFailureSummary("append", "attempt-failed event for heartbeat 'stack watch'", "boom")), { phase: "append", label: "attempt-failed event for heartbeat 'stack watch'" });
  assert.deepEqual(parseOutboxFailedSummary(outboxFailureSummary("append", "attempt-failed event for delivery abcdef01", "boom")), { phase: "append", label: "attempt-failed event for delivery abcdef01" });
  assert.deepEqual(parseOutboxFailedSummary(outboxFailureSummary("append", "suppressed event for delivery abcdef01", "boom")), { phase: "append", label: "suppressed event for delivery abcdef01" });
  assert.deepEqual(parseOutboxFailedSummary(outboxFailureSummary("read", "ledger", "boom")), { phase: "read", label: "ledger" });
  assert.equal(parseOutboxFailedSummary(""), null);
  assert.equal(parseOutboxFailedSummary("Delivery outbox read failed for ledger:"), null, "a line with no reason does not parse");
  assert.equal(parseOutboxFailedSummary("Delivery outbox read failed for ledger: "), null, "a line with a blank reason does not parse");
  assert.equal(parseOutboxFailedSummary("Delivery outbox read failed for outbox: boom"), null, "the read phase names only the ledger label");
  assert.equal(parseOutboxFailedSummary("Delivery outbox append failed for ledger: boom"), null, "the ledger label never parses as an append");
  assert.equal(parseOutboxFailedSummary("Team messages append failed for work ada -> cy: boom"), null, "a team-messages-failed line never parses as an outbox line");
  assert.equal(parseOutboxFailedSummary("Delivery failed for heartbeat 'stack watch' after 5 attempts: boom"), null, "a delivery-failed-shaped line never parses as an outbox line");
});

test("outbox failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-outbox-failed-history"), "sam-outbox-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-outbox-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["heartbeats", "outbox-failed-history"], "the argv rides heartbeats outbox-failed-history");
});
