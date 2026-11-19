import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { orchestrationHiredLedgerSummary, orchestrationJobDoneLedgerSummary, orchestrationLaneDoneLedgerSummary, orchestrationLaneFailedLedgerSummary, orchestrationLaneReplacedLedgerSummary, orchestrationPlannedLedgerSummary, orchestrationScorecardText, parseOrchestrationSummary } from "./orchestration.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The orchestration daily-measurement wiring (2026-11-19,
// the measured-proof series): every job SAM runs as a team
// ledgers its lifecycle across six activity kinds - planned,
// hired, lane-done, lane-replaced, lane-failed, job-done -
// carrying job prefixes, lane names, and, on the replaced
// and failed lines, the failure's head, but no daily surface
// ever counted the lifecycle, so orchestration going silent,
// lanes dying and being replaced, or jobs closing with
// nothing verified was invisible in aggregate. The scorecard
// text is a script job's stdout and is P3-diffed on its
// facts, so it carries counts only: no stamp, no actor, no
// job id, no lane name, no coordinator name, and no failure
// text - a lane's failure is its job's detail, and it does
// not belong in a trending surface; an unmatched shape counts
// under its kind as unparseable and contributes nothing
// else, never printed. The verdict is attention when any
// lane failed or was replaced, any job closed short of done,
// or any line is unparseable. The scorecard path is a pure
// read - it creates nothing, spends no model call, plans
// nothing, and runs nothing; every state here is built
// through the ledger's own public door (recordActivity) with
// the seams' own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-orchestration-scorecard-"));
}

test("orchestration scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = orchestrationScorecardText(dir);
    assert.match(text, /^Orchestration: clear$/m);
    assert.match(text, /^Jobs planned: 0$/m);
    assert.match(text, /^Lanes hired: 0$/m);
    assert.match(text, /^Lanes verified: 0$/m);
    assert.match(text, /^Lanes replaced: 0$/m);
    assert.match(text, /^Lanes failed: 0$/m);
    assert.match(text, /^Jobs closed: 0$/m);
    assert.match(text, /^Lanes planned: 0$/m);
    assert.match(text, /^Verified at close: 0 of 0$/m);
    assert.match(text, /^Closed outcomes: done 0, partial 0, blocked 0, other 0$/m);
    assert.match(text, /^Distinct jobs: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = orchestrationScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held orchestration scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("orchestration scorecard: a clean job folds to counts and stays clear, leaking no job, lane, or coordinator", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "orchestration-planned", orchestrationPlannedLedgerSummary("aaaa1111bbbb2222", ["sekrit-lane", "other-lane"]));
    recordActivity(dir, "sam", "orchestration-hired", orchestrationHiredLedgerSummary("worker-lane", "sekrit-coordinator", 2));
    recordActivity(dir, "sam", "orchestration-lane-done", orchestrationLaneDoneLedgerSummary("sekrit-lane", "aaaa1111bbbb2222", 1));
    recordActivity(dir, "sam", "orchestration-job-done", orchestrationJobDoneLedgerSummary("aaaa1111bbbb2222", "done", 2, 2));
    const text = orchestrationScorecardText(dir);
    assert.match(text, /^Orchestration: clear$/m);
    assert.match(text, /^Jobs planned: 1$/m);
    assert.match(text, /^Lanes hired: 1$/m);
    assert.match(text, /^Lanes verified: 1$/m);
    assert.match(text, /^Lanes replaced: 0$/m);
    assert.match(text, /^Lanes failed: 0$/m);
    assert.match(text, /^Jobs closed: 1$/m);
    assert.match(text, /^Lanes planned: 2$/m);
    assert.match(text, /^Verified at close: 2 of 2$/m);
    assert.match(text, /^Closed outcomes: done 1, partial 0, blocked 0, other 0$/m);
    assert.match(text, /^Distinct jobs: 1$/m);
    assert.equal(text.includes("aaaa1111"), false, "no job id surfaces");
    assert.equal(text.includes("sekrit"), false, "no lane or coordinator name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("orchestration scorecard: a dead lane, a blocked close, or a malformed line flips the verdict, and no failure leaks", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "orchestration-planned", orchestrationPlannedLedgerSummary("aaaa1111bbbb2222", ["lane-one", "lane-two"]));
    recordActivity(dir, "sam", "orchestration-lane-replaced", orchestrationLaneReplacedLedgerSummary("lane-one", "aaaa1111bbbb2222", "sekrit failure one"));
    recordActivity(dir, "sam", "orchestration-lane-failed", orchestrationLaneFailedLedgerSummary("lane-two", "aaaa1111bbbb2222", "sekrit failure two"));
    recordActivity(dir, "sam", "orchestration-job-done", orchestrationJobDoneLedgerSummary("aaaa1111bbbb2222", "blocked", 0, 2));
    recordActivity(dir, "sam", "orchestration-planned", "Some wholly novel planned shape mentioning cccc3333");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = orchestrationScorecardText(dir);
    assert.match(text, /^Orchestration: attention$/m);
    assert.match(text, /^Jobs planned: 2$/m);
    assert.match(text, /^Lanes replaced: 1$/m);
    assert.match(text, /^Lanes failed: 1$/m);
    assert.match(text, /^Jobs closed: 1$/m);
    assert.match(text, /^Lanes planned: 2$/m);
    assert.match(text, /^Verified at close: 0 of 2$/m);
    assert.match(text, /^Closed outcomes: done 0, partial 0, blocked 1, other 0$/m);
    assert.match(text, /^Distinct jobs: 1$/m);
    assert.match(text, /^Unparseable: 1$/m);
    assert.equal(text.includes("aaaa1111"), false, "no job id surfaces");
    assert.equal(text.includes("cccc3333"), false, "no job id surfaces");
    assert.equal(text.includes("lane-one"), false, "no lane name surfaces");
    assert.equal(text.includes("sekrit"), false, "no failure text surfaces");
    assert.equal(text.includes("novel planned"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("orchestration parse: the seams' own lines parse, and only the fixed shapes parse", () => {
  assert.deepEqual(parseOrchestrationSummary("orchestration-planned", orchestrationPlannedLedgerSummary("aaaa1111bbbb2222", ["one", "two"])), { job: "aaaa1111", lanes: 2 });
  assert.deepEqual(parseOrchestrationSummary("orchestration-hired", orchestrationHiredLedgerSummary("worker", "coord", 2)), {});
  assert.deepEqual(parseOrchestrationSummary("orchestration-lane-done", orchestrationLaneDoneLedgerSummary("lane", "aaaa1111bbbb2222", 3)), { job: "aaaa1111" });
  assert.deepEqual(parseOrchestrationSummary("orchestration-lane-replaced", orchestrationLaneReplacedLedgerSummary("lane", "aaaa1111bbbb2222", "boom")), { job: "aaaa1111" });
  assert.deepEqual(parseOrchestrationSummary("orchestration-lane-failed", orchestrationLaneFailedLedgerSummary("lane", "aaaa1111bbbb2222", null)), { job: "aaaa1111" });
  assert.deepEqual(parseOrchestrationSummary("orchestration-job-done", orchestrationJobDoneLedgerSummary("aaaa1111bbbb2222", "partial", 1, 3)), { job: "aaaa1111", status: "partial", verified: 1, total: 3 });
  assert.equal(orchestrationPlannedLedgerSummary("aaaa1111bbbb2222", ["one", "two"]), "Job aaaa1111: 2 lane(s) planned (one, two)", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(orchestrationHiredLedgerSummary("worker", "coord", 2), "Lane worker opened under coordinator coord at depth 2", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(orchestrationLaneDoneLedgerSummary("lane", "aaaa1111bbbb2222", 3), "Lane lane verified for job aaaa1111 (attempt 3)", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(orchestrationLaneReplacedLedgerSummary("lane", "aaaa1111bbbb2222", null), "Lane lane worker retired and replaced in job aaaa1111: failed", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(orchestrationLaneFailedLedgerSummary("lane", "aaaa1111bbbb2222", null), "Lane lane failed in job aaaa1111: ", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(orchestrationJobDoneLedgerSummary("aaaa1111bbbb2222", "blocked", 0, 2), "Job aaaa1111 closed blocked: 0/2 lane(s) verified", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(parseOrchestrationSummary("orchestration-planned", ""), null);
  assert.equal(parseOrchestrationSummary("orchestration-job-done", "Some wholly novel shape"), null);
  assert.equal(parseOrchestrationSummary("orchestration-planned", orchestrationJobDoneLedgerSummary("aaaa1111bbbb2222", "done", 1, 1)), null, "a job-done line never parses as a planned");
  assert.equal(parseOrchestrationSummary("turn", orchestrationPlannedLedgerSummary("aaaa1111bbbb2222", ["one"])), null, "an unknown kind never parses");
});

test("orchestration scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-orchestration"), "sam-orchestration is allowlisted");
  const argv = scriptArgv("/some/root", "sam-orchestration");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["orchestrate", "scorecard"], "the argv rides orchestrate scorecard");
});
