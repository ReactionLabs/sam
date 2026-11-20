import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  evalBatteryLedgerSummary,
  evalBatteryScorecardText,
  parseEvalBatterySummary,
} from "./eval-battery.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The eval battery history daily-measurement wiring (2026-11-19,
// the measured-proof series): every recorded battery run has
// ledgered as an eval-battery line since the battery landed -
// one line per run, in the fixed shape the seam writes, carrying
// the run's passed/total counts, its verdict against the
// previous run, and its finding count - but the class was never
// folded, so how many runs ever recorded, how their verdicts
// split, and whether the ship gate ever fired was invisible in
// aggregate (the battery's own surfaces execute a run or read
// the last one; neither trends the history). The verdict is
// attention only when a run regressed, any finding was ever
// recorded, or a line is unparseable: held and improved runs are
// the battery doing its job, a regression or a finding is the
// news. The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no actor, no task label, no finding text - a
// fold that printed findings would leak what the harness lacks
// and change on every new run even at an identical shape. The
// scorecard path is a pure read - it creates nothing and runs
// no battery task; every state here is built through the
// ledger's own public door (recordActivity) with the seam's own
// summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-eval-battery-scorecard-"));
}

test("eval battery scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = evalBatteryScorecardText(dir);
    assert.equal(text, "Eval battery history: clear, 0 runs, first-run 0, improved 0, held 0, regressed 0, 0 findings, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = evalBatteryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held eval battery scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("eval battery scorecard: the history folds to counts per verdict bucket with findings summed", () => {
  const dir = scratch();
  try {
    const clean = evalBatteryScorecardText(dir);
    recordActivity(dir, "sam", "eval-battery", evalBatteryLedgerSummary(21, 21, "first-run", null, 0));
    recordActivity(dir, "sam", "eval-battery", evalBatteryLedgerSummary(21, 21, "held", { passed: 21, total: 21 }, 0));
    recordActivity(dir, "sam", "eval-battery", evalBatteryLedgerSummary(22, 22, "improved", { passed: 21, total: 21 }, 0));
    recordActivity(dir, "sam", "eval-battery", evalBatteryLedgerSummary(22, 22, "held", { passed: 22, total: 22 }, 0));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = evalBatteryScorecardText(dir);
    assert.equal(text, "Eval battery history: clear, 4 runs, first-run 1, improved 1, held 2, regressed 0, 0 findings, 4 total");
    assert.notEqual(text, clean, "the first recorded run changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("eval battery scorecard: a regressed run is attention even after a later run improves past it", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "eval-battery", evalBatteryLedgerSummary(20, 22, "regressed", { passed: 22, total: 22 }, 2));
    recordActivity(dir, "sam", "eval-battery", evalBatteryLedgerSummary(22, 22, "improved", { passed: 20, total: 22 }, 0));
    const text = evalBatteryScorecardText(dir);
    assert.equal(text, "Eval battery history: attention, 2 runs, first-run 0, improved 1, held 0, regressed 1, 2 findings, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("eval battery scorecard: findings alone are attention, with no regression needed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "eval-battery", evalBatteryLedgerSummary(22, 22, "held", { passed: 22, total: 22 }, 1));
    const text = evalBatteryScorecardText(dir);
    assert.equal(text, "Eval battery history: attention, 1 runs, first-run 0, improved 0, held 1, regressed 0, 1 findings, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("eval battery scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "eval-battery", evalBatteryLedgerSummary(21, 21, "first-run", null, 0));
    recordActivity(dir, "sam", "eval-battery", "Some wholly novel battery shape mentioning sekrit gaps");
    const text = evalBatteryScorecardText(dir);
    assert.equal(text, "Eval battery history: attention, 1 runs, first-run 1, improved 0, held 0, regressed 0, 0 findings, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel battery"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("eval battery parse: the seam's own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    evalBatteryLedgerSummary(21, 21, "first-run", null, 0),
    "Eval battery recorded: 21/21 tasks, verdict first-run, 0 finding(s)",
  );
  assert.equal(
    evalBatteryLedgerSummary(22, 22, "improved", { passed: 21, total: 21 }, 0),
    "Eval battery recorded: 22/22 tasks, verdict improved (was 21/21), 0 finding(s)",
  );
  assert.equal(
    evalBatteryLedgerSummary(20, 22, "regressed", { passed: 22, total: 22 }, 2),
    "Eval battery recorded: 20/22 tasks, verdict regressed (was 22/22), 2 finding(s)",
  );
  assert.deepEqual(parseEvalBatterySummary(evalBatteryLedgerSummary(21, 21, "first-run", null, 0)), { passed: 21, total: 21, verdict: "first-run", previousPassed: null, previousTotal: null, findings: 0 });
  assert.deepEqual(parseEvalBatterySummary(evalBatteryLedgerSummary(22, 22, "improved", { passed: 21, total: 21 }, 0)), { passed: 22, total: 22, verdict: "improved", previousPassed: 21, previousTotal: 21, findings: 0 });
  assert.equal(parseEvalBatterySummary(""), null);
  assert.equal(parseEvalBatterySummary("Eval battery recorded: 21/21 tasks, verdict first-run (was 20/21), 0 finding(s)"), null, "a first-run line carrying a previous clause does not parse");
  assert.equal(parseEvalBatterySummary("Eval battery recorded: 21/21 tasks, verdict held, 0 finding(s)"), null, "a non-first-run line with no previous clause does not parse");
  assert.equal(parseEvalBatterySummary("Eval battery recorded: 21/21 tasks, verdict sideways (was 21/21), 0 finding(s)"), null, "an unknown verdict does not parse");
  assert.equal(parseEvalBatterySummary("Eval battery recorded: 23/21 tasks, verdict held (was 21/21), 0 finding(s)"), null, "a passed count above its total does not parse");
  assert.equal(parseEvalBatterySummary("Eval battery recorded: 21/21 tasks, verdict held (was 21/21)"), null, "a truncated line does not parse");
});

test("eval battery scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-eval-battery-history"), "sam-eval-battery-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-eval-battery-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["eval-battery", "scorecard"], "the argv rides eval-battery scorecard");
});
