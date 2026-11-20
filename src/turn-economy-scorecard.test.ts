import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  budgetContinuedSummary,
  parseBudgetContinuedSummary,
  parseToolRepeatSummary,
  repeatLedgerSummary,
  turnEconomyExtrasScorecardText,
} from "./budgets.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The turn-economy-extras daily-measurement wiring
// (2026-11-20, the measured-proof series, census-finish
// sprint): every owner turn that continued past its standard
// budget and every duplicate tool call the loop suppressed
// has ledgered as a budget-continued / tool-repeat line
// since each seam landed - one line per act, in the fixed
// shapes the seams write, carrying the continuation's call
// and round counts and the suppressed calls' tool names -
// but the classes were never folded, so how hard the turn
// economy's guardrails were working was invisible in
// aggregate. Both classes are the guardrail working as
// designed, so the verdict is attention only when a line is
// unparseable. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, no tool name - a fold
// that printed tool names would change on every new
// suppressed call even at an identical shape. The scorecard
// path is a pure read - it creates nothing, retries nothing,
// and continues nothing; every state here is built through
// the ledger's own public door (recordActivity) with the
// seams' own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-turn-economy-"));
}

test("turn economy extras scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = turnEconomyExtrasScorecardText(dir);
    assert.equal(text, "Turn economy extras: clear, 0 continuations (0 calls, 0 rounds), 0 repeat suppressions (0 suppressed calls), 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = turnEconomyExtrasScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held turn economy scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn economy extras scorecard: the live census shape folds to counts and no tool name surfaces", () => {
  const dir = scratch();
  try {
    const clean = turnEconomyExtrasScorecardText(dir);
    recordActivity(dir, "owner", "budget-continued", budgetContinuedSummary(1, Array.from({ length: 39 }, () => "sam_code"), 30));
    recordActivity(dir, "owner", "budget-continued", budgetContinuedSummary(1, Array.from({ length: 40 }, () => "sam_code"), 30));
    recordActivity(dir, "owner", "tool-repeat", repeatLedgerSummary(["sam_code"]));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = turnEconomyExtrasScorecardText(dir);
    assert.equal(text, "Turn economy extras: clear, 2 continuations (79 calls, 60 rounds), 1 repeat suppressions (1 suppressed calls), 3 total");
    assert.equal(text.includes("sam_code"), false, "no tool name surfaces");
    assert.notEqual(text, clean, "the first economy extra changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn economy extras scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "owner", "budget-continued", budgetContinuedSummary(1, Array.from({ length: 5 }, () => "sam_code"), 3));
    recordActivity(dir, "owner", "tool-repeat", "Some wholly novel repeat shape mentioning sekrit tools");
    const text = turnEconomyExtrasScorecardText(dir);
    assert.equal(text, "Turn economy extras: attention, 1 continuations (5 calls, 3 rounds), 0 repeat suppressions (0 suppressed calls), 1 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn economy parse: the seams' own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    budgetContinuedSummary(1, Array.from({ length: 39 }, () => "sam_code"), 30),
    "Owner turn continued past its standard budget (tranche 1): 39 calls over 30 rounds so far - the turn keeps going instead of ending on a budget message",
  );
  assert.equal(
    repeatLedgerSummary(["sam_code"]),
    "Duplicate tool calls suppressed in one turn: 1 (sam_code) - identical repeats returned the earlier result instead of re-executing",
  );
  assert.equal(
    repeatLedgerSummary(["sam_code", "sam_read"]),
    "Duplicate tool calls suppressed in one turn: 2 (sam_code, sam_read) - identical repeats returned the earlier result instead of re-executing",
  );
  assert.deepEqual(parseBudgetContinuedSummary(budgetContinuedSummary(2, Array.from({ length: 7 }, () => "x"), 4)), { tranche: 2, calls: 7, rounds: 4 });
  assert.deepEqual(parseToolRepeatSummary(repeatLedgerSummary(["sam_code", "sam_read"])), { suppressed: 2 });
  assert.equal(parseBudgetContinuedSummary(""), null);
  assert.equal(parseBudgetContinuedSummary("Owner turn continued past its standard budget"), null, "a truncated continuation line does not parse");
  assert.equal(parseToolRepeatSummary("Duplicate tool calls suppressed in one turn: 1"), null, "a truncated repeat line does not parse");
  assert.equal(parseToolRepeatSummary("Some wholly novel repeat shape"), null);
});

test("turn economy extras scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-turn-economy-extras"), "sam-turn-economy-extras is allowlisted");
  const argv = scriptArgv("/some/root", "sam-turn-economy-extras");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "economy-scorecard"], "the argv rides observe economy-scorecard");
});
