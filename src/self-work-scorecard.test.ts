import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";
import { runSelfAudit } from "./self-audit.js";
import { SELF_WORK_SCRIPT, runSelfWork, selfWorkText } from "./self-work.js";

// The self-work scorecard's P3-silence wiring (2026-11-17,
// mirroring the eval battery's 13:04 through backup drill's
// 20:04 fixes): self-work is the one daily script job WITH a
// channel, and its text carried three clock readings - the
// run's own stamp in the header, the self-audit's stamp in
// the capability line, and each ranked class's last-sighting
// stamp - so P3 fact diffing read a fresh date fact every
// day and the job could never be silent, even on a perfectly
// quiet ledger. The recorded run keeps every stamp; the
// text keeps only the facts (counts, labels, the spec, the
// digests). Two consecutive runs over an unchanged ledger
// produce byte-identical text P3 judges the same news; a
// real change (a count moving) still changes the text.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-self-work-scorecard-")); }

function seedLedger(root: string): void {
  recordActivity(root, "trading", "tool-budget", "Tool budget exhausted: 6/6 calls used (sam_load_tools); not executed: mcp_stack_health");
  recordActivity(root, "trading", "tool-budget", "Turn step limit reached: 1 calls used (sam_load_tools) - the call budget (4) was NOT reached");
  recordActivity(root, "dip", "tool-budget", "Tool budget exhausted: 5/6 calls used (sam_read_skill)");
  recordActivity(root, "trading", "heartbeat-failed", "Heartbeat 'stack watch' failed: Unsafe model output");
  recordActivity(root, "sam", "turn", "Answered in chat abc");
}

test("self-work scorecard: two consecutive runs over an unchanged ledger are byte-identical, stamp-free, and P3-silent", () => {
  const root = fresh();
  try {
    seedLedger(root);
    runSelfAudit(root, {});
    const first = runSelfWork(root);
    assert.ok(first.at, "the recorded run keeps its stamp");
    assert.ok(first.auditAt, "the recorded run keeps the audit stamp");
    assert.ok(first.ranked[0].lastAt, "the recorded ranking keeps last-sighting stamps");
    const text = selfWorkText(first);
    assert.match(text, /^Self-work$/m);
    assert.match(text, /Capability map: self-audit recorded/);
    assert.match(text, /- tool-budget: 3x - /);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no clock reading in the text");
    const second = runSelfWork(root);
    assert.notEqual(second.at, first.at, "the two runs really are distinct runs with distinct stamps");
    const again = selfWorkText(second);
    assert.equal(again, text, "two runs over an unchanged ledger produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held queue the same news",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-work scorecard: a count moving is still news", () => {
  const root = fresh();
  try {
    seedLedger(root);
    runSelfAudit(root, {});
    const before = selfWorkText(runSelfWork(root));
    assert.match(before, /- tool-budget: 3x - /);
    recordActivity(root, "dip", "tool-budget", "Tool budget exhausted: 6/6 calls used (sam_load_tools)");
    const after = selfWorkText(runSelfWork(root));
    assert.notEqual(after, before, "one more ledgered defect changes the scorecard");
    assert.match(after, /- tool-budget: 4x - /, "the ranked line carries the new count");
    assert.doesNotMatch(after, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no clock reading in the changed text either");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-work scorecard: the seeded known-defect state is stable across runs", () => {
  const root = fresh();
  try {
    const text = selfWorkText(runSelfWork(root));
    assert.match(text, /known defect, seeded/);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no clock reading in the empty-ledger text");
    assert.equal(selfWorkText(runSelfWork(root)), text, "the seeded state is stable across runs");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-work scorecard: sam-self-work is allowlisted and rides the self-work work door", () => {
  assert.ok(scriptCommandNames().includes(SELF_WORK_SCRIPT));
  const argv = scriptArgv(fresh(), SELF_WORK_SCRIPT);
  assert.equal(argv[0], process.execPath);
  assert.ok(argv.some(a => a.endsWith("cli.js")));
  assert.ok(argv.includes("self-work") && argv.includes("work"));
});
