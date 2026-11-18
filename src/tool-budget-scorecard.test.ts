import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { budgetLedgerSummary, parseToolBudgetEnding, toolBudgetScorecardText } from "./budgets.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The tool-budget daily-measurement wiring (2026-11-18,
// the measured-proof series): the graceful-exhaustion seam
// ledgers every turn that ends on its budget, and self-work
// ranks the class as a top recurring defect - but no daily
// surface ever counted it, so a turn that kept truncating
// its work was invisible until the owner watched it happen.
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it carries counts only: no
// stamp, no actor, no tool name, no verbatim summary -
// endings fold into the two fixed shapes the seam writes
// and an unmatched shape is "other", never printed. The
// scorecard path is a pure read - it creates nothing,
// spends no model call, and retries nothing; every state
// here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer
// (budgetLedgerSummary), never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-tool-budget-scorecard-"));
}

test("tool budget scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = toolBudgetScorecardText(dir);
    assert.match(text, /^Tool budget endings: clear$/m);
    assert.match(text, /^Ended turns: 0$/m);
    assert.match(text, /^By end: none$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = toolBudgetScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held tool-budget scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tool budget scorecard: ended turns flip the verdict, fold to fixed ends, and leak no content", () => {
  const dir = scratch();
  try {
    const clean = toolBudgetScorecardText(dir);
    recordActivity(dir, "sam", "tool-budget", budgetLedgerSummary(["sekrit_tool", "sam_code"], ["sam_read_skill"], 6));
    recordActivity(dir, "dip", "tool-budget", budgetLedgerSummary(["sekrit_tool"], [], 4));
    recordActivity(dir, "sam", "tool-budget", budgetLedgerSummary(["sekrit_tool", "sam_code"], [], 6, "steps"));
    recordActivity(dir, "sam", "tool-budget", "Some wholly novel ending shape mentioning sekrit_tool");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = toolBudgetScorecardText(dir);
    assert.match(text, /^Tool budget endings: attention$/m);
    assert.match(text, /^Ended turns: 4$/m);
    assert.match(text, /^By end: calls 2, other 1, steps 1$/m);
    assert.equal(text.includes("sekrit"), false, "no tool name surfaces");
    assert.equal(text.includes("novel ending"), false, "an unmatched summary is never printed");
    assert.notEqual(text, clean, "the first ended turn changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tool budget parse: every fixed shape classifies, and only into the fixed enum", () => {
  assert.equal(parseToolBudgetEnding(budgetLedgerSummary(["a"], [], 6)), "calls");
  assert.equal(parseToolBudgetEnding(budgetLedgerSummary(["a"], ["b"], 6, "steps")), "steps");
  assert.equal(parseToolBudgetEnding(""), "other");
  assert.equal(parseToolBudgetEnding("Some wholly novel ending shape"), "other");
});

test("tool budget scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-tool-budget"), "sam-tool-budget is allowlisted");
  const argv = scriptArgv("/some/root", "sam-tool-budget");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "budget-scorecard"], "the argv rides observe budget-scorecard");
});
