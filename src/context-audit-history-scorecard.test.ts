import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  contextAuditHistoryScorecardText,
  contextAuditLedgerSummary,
  parseContextAuditSummary,
} from "./context-audit.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The context audit history daily-measurement wiring (2026-11-19,
// the measured-proof series): every recorded context audit has
// ledgered as a context-audit line since the audit landed - one
// line per run, in the fixed shape the seam writes, carrying the
// run's passed/total counts, its finding count, its profile
// count, and its heaviest profile load against the budget - but
// the class was never folded, so how many runs ever recorded,
// whether any run ever carried a finding, and how the heaviest
// load has moved against its budget was invisible in aggregate
// (the audit's own surfaces execute a run or read the last one
// from a singleton store; neither trends the history). The
// verdict is attention only when any finding was ever recorded
// or a line is unparseable: clean runs are the audit doing its
// job, a finding is the news, and the load trend rides the
// counts so a climb toward the cap is visible without alarming
// on it. The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no actor, no profile name, no finding text -
// a fold that printed findings would leak what the assembly
// risks losing. The scorecard path is a pure read - it creates
// nothing and runs no audit; every state here is built through
// the ledger's own public door (recordActivity) with the
// seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-context-audit-history-"));
}

test("context audit history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = contextAuditHistoryScorecardText(dir);
    assert.equal(text, "Context audit history: clear, 0 runs, 0 findings, latest heaviest 0 of 0, peak heaviest 0, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = contextAuditHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held context audit scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("context audit history scorecard: the history folds to counts with the latest and peak heaviest loads", () => {
  const dir = scratch();
  try {
    const clean = contextAuditHistoryScorecardText(dir);
    recordActivity(dir, "sam", "context-audit", contextAuditLedgerSummary(9, 9, 0, 6, 16056, 32000));
    recordActivity(dir, "sam", "context-audit", contextAuditLedgerSummary(10, 10, 0, 6, 18180, 32000));
    recordActivity(dir, "sam", "context-audit", contextAuditLedgerSummary(11, 11, 0, 6, 22399, 32000));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = contextAuditHistoryScorecardText(dir);
    assert.equal(text, "Context audit history: clear, 3 runs, 0 findings, latest heaviest 22399 of 32000, peak heaviest 22399, 3 total");
    assert.notEqual(text, clean, "the first recorded run changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("context audit history scorecard: the peak heaviest load outlives a later lighter run", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "context-audit", contextAuditLedgerSummary(11, 11, 0, 6, 22399, 32000));
    recordActivity(dir, "sam", "context-audit", contextAuditLedgerSummary(11, 11, 0, 6, 18000, 32000));
    const text = contextAuditHistoryScorecardText(dir);
    assert.equal(text, "Context audit history: clear, 2 runs, 0 findings, latest heaviest 18000 of 32000, peak heaviest 22399, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("context audit history scorecard: findings alone are attention, with no other signal needed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "context-audit", contextAuditLedgerSummary(10, 11, 2, 6, 22399, 32000));
    const text = contextAuditHistoryScorecardText(dir);
    assert.equal(text, "Context audit history: attention, 1 runs, 2 findings, latest heaviest 22399 of 32000, peak heaviest 22399, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("context audit history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "context-audit", contextAuditLedgerSummary(9, 9, 0, 6, 16056, 32000));
    recordActivity(dir, "sam", "context-audit", "Some wholly novel audit shape mentioning sekrit gaps");
    const text = contextAuditHistoryScorecardText(dir);
    assert.equal(text, "Context audit history: attention, 1 runs, 0 findings, latest heaviest 16056 of 32000, peak heaviest 16056, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel audit"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("context audit parse: the seam's own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    contextAuditLedgerSummary(9, 9, 0, 6, 16056, 32000),
    "Context audit recorded: 9/9 checks, 0 finding(s), 6 profile load(s), heaviest 16056 chars of 32000",
  );
  assert.equal(
    contextAuditLedgerSummary(10, 11, 2, 6, 22399, 32000),
    "Context audit recorded: 10/11 checks, 2 finding(s), 6 profile load(s), heaviest 22399 chars of 32000",
  );
  assert.deepEqual(parseContextAuditSummary(contextAuditLedgerSummary(9, 9, 0, 6, 16056, 32000)), { passed: 9, total: 9, findings: 0, profileCount: 6, heaviest: 16056, budget: 32000 });
  assert.equal(parseContextAuditSummary(""), null);
  assert.equal(parseContextAuditSummary("Context audit recorded: 12/11 checks, 0 finding(s), 6 profile load(s), heaviest 16056 chars of 32000"), null, "a passed count above its total does not parse");
  assert.equal(parseContextAuditSummary("Context audit recorded: 9/9 checks, 0 finding(s), 6 profile load(s), heaviest 16056 chars of 0"), null, "a zero budget does not parse");
  assert.equal(parseContextAuditSummary("Context audit recorded: 9/9 checks, 0 finding(s), 6 profile load(s)"), null, "a truncated line does not parse");
});

test("context audit history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-context-audit-history"), "sam-context-audit-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-context-audit-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["context-audit", "scorecard"], "the argv rides context-audit scorecard");
});
