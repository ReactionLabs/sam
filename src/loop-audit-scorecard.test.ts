import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { LOOP_AUDIT_SCRIPT, loopAuditText, readLoopAudit, runLoopAudit } from "./loop-audit.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";
import { recordChange } from "./verification.js";

// The loop audit's daily-measurement wiring (2026-11-17,
// mirroring the eval battery's 13:04, task battery's 14:04,
// answer judge's 15:04, self-audit's 16:04, prompt audit's
// 17:04, and context audit's 18:04 fixes): the loop audit
// last ran on the box on 2026-11-12 while the loop machinery
// it measures kept changing (the loader-loop guard, the
// turn-economy guard, the split verification close, the
// census sprint), and no heartbeat job refreshed it.
// loopAuditText is the script job's stdout and is P3-diffed
// on its facts, so it carries no clock reading (the record's
// `at` stamp is an ISO date fact and would announce
// "changed" daily at an identical score). Two consecutive
// runs at the same state produce byte-identical text P3
// judges the same news; a real loop change still changes
// the text.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-loop-audit-scorecard-")); }

test("loop-audit scorecard: two consecutive runs are byte-identical, clock-free, and P3-silent", () => {
  const root = fresh();
  try {
    const first = runLoopAudit(root);
    const second = runLoopAudit(root);
    assert.match(String(readLoopAudit(root)?.at), /^\d{4}-\d{2}-\d{2}T/, "the recorded record keeps its stamp");
    const text = loopAuditText(second);
    assert.match(text, /^Loop audit - \d+\/\d+ checks passed$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    const again = loopAuditText(first);
    assert.equal(again, text, "two runs at the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held loop score the same news",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop-audit scorecard: a real loop change still changes the text", () => {
  const root = fresh();
  try {
    const before = loopAuditText(runLoopAudit(root));
    assert.match(before, /Findings: none/);
    assert.match(before, /verification clean, open loops 0 \(0 due\)/);
    recordChange(root, { path: "src/probe.ts", replacementHash: "probe-hash", source: "loop-audit-scorecard" });
    const after = loopAuditText(runLoopAudit(root));
    assert.notEqual(after, before, "an unverified change moving the live verification state changes the scorecard");
    assert.match(after, /verification unverified, open loops 0 \(0 due\)/, "the live state line carries the new verification state");
    assert.doesNotMatch(after, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the changed text either");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop-audit scorecard: sam-loop-audit is allowlisted and rides the loop-audit run door", () => {
  assert.ok(scriptCommandNames().includes(LOOP_AUDIT_SCRIPT));
  const argv = scriptArgv(fresh(), LOOP_AUDIT_SCRIPT);
  assert.equal(argv[0], process.execPath);
  assert.ok(argv.some(a => a.endsWith("cli.js")));
  assert.ok(argv.includes("loop-audit") && argv.includes("run"));
});
