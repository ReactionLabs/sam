import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { budgetGuardrailHistoryScorecardText, guardrailLedgerSummary, parseBudgetGuardrailSummary, OWNER_CHAT_CEILING } from "./budgets.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The budget guardrail history daily-measurement wiring
// (2026-11-22, the measured-proof series): the owner-turn
// hard ceiling trips ledger as budget-guardrail lines
// through the ONE writer guardrailLedgerSummary (both chat
// loops ride it), and self-work ranks the class as a defect
// - but the class was never folded, so how often a turn has
// ever hit the hard ceiling, whether it tripped on calls or
// on rounds, how many calls it burned, and how many were
// left unexecuted was invisible in aggregate. Every trip is
// a runaway turn the ceiling had to stop, so the verdict is
// attention when any trip was ever recorded or any line is
// unparseable, else clear. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no tool
// name - the summaries carry tool names, which the fold
// consumes into a distinct count and never prints. The
// stored shapes are two: the writer's full shape and the
// ledger's 300-char capped shape, whose header still parses
// exactly. The scorecard path is a pure read - it creates
// nothing, spends no model call, and stops nothing; every
// state here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-budget-guardrail-history-"));
}

const BARE = "Budget guardrail history: clear, 0 trips, calls 0 / rounds 0, 0 calls used, 0 not executed, 0 distinct tools, 0 total";

test("budget guardrail history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = budgetGuardrailHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = budgetGuardrailHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held budget guardrail scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("budget guardrail history scorecard: both writer shapes fold to counts, and no tool name surfaces", () => {
  const dir = scratch();
  try {
    const clean = budgetGuardrailHistoryScorecardText(dir);
    recordActivity(dir, "sam", "budget-guardrail", guardrailLedgerSummary(["sekrit_tool", "sam_code"], ["sam_read_skill"], OWNER_CHAT_CEILING, "calls"));
    recordActivity(dir, "dip", "budget-guardrail", guardrailLedgerSummary(["sekrit_tool"], [], OWNER_CHAT_CEILING, "calls"));
    recordActivity(dir, "sam", "budget-guardrail", guardrailLedgerSummary(["sam_code", "sam_code", "other_tool"], [], OWNER_CHAT_CEILING, "steps"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = budgetGuardrailHistoryScorecardText(dir);
    assert.equal(text, "Budget guardrail history: attention, 3 trips, calls 2 / rounds 1, 6 calls used, 1 not executed, 3 distinct tools, 3 total");
    assert.equal(text.includes("sekrit"), false, "no tool name surfaces");
    assert.equal(text.includes("sam_code"), false, "no tool name surfaces");
    assert.notEqual(text, clean, "the first recorded trip changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("budget guardrail history scorecard: a capped live line still folds from its header, and its partial tail name is never counted", () => {
  const dir = scratch();
  try {
    const many = Array.from({ length: 40 }, (_, i) => "tool_name_number_" + String(i).padStart(2, "0"));
    const full = guardrailLedgerSummary(many, [], OWNER_CHAT_CEILING, "calls");
    assert.ok(full.length > 300, "the writer's full shape overruns the ledger cap");
    recordActivity(dir, "sam", "budget-guardrail", full);
    const stored = readActivity(dir, 10, { kind: "budget-guardrail" });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.summary.length, 300, "the ledger capped the line at 300");
    const parsed = parseBudgetGuardrailSummary(stored[0]?.summary ?? "");
    assert.ok(parsed, "the capped line parses from its header");
    assert.equal(parsed?.complete, false);
    assert.equal(parsed?.executed, 40, "the header's executed count survives the cap");
    assert.equal(parsed?.ceiling, 300);
    const text = budgetGuardrailHistoryScorecardText(dir);
    assert.ok(text.startsWith("Budget guardrail history: attention, 1 trips, calls 1 / rounds 0, 40 calls used, 0 not executed,"), "the scorecard folds the capped line: " + text);
    assert.ok(text.endsWith("1 total"), "the capped line counts once in the total: " + text);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("budget guardrail history scorecard: an unmatched shape and a header-lying shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "budget-guardrail", guardrailLedgerSummary(["alpha"], [], OWNER_CHAT_CEILING, "calls"));
    recordActivity(dir, "sam", "budget-guardrail", "Some wholly novel guardrail shape naming sekrit_evidence");
    recordActivity(dir, "sam", "budget-guardrail", "Owner turn hit the internal budget guardrail (calls): 5/300 calls used (only_one) - closed with a synthesis from gathered material");
    const text = budgetGuardrailHistoryScorecardText(dir);
    assert.equal(text, "Budget guardrail history: attention, 1 trips, calls 1 / rounds 0, 1 calls used, 0 not executed, 1 distinct tools, 3 total, 2 unparseable");
    assert.equal(text.includes("novel guardrail"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("only_one"), false, "a header-lying line's list is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("budget guardrail parse: the writer is byte-identical to both ledgered shapes and parses, and only the fixed shapes parse", () => {
  assert.equal(
    guardrailLedgerSummary(["a", "b"], ["c"], OWNER_CHAT_CEILING, "calls"),
    "Owner turn hit the internal budget guardrail (calls): 2/300 calls used (a, b) - closed with a synthesis from gathered material; not executed: c",
  );
  assert.equal(
    guardrailLedgerSummary(["a"], [], OWNER_CHAT_CEILING, "steps"),
    "Owner turn hit the internal budget guardrail (rounds): 60 rounds used with 1 calls (a) - closed with a synthesis from gathered material",
  );
  assert.deepEqual(parseBudgetGuardrailSummary(guardrailLedgerSummary(["a", "b"], ["c"], OWNER_CHAT_CEILING, "calls")), { reason: "calls", executed: 2, ceiling: 300, skipped: 1, tools: ["a", "b"], complete: true });
  assert.deepEqual(parseBudgetGuardrailSummary(guardrailLedgerSummary(["a"], [], OWNER_CHAT_CEILING, "steps")), { reason: "rounds", executed: 1, ceiling: 60, skipped: 0, tools: ["a"], complete: true });
  assert.deepEqual(parseBudgetGuardrailSummary(guardrailLedgerSummary([], [], OWNER_CHAT_CEILING, "calls")), { reason: "calls", executed: 0, ceiling: 300, skipped: 0, tools: [], complete: true });
  assert.equal(parseBudgetGuardrailSummary(""), null);
  assert.equal(parseBudgetGuardrailSummary("Tool budget exhausted: 6/6 calls used (a)"), null, "a tool-budget line never parses as a guardrail line");
  assert.equal(parseBudgetGuardrailSummary("Owner turn hit the internal budget guardrail (banana): 2/300 calls used (a, b) - closed with a synthesis from gathered material"), null, "a reason outside the fixed vocabulary does not parse");
  assert.equal(parseBudgetGuardrailSummary("Owner turn hit the internal budget guardrail (calls): 2/300 calls used (a, b)"), null, "a short line missing its suffix does not parse");
});

test("budget guardrail history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-budget-guardrail-history"), "sam-budget-guardrail-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-budget-guardrail-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "budget-guardrail-history"], "the argv rides observe budget-guardrail-history");
});
