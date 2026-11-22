import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseSubagentSummary, subagentCancelledLedgerSummary, subagentInterruptedLedgerSummary, subagentScorecardText, subagentSpawnLedgerSummary } from "./subagents.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The sub-agent lifecycle endings measurement (2026-11-22,
// the measured-proof series): the sub-agent scorecard folded
// four of the lifecycle's six kinds - spawn, done, failed,
// folded - while the other two endings were written inline
// with no writer, no parser, and no fold: subagent-cancelled
// at the cancelSubagent seam and subagent-interrupted at the
// listSubagents orphan sweep. A cancelled or interrupted
// child therefore showed as a spawn that never closed, and
// how many helpers ever ended either way was invisible in
// aggregate; the registry store holds only each child's
// current status, so these ledger lines are the only count
// either ending ever gets. The existing scorecard now folds
// all six stages - no second scorecard, because the daily
// sam-subagents script job already rides this one text. The
// verdict is attention when any child failed, any child was
// interrupted, or any line is unparseable, else clear: a
// cancellation is the owner's deliberate act (counted, not
// alarmed), an interruption is a process death and is itself
// the signal. The text carries counts only: no stamp, no
// actor, no child id, and no verbatim summary. The scorecard
// path is a pure read - it creates nothing, spends no model
// call, and spawns, cancels, and interrupts nothing; every
// state here is built through the ledger's own public door
// (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-subagent-lifecycle-endings-"));
}

test("subagent endings: a bare install reads clear with zero cancelled and interrupted, stable, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = subagentScorecardText(dir);
    assert.match(text, /^Sub-agents: clear$/m);
    assert.match(text, /^Cancelled: 0$/m);
    assert.match(text, /^Interrupted: 0$/m);
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

test("subagent endings: a cancellation folds to its count, joins the distinct count once, and stays clear because it is the owner's act", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "subagent-spawn", subagentSpawnLedgerSummary("aaaa1111bbbb2222", 1, 5, { rounds: 2, maxCalls: 5 }));
    recordActivity(dir, "sam", "subagent-cancelled", subagentCancelledLedgerSummary("aaaa1111bbbb2222"));
    recordActivity(dir, "sam", "subagent-cancelled", subagentCancelledLedgerSummary("cccc3333dddd4444"));
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = subagentScorecardText(dir);
    assert.match(text, /^Sub-agents: clear$/m, "a cancellation alone never flips the verdict");
    assert.match(text, /^Spawned: 1$/m);
    assert.match(text, /^Cancelled: 2$/m);
    assert.match(text, /^Interrupted: 0$/m);
    assert.match(text, /^Distinct children: 2$/m, "the spawned child's cancellation adds no second child, the unspawned cancellation adds its own");
    assert.equal(text.includes("aaaa1111"), false, "no child id surfaces");
    assert.equal(text.includes("cccc3333"), false, "no child id surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("subagent endings: an interruption folds to its count, joins the distinct count, and flips the verdict to attention", () => {
  const dir = scratch();
  try {
    const clean = subagentScorecardText(dir);
    recordActivity(dir, "sam", "subagent-spawn", subagentSpawnLedgerSummary("aaaa1111bbbb2222", 1, 5, { rounds: 2, maxCalls: 5 }));
    recordActivity(dir, "trading", "subagent-interrupted", subagentInterruptedLedgerSummary("aaaa1111bbbb2222"));
    const text = subagentScorecardText(dir);
    assert.match(text, /^Sub-agents: attention$/m, "an orphaned child is itself the signal");
    assert.match(text, /^Interrupted: 1$/m);
    assert.match(text, /^Cancelled: 0$/m);
    assert.match(text, /^Distinct children: 1$/m, "the interrupted child is the spawned child, counted once");
    assert.equal(text.includes("aaaa1111"), false, "no child id surfaces");
    assert.equal(text.includes("trading"), false, "no actor surfaces");
    assert.equal(text.includes("checkpoint kept"), false, "no verbatim summary surfaces");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the interrupted scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("subagent endings: malformed ending lines count under their kind, contribute no child, flip the verdict, and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "subagent-cancelled", "Cancelled sub-agent aaaa1111 for sekrit reasons");
    recordActivity(dir, "sam", "subagent-interrupted", "Sub-agent cccc3333 was still running when the sekrit thing happened");
    const text = subagentScorecardText(dir);
    assert.match(text, /^Sub-agents: attention$/m);
    assert.match(text, /^Cancelled: 1$/m);
    assert.match(text, /^Interrupted: 1$/m);
    assert.match(text, /^Distinct children: 0$/m, "an unmatched ending contributes no child count");
    assert.equal(text.includes("aaaa1111"), false, "no child id surfaces");
    assert.equal(text.includes("cccc3333"), false, "no child id surfaces");
    assert.equal(text.includes("sekrit"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("subagent endings parsers: the writers are byte-identical to the historical inline shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(subagentCancelledLedgerSummary("aaaa1111bbbb2222"), "Cancelled sub-agent aaaa1111");
  assert.equal(subagentInterruptedLedgerSummary("aaaa1111bbbb2222"), "Sub-agent aaaa1111 was still running when the process ended; checkpoint kept, tools not replayed");
  assert.deepEqual(parseSubagentSummary("subagent-cancelled", subagentCancelledLedgerSummary("aaaa1111bbbb2222")), { child: "aaaa1111" });
  assert.deepEqual(parseSubagentSummary("subagent-interrupted", subagentInterruptedLedgerSummary("aaaa1111bbbb2222")), { child: "aaaa1111" });
  assert.equal(parseSubagentSummary("subagent-cancelled", ""), null);
  assert.equal(parseSubagentSummary("subagent-cancelled", "Cancelled sub-agent aaaa1111 extra words"), null, "trailing words do not parse as a cancellation");
  assert.equal(parseSubagentSummary("subagent-interrupted", "Sub-agent aaaa1111 was still running when the process ended"), null, "a truncated interrupted sentence does not parse");
  assert.equal(parseSubagentSummary("subagent-cancelled", subagentInterruptedLedgerSummary("aaaa1111bbbb2222")), null, "an interrupted line never parses as a cancellation");
  assert.equal(parseSubagentSummary("subagent-interrupted", subagentCancelledLedgerSummary("aaaa1111bbbb2222")), null, "a cancelled line never parses as an interruption");
  assert.equal(parseSubagentSummary("subagent-spawn", subagentCancelledLedgerSummary("aaaa1111bbbb2222")), null, "a cancelled line never parses as a spawn");
});

test("subagent endings: the script allowlist rides the extended CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-subagents"), "sam-subagents is allowlisted");
  const argv = scriptArgv("/some/root", "sam-subagents");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["subagent", "scorecard"], "the argv rides subagent scorecard");
});
