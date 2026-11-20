import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  loopAuditHistoryScorecardText,
  loopAuditLedgerSummary,
  parseLoopAuditSummary,
} from "./loop-audit.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The loop audit history daily-measurement wiring (2026-11-20,
// the measured-proof series): every recorded loop audit has
// ledgered as a loop-audit line since the audit landed - one
// line per run, in the fixed shape the seam writes, carrying
// the run's passed/total counts, its finding count, and the
// live loop state it measured (the verification ledger's
// state and the open/due loop counts) - but the class was
// never folded, so how many runs ever recorded, whether any
// run ever carried a finding, and how the measured install's
// verification mix has moved was invisible in aggregate (the
// audit's own surfaces execute a run or read the last one
// from a singleton store; neither trends the history). The
// verdict is attention only when any finding was ever
// recorded, any run measured a failed verification, or a
// line is unparseable: clean runs are the audit doing its
// job, a finding or a failed verification is the news, and
// an unverified reading (ordinary pending work) rides the
// bucket counts without alarming. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it
// is ONE line carrying counts only: no stamp, no actor, no
// finding text - a fold that printed findings would leak
// which loop machinery is missing. The scorecard path is a
// pure read - it creates nothing and runs no audit; every
// state here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer, never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-loop-audit-history-"));
}

test("loop audit history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = loopAuditHistoryScorecardText(dir);
    assert.equal(text, "Loop audit history: clear, 0 runs, 0 findings, latest 0/0 checks, verification clean 0 / verified 0 / failed 0 / unverified 0, latest open loops 0, latest due loops 0, peak open loops 0, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = loopAuditHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held loop audit scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop audit history scorecard: the history folds to counts with the latest score and the verification mix", () => {
  const dir = scratch();
  try {
    const clean = loopAuditHistoryScorecardText(dir);
    recordActivity(dir, "sam", "loop-audit", loopAuditLedgerSummary(10, 10, 0, "clean", 0, 0));
    recordActivity(dir, "sam", "loop-audit", loopAuditLedgerSummary(11, 11, 0, "unverified", 0, 0));
    recordActivity(dir, "sam", "loop-audit", loopAuditLedgerSummary(11, 11, 0, "unverified", 2, 1));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = loopAuditHistoryScorecardText(dir);
    assert.equal(text, "Loop audit history: clear, 3 runs, 0 findings, latest 11/11 checks, verification clean 1 / verified 0 / failed 0 / unverified 2, latest open loops 2, latest due loops 1, peak open loops 2, 3 total");
    assert.notEqual(text, clean, "the first recorded run changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop audit history scorecard: the peak open-loop count outlives a later quieter install", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "loop-audit", loopAuditLedgerSummary(11, 11, 0, "verified", 5, 2));
    recordActivity(dir, "sam", "loop-audit", loopAuditLedgerSummary(11, 11, 0, "clean", 1, 0));
    const text = loopAuditHistoryScorecardText(dir);
    assert.equal(text, "Loop audit history: clear, 2 runs, 0 findings, latest 11/11 checks, verification clean 1 / verified 1 / failed 0 / unverified 0, latest open loops 1, latest due loops 0, peak open loops 5, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop audit history scorecard: findings alone are attention, with no other signal needed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "loop-audit", loopAuditLedgerSummary(9, 11, 2, "clean", 0, 0));
    const text = loopAuditHistoryScorecardText(dir);
    assert.equal(text, "Loop audit history: attention, 1 runs, 2 findings, latest 9/11 checks, verification clean 1 / verified 0 / failed 0 / unverified 0, latest open loops 0, latest due loops 0, peak open loops 0, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop audit history scorecard: a failed verification alone is attention, with no finding needed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "loop-audit", loopAuditLedgerSummary(11, 11, 0, "failed", 0, 0));
    const text = loopAuditHistoryScorecardText(dir);
    assert.equal(text, "Loop audit history: attention, 1 runs, 0 findings, latest 11/11 checks, verification clean 0 / verified 0 / failed 1 / unverified 0, latest open loops 0, latest due loops 0, peak open loops 0, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop audit history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "loop-audit", loopAuditLedgerSummary(11, 11, 0, "clean", 0, 0));
    recordActivity(dir, "sam", "loop-audit", "Some wholly novel audit shape mentioning sekrit gaps");
    const text = loopAuditHistoryScorecardText(dir);
    assert.equal(text, "Loop audit history: attention, 1 runs, 0 findings, latest 11/11 checks, verification clean 1 / verified 0 / failed 0 / unverified 0, latest open loops 0, latest due loops 0, peak open loops 0, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel audit"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loop audit parse: the seam's own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    loopAuditLedgerSummary(10, 10, 0, "clean", 0, 0),
    "Loop audit recorded: 10/10 checks, 0 finding(s), verification clean, open loops 0 (0 due)",
  );
  assert.equal(
    loopAuditLedgerSummary(11, 11, 0, "unverified", 3, 1),
    "Loop audit recorded: 11/11 checks, 0 finding(s), verification unverified, open loops 3 (1 due)",
  );
  assert.deepEqual(parseLoopAuditSummary(loopAuditLedgerSummary(11, 11, 0, "unverified", 3, 1)), { passed: 11, total: 11, findings: 0, verification: "unverified", openLoops: 3, dueLoops: 1 });
  assert.equal(parseLoopAuditSummary(""), null);
  assert.equal(parseLoopAuditSummary("Loop audit recorded: 12/11 checks, 0 finding(s), verification clean, open loops 0 (0 due)"), null, "a passed count above its total does not parse");
  assert.equal(parseLoopAuditSummary("Loop audit recorded: 0/0 checks, 0 finding(s), verification clean, open loops 0 (0 due)"), null, "a zero total does not parse");
  assert.equal(parseLoopAuditSummary("Loop audit recorded: 11/11 checks, 0 finding(s), verification bogus, open loops 0 (0 due)"), null, "an unknown verification state does not parse");
  assert.equal(parseLoopAuditSummary("Loop audit recorded: 11/11 checks, 0 finding(s), verification clean, open loops 1 (2 due)"), null, "due loops above open loops does not parse");
  assert.equal(parseLoopAuditSummary("Loop audit recorded: 11/11 checks, 0 finding(s)"), null, "a truncated line does not parse");
});

test("loop audit history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-loop-audit-history"), "sam-loop-audit-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-loop-audit-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["loop-audit", "scorecard"], "the argv rides loop-audit scorecard");
});
