import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseTurnDeadlineSummary, turnDeadlineLedgerSummary, turnDeadlineScorecardText } from "./turn-control.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The turn-deadline daily-measurement wiring (2026-11-18,
// the measured-proof series): both chat loops ledger every
// turn the wall-clock deadline closes, with the calls and
// rounds already spent - but no daily surface ever counted
// the class, so a chat surface hitting its deadline
// regularly was invisible until the owner watched a turn
// stall. The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it carries counts only: no
// stamp, no actor, no tool name, no deadline reading, no
// verbatim summary - the calls and rounds fold from each
// line's own accounting, and a line that matches no shape
// counts as a hit and contributes nothing. The scorecard
// path is a pure read - it creates nothing, spends no model
// call, and retries nothing; every state here is built
// through the ledger's own public door (recordActivity)
// with the turn control's own summary writer
// (turnDeadlineLedgerSummary), never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-turn-deadline-scorecard-"));
}

test("turn deadline scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = turnDeadlineScorecardText(dir);
    assert.match(text, /^Turn deadlines: clear$/m);
    assert.match(text, /^Deadline-hit turns: 0$/m);
    assert.match(text, /^Calls before deadline: 0$/m);
    assert.match(text, /^Rounds before deadline: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = turnDeadlineScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held turn-deadline scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn deadline scorecard: deadline-hit turns flip the verdict, fold calls and rounds, and leak no content", () => {
  const dir = scratch();
  try {
    const clean = turnDeadlineScorecardText(dir);
    recordActivity(dir, "sam", "turn-deadline", turnDeadlineLedgerSummary(["sam_code", "sam_code"], 3, 180_000));
    recordActivity(dir, "sam", "turn-deadline", turnDeadlineLedgerSummary(["sam_reach"], 2, 180_000));
    recordActivity(dir, "sam", "turn-deadline", "some unmatched deadline line naming sam_code at 180s");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = turnDeadlineScorecardText(dir);
    assert.match(text, /^Turn deadlines: attention$/m);
    assert.match(text, /^Deadline-hit turns: 3$/m);
    assert.match(text, /^Calls before deadline: 3$/m);
    assert.match(text, /^Rounds before deadline: 5$/m);
    assert.equal(text.includes("sam_code"), false, "no tool name surfaces");
    assert.equal(text.includes("180"), false, "no deadline reading surfaces");
    assert.notEqual(text, clean, "the first deadline-hit turn changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn deadline parsing: only the fixed ledger shape yields its accounting", () => {
  assert.deepEqual(parseTurnDeadlineSummary(turnDeadlineLedgerSummary(["a", "b"], 4, 180_000)), { calls: 2, rounds: 4 });
  assert.deepEqual(parseTurnDeadlineSummary(turnDeadlineLedgerSummary([], 1, 3_000)), { calls: 0, rounds: 1 });
  assert.equal(parseTurnDeadlineSummary("Interactive turn hit its deadline eventually"), null);
  assert.equal(parseTurnDeadlineSummary("some other line"), null);
  assert.equal(parseTurnDeadlineSummary(""), null);
});

test("turn deadline scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-turn-deadlines"), "sam-turn-deadlines is allowlisted");
  const argv = scriptArgv("/some/root", "sam-turn-deadlines");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "deadline-scorecard"], "the argv rides observe deadline-scorecard");
});
