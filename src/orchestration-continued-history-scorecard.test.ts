import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { orchestrationContinuedHireLedgerSummary, orchestrationContinuedTeamLedgerSummary, orchestrationContinuedHistoryScorecardText, parseOrchestrationContinuedHireSummary, parseOrchestrationContinuedTeamSummary } from "./budgets.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The orchestration continuation history daily-measurement
// wiring (2026-11-21, the measured-proof series): every time
// a hire or a team plan outgrows a turn's spawn-pool tranche
// and the turn continues into its next tranche instead of
// refusing the work, own-tools ledgers one
// "orchestration-continued" line - a hire shape or a team
// shape - but neither shape was ever folded, so how often
// turns had to refill their pool was invisible in aggregate;
// no store holds these events (the tranche lives only in the
// turn's in-memory spawn-pool context), so these ledger
// lines are the only record a continuation ever happened. A
// continuation is a recovery, not a failure, so the verdict
// is attention only when a line is unparseable, else clear.
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no actor, and no verbatim summary. The
// scorecard path is a pure read - it creates nothing, hires
// nothing, plans nothing, and opens no store; every state
// here is built through the ledger's own public door
// (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-orchestration-continued-history-"));
}

const BARE = "Orchestration continued history: clear, 0 hire, 0 team, 0 distinct tranches, 0 total";

test("orchestration continued history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = orchestrationContinuedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = orchestrationContinuedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held orchestration continued scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("orchestration continued history scorecard: recorded continuations fold to counts with distinct tranches as a number only", () => {
  const dir = scratch();
  try {
    const clean = orchestrationContinuedHistoryScorecardText(dir);
    recordActivity(dir, "sekritactor", "orchestration-continued", orchestrationContinuedHireLedgerSummary(2));
    recordActivity(dir, "sekritactor", "orchestration-continued", orchestrationContinuedHireLedgerSummary(3));
    recordActivity(dir, "sekritactor", "orchestration-continued", orchestrationContinuedTeamLedgerSummary(2));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = orchestrationContinuedHistoryScorecardText(dir);
    assert.equal(text, "Orchestration continued history: clear, 2 hire, 1 team, 2 distinct tranches, 3 total");
    assert.equal(text.includes("sekrit"), false, "no actor surfaces");
    assert.notEqual(text, clean, "the first recorded continuation changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("orchestration continued history scorecard: an unmatched shape is attention, counts toward the total and the unparseable count, and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sekritactor", "orchestration-continued", orchestrationContinuedHireLedgerSummary(2));
    recordActivity(dir, "sekritactor", "orchestration-continued", "A sekrit pool quietly refilled");
    const text = orchestrationContinuedHistoryScorecardText(dir);
    assert.equal(text, "Orchestration continued history: attention, 1 hire, 0 team, 1 distinct tranches, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("orchestration continued parsers: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(orchestrationContinuedHireLedgerSummary(2), "Hiring continued into tranche 2 of this turn: the spawn pool refilled instead of refusing the hire");
  assert.deepEqual(parseOrchestrationContinuedHireSummary(orchestrationContinuedHireLedgerSummary(2)), { tranche: 2 });
  assert.equal(orchestrationContinuedTeamLedgerSummary(3), "Team hiring continued into tranche 3 of this turn: the worker pool refilled instead of refusing the plan");
  assert.deepEqual(parseOrchestrationContinuedTeamSummary(orchestrationContinuedTeamLedgerSummary(3)), { tranche: 3 });
  assert.equal(parseOrchestrationContinuedHireSummary(""), null);
  assert.equal(parseOrchestrationContinuedHireSummary("Hiring continued into tranche two of this turn: the spawn pool refilled instead of refusing the hire"), null, "a spelled-out tranche does not parse");
  assert.equal(parseOrchestrationContinuedHireSummary("Hiring continued into tranche 2 of this turn: the spawn pool refilled instead of refusing the hire tonight"), null, "a line with trailing free text does not parse");
  assert.equal(parseOrchestrationContinuedTeamSummary(""), null);
  assert.equal(parseOrchestrationContinuedTeamSummary(orchestrationContinuedHireLedgerSummary(2)), null, "a hire line is not a team line");
  assert.equal(parseOrchestrationContinuedHireSummary(orchestrationContinuedTeamLedgerSummary(2)), null, "a team line is not a hire line");
});

test("orchestration continued history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-orchestration-continued-history"), "sam-orchestration-continued-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-orchestration-continued-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["orchestrate", "continued-history"], "the argv rides orchestrate continued-history");
});
