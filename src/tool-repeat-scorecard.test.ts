import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseToolRepeatSummary, repeatLedgerSummary, toolRepeatScorecardText } from "./budgets.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The tool-repeat daily-measurement wiring (2026-11-20, the
// measured-proof series): both chat loops have ledgered a
// tool-repeat line through the ONE writer (repeatLedgerSummary
// in budgets.ts) whenever the repeat guard suppresses duplicate
// tool calls inside a turn - but the class was never folded, so
// how often the model repeats itself and how many calls the
// guard saves was invisible in aggregate. Suppression is the
// guard working as designed, so the verdict is attention only
// when a line is unparseable. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE line
// carrying counts only: no stamp, no actor, no tool name - the
// summaries carry the repeated tool names, which the fold
// consumes into a distinct count and never prints. The
// scorecard path is a pure read - it creates nothing and
// suppresses nothing; every state here is built through the
// ledger's own public door (recordActivity) with the seam's
// own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-tool-repeat-scorecard-"));
}

test("tool repeat scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = toolRepeatScorecardText(dir);
    assert.equal(text, "Tool repeats: clear, 0 turns, 0 suppressed, 0 distinct tools, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = toolRepeatScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held repeat scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tool repeat scorecard: the class folds to counts, and no tool name surfaces", () => {
  const dir = scratch();
  try {
    const clean = toolRepeatScorecardText(dir);
    recordActivity(dir, "sam", "tool-repeat", repeatLedgerSummary(["sekrit_tool"]));
    recordActivity(dir, "dip", "tool-repeat", repeatLedgerSummary(["sekrit_tool", "sam_code", "sekrit_tool"]));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = toolRepeatScorecardText(dir);
    assert.equal(text, "Tool repeats: clear, 2 turns, 4 suppressed, 2 distinct tools, 2 total");
    assert.equal(text.includes("sekrit_tool"), false, "no tool name surfaces");
    assert.equal(text.includes("sam_code"), false, "no tool name surfaces");
    assert.notEqual(text, clean, "the first recorded repeat changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tool repeat scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "dip", "tool-repeat", repeatLedgerSummary(["sam_code"]));
    recordActivity(dir, "dip", "tool-repeat", "Some wholly novel repeat shape naming sekrit_tool");
    const text = toolRepeatScorecardText(dir);
    assert.equal(text, "Tool repeats: attention, 1 turns, 1 suppressed, 1 distinct tools, 2 total, 1 unparseable");
    assert.equal(text.includes("novel repeat"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_tool"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tool repeat parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(repeatLedgerSummary(["sam_code"]), "Duplicate tool calls suppressed in one turn: 1 (sam_code) - identical repeats returned the earlier result instead of re-executing");
  assert.deepEqual(parseToolRepeatSummary(repeatLedgerSummary(["sam_code"])), { suppressed: 1, tools: ["sam_code"] });
  assert.deepEqual(parseToolRepeatSummary(repeatLedgerSummary(["a", "b", "a"])), { suppressed: 3, tools: ["a", "b", "a"] });
  assert.equal(parseToolRepeatSummary(""), null);
  assert.equal(parseToolRepeatSummary("Duplicate tool calls suppressed in one turn: 2 (sam_code) - identical repeats returned the earlier result instead of re-executing"), null, "a count that disagrees with the list does not parse");
  assert.equal(parseToolRepeatSummary("Duplicate tool calls suppressed in one turn: 1 () - identical repeats returned the earlier result instead of re-executing"), null, "an empty tool list does not parse");
  assert.equal(parseToolRepeatSummary("Duplicate tool calls suppressed in one turn: 1 (sam_code)"), null, "a truncated line does not parse");
});

test("tool repeat scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-tool-repeats"), "sam-tool-repeats is allowlisted");
  const argv = scriptArgv("/some/root", "sam-tool-repeats");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "repeat-scorecard"], "the argv rides observe repeat-scorecard");
});
