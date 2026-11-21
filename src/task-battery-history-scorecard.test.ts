import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseTaskBatterySummary, taskBatteryHistoryScorecardText, taskBatteryLedgerSummary } from "./task-battery.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The task battery history daily-measurement wiring (2026-11-20,
// the measured-proof series): every recorded task battery run
// has ledgered as a task-battery line since the battery landed -
// until now as inline concatenation at the seam, with no ONE
// writer and no fold, so how many runs ever recorded, how their
// scores and live states split, and whether the battery ever
// passed clean was invisible in aggregate (the battery's own
// surfaces execute a run or read the last stored scorecard per
// version; neither trends the history - the eval battery's
// history fold is the sibling this one was left behind by). A
// run that fell short is the battery naming a real job Sam
// cannot yet do, so the verdict is attention only when any
// finding was ever recorded, any run fell short of a full pass,
// or a line is unparseable. The scorecard text is a script job's
// stdout and is P3-diffed on its facts, so it is ONE line
// carrying counts only: no stamp, no actor, no version string,
// no case label, no evidence - the summaries carry the version
// and scores, which the fold consumes into counts and never
// prints beyond the fixed live vocabulary. The scorecard path
// is a pure read - it creates nothing and runs no battery case;
// every state here is built through the ledger's own public
// door (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-task-battery-history-"));
}

test("task battery history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = taskBatteryHistoryScorecardText(dir);
    assert.equal(text, "Task battery history: clear, 0 runs, 0 findings, latest 0/0 passed, not-requested 0, pending-keys 0, pending-ruling 0, 0 versions, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = taskBatteryHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held task battery scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("task battery history scorecard: the history folds to counts, live buckets are summed, and no version or evidence surfaces", () => {
  const dir = scratch();
  try {
    const clean = taskBatteryHistoryScorecardText(dir);
    recordActivity(dir, "sam", "task-battery", taskBatteryLedgerSummary("s4.1", 5, 5, "not-requested", 0));
    recordActivity(dir, "sam", "task-battery", taskBatteryLedgerSummary("s4.1", 5, 5, "pending-keys", 0));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = taskBatteryHistoryScorecardText(dir);
    assert.equal(text, "Task battery history: clear, 2 runs, 0 findings, latest 5/5 passed, not-requested 1, pending-keys 1, pending-ruling 0, 1 versions, 2 total");
    assert.equal(text.includes("s4.1"), false, "no version string surfaces");
    assert.notEqual(text, clean, "the first recorded run changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("task battery history scorecard: a run that fell short is attention and stays attention after a later clean run", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "task-battery", taskBatteryLedgerSummary("s4.1", 4, 5, "not-requested", 1));
    recordActivity(dir, "sam", "task-battery", taskBatteryLedgerSummary("s5.0", 5, 5, "pending-ruling", 0));
    const text = taskBatteryHistoryScorecardText(dir);
    assert.equal(text, "Task battery history: attention, 2 runs, 1 findings, latest 5/5 passed, not-requested 1, pending-keys 0, pending-ruling 1, 2 versions, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("task battery history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "task-battery", taskBatteryLedgerSummary("s4.1", 5, 5, "not-requested", 0));
    recordActivity(dir, "sam", "task-battery", "Some wholly novel battery shape naming sekrit_evidence");
    const text = taskBatteryHistoryScorecardText(dir);
    assert.equal(text, "Task battery history: attention, 1 runs, 0 findings, latest 5/5 passed, not-requested 1, pending-keys 0, pending-ruling 0, 1 versions, 2 total, 1 unparseable");
    assert.equal(text.includes("novel battery"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_evidence"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("task battery parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(taskBatteryLedgerSummary("s4.1", 4, 5, "not-requested", 1), "Task battery s4.1 recorded: 4/5 passed, live not-requested, 1 finding(s)");
  assert.deepEqual(parseTaskBatterySummary(taskBatteryLedgerSummary("s4.1", 4, 5, "not-requested", 1)), { version: "s4.1", passed: 4, total: 5, liveRun: "not-requested", findings: 1 });
  assert.deepEqual(parseTaskBatterySummary(taskBatteryLedgerSummary("s5.0", 5, 5, "pending-ruling", 0)), { version: "s5.0", passed: 5, total: 5, liveRun: "pending-ruling", findings: 0 });
  assert.equal(parseTaskBatterySummary(""), null);
  assert.equal(parseTaskBatterySummary("Task battery s4.1 recorded: 4/5 passed, live not-requested, 0 finding(s)"), null, "a finding count that is not total-passed does not parse");
  assert.equal(parseTaskBatterySummary("Task battery s4.1 recorded: 6/5 passed, live not-requested, 0 finding(s)"), null, "a passed count above its total does not parse");
  assert.equal(parseTaskBatterySummary("Task battery s4.1 recorded: 4/5 passed, live whenever, 1 finding(s)"), null, "an unknown live state does not parse");
  assert.equal(parseTaskBatterySummary("Task battery s4.1 recorded: 4/5 passed, live not-requested"), null, "a truncated line does not parse");
  assert.equal(parseTaskBatterySummary("Task battery s4.1 recorded: 4/5 passed, live not-requested, 1 finding(s) extra"), null, "trailing text does not parse");
});

test("task battery history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-task-battery-history"), "sam-task-battery-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-task-battery-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["battery", "scorecard"], "the argv rides battery scorecard");
});
