import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseSubagentSummary, subagentCancelledLedgerSummary, subagentDoneLedgerSummary, subagentFoldedLedgerSummary, subagentFailedSummary, subagentInterruptedLedgerSummary, subagentScorecardText, subagentSpawnLedgerSummary } from "./subagents.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The sub-agent daily-measurement wiring (2026-11-18, the
// measured-proof series): every invisible helper SAM spawns
// ledgers its lifecycle across six activity kinds - spawn,
// done, failed, folded, cancelled, interrupted - carrying the child's id prefix
// and, on the done and failed lines, free text (the
// result's head, the failure reason), but no daily surface
// ever counted the lifecycle, so delegation going silent or
// a rising child failure share was invisible in aggregate.
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it carries counts only: no
// stamp, no actor, no child id, no role, no chat id, no
// result text, and no reason - a child's result and reason
// are its work product and its failure's detail, and
// neither belongs in a trending surface; an unmatched shape
// counts under its kind and contributes no child count,
// never printed. The scorecard path is a pure read - it
// creates nothing, spends no model call, and spawns
// nothing; every state here is built through the ledger's
// own public door (recordActivity) with the seams' own
// summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-subagent-scorecard-"));
}

test("subagent scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = subagentScorecardText(dir);
    assert.match(text, /^Sub-agents: clear$/m);
    assert.match(text, /^Spawned: 0$/m);
    assert.match(text, /^Done: 0$/m);
    assert.match(text, /^Failed: 0$/m);
    assert.match(text, /^Folded: 0$/m);
    assert.match(text, /^Cancelled: 0$/m);
    assert.match(text, /^Interrupted: 0$/m);
    assert.match(text, /^Distinct children: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = subagentScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held sub-agent scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("subagent scorecard: the lifecycle folds to counts, a failure or a malformed line flips the verdict, and no child, result, or reason leaks", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "subagent-spawn", subagentSpawnLedgerSummary("aaaa1111bbbb2222", 1, 5, { rounds: 2, maxCalls: 5 }));
    recordActivity(dir, "sam", "subagent-spawn", subagentSpawnLedgerSummary("cccc3333dddd4444", 1, 1, { rounds: 2, maxCalls: 4 }));
    recordActivity(dir, "sam", "subagent-done", subagentDoneLedgerSummary("aaaa1111bbbb2222", "research", "sekrit result text"));
    recordActivity(dir, "sam", "subagent-folded", subagentFoldedLedgerSummary("aaaa1111bbbb2222", "eeee5555ffff6666"));
    const clean = subagentScorecardText(dir);
    assert.match(clean, /^Sub-agents: clear$/m);
    assert.match(clean, /^Spawned: 2$/m);
    assert.match(clean, /^Done: 1$/m);
    assert.match(clean, /^Failed: 0$/m);
    assert.match(clean, /^Folded: 1$/m);
    assert.match(clean, /^Cancelled: 0$/m);
    assert.match(clean, /^Interrupted: 0$/m);
    assert.match(clean, /^Distinct children: 2$/m);
    recordActivity(dir, "sam", "subagent-failed", subagentFailedSummary("cccc3333dddd4444", new Error("sekrit failure reason")));
    recordActivity(dir, "sam", "subagent-spawn", "Some wholly novel spawn shape mentioning aaaa1111");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = subagentScorecardText(dir);
    assert.match(text, /^Sub-agents: attention$/m);
    assert.match(text, /^Spawned: 3$/m);
    assert.match(text, /^Done: 1$/m);
    assert.match(text, /^Failed: 1$/m);
    assert.match(text, /^Folded: 1$/m);
    assert.match(text, /^Cancelled: 0$/m);
    assert.match(text, /^Interrupted: 0$/m);
    assert.match(text, /^Distinct children: 2$/m);
    assert.equal(text.includes("aaaa1111"), false, "no child id surfaces");
    assert.equal(text.includes("cccc3333"), false, "no child id surfaces");
    assert.equal(text.includes("eeee5555"), false, "no chat id surfaces");
    assert.equal(text.includes("research"), false, "no role surfaces");
    assert.equal(text.includes("sekrit"), false, "no result text or reason surfaces");
    assert.equal(text.includes("novel spawn"), false, "an unmatched summary is never printed");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("subagent parse: the seams' own lines parse, and only the fixed shapes parse", () => {
  assert.deepEqual(parseSubagentSummary("subagent-spawn", subagentSpawnLedgerSummary("aaaa1111bbbb2222", 1, 5, { rounds: 2, maxCalls: 5 })), { child: "aaaa1111" });
  assert.deepEqual(parseSubagentSummary("subagent-done", subagentDoneLedgerSummary("aaaa1111bbbb2222", "build", "did the thing")), { child: "aaaa1111" });
  assert.deepEqual(parseSubagentSummary("subagent-failed", subagentFailedSummary("aaaa1111bbbb2222", new Error("boom"))), { child: "aaaa1111" });
  assert.deepEqual(parseSubagentSummary("subagent-folded", subagentFoldedLedgerSummary("aaaa1111bbbb2222", "eeee5555ffff6666")), { child: "aaaa1111" });
  assert.deepEqual(parseSubagentSummary("subagent-cancelled", subagentCancelledLedgerSummary("aaaa1111bbbb2222")), { child: "aaaa1111" });
  assert.deepEqual(parseSubagentSummary("subagent-interrupted", subagentInterruptedLedgerSummary("aaaa1111bbbb2222")), { child: "aaaa1111" });
  assert.equal(subagentSpawnLedgerSummary("aaaa1111bbbb2222", 1, 5, { rounds: 2, maxCalls: 5 }), "Sub-agent aaaa1111 depth 1 tools 5 budget 2x5", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(subagentDoneLedgerSummary("aaaa1111bbbb2222", "build", "line one\nline  two"), "Sub-agent aaaa1111 (build) returned: line one line two", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(subagentFoldedLedgerSummary("aaaa1111bbbb2222", "eeee5555ffff6666"), "Folded aaaa1111 into chat eeee5555", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(subagentCancelledLedgerSummary("aaaa1111bbbb2222"), "Cancelled sub-agent aaaa1111", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(subagentInterruptedLedgerSummary("aaaa1111bbbb2222"), "Sub-agent aaaa1111 was still running when the process ended; checkpoint kept, tools not replayed", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(parseSubagentSummary("subagent-spawn", ""), null);
  assert.equal(parseSubagentSummary("subagent-done", "Some wholly novel shape"), null);
  assert.equal(parseSubagentSummary("subagent-spawn", subagentDoneLedgerSummary("aaaa1111bbbb2222", "build", "did the thing")), null, "a done line never parses as a spawn");
  assert.equal(parseSubagentSummary("subagent-cancelled", subagentInterruptedLedgerSummary("aaaa1111bbbb2222")), null, "an interrupted line never parses as a cancellation");
  assert.equal(parseSubagentSummary("subagent-interrupted", subagentCancelledLedgerSummary("aaaa1111bbbb2222")), null, "a cancelled line never parses as an interruption");
  assert.equal(parseSubagentSummary("turn", subagentSpawnLedgerSummary("aaaa1111bbbb2222", 1, 5, { rounds: 2, maxCalls: 5 })), null, "an unknown kind never parses");
});

test("subagent scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-subagents"), "sam-subagents is allowlisted");
  const argv = scriptArgv("/some/root", "sam-subagents");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["subagent", "scorecard"], "the argv rides subagent scorecard");
});
