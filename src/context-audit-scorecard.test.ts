import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { CONTEXT_AUDIT_SCRIPT, contextAuditText, readContextAudit, runContextAudit } from "./context-audit.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";
import { writeStandingFile } from "./standing-files.js";

// The context audit's daily-measurement wiring (2026-11-17,
// mirroring the eval battery's 13:04, task battery's 14:04,
// answer judge's 15:04, self-audit's 16:04, and prompt audit's
// 17:04 fixes): the context audit last ran on the box on
// 2026-11-13 while the assembly it measures kept changing
// (compaction, the loader-loop guard, the census sprint), and
// no heartbeat job refreshed it. contextAuditText is the
// script job's stdout and is P3-diffed on its facts, so it
// carries no clock reading (the record's `at` stamp is an ISO
// date fact and would announce "changed" daily at an identical
// score). Two consecutive runs at the same state produce
// byte-identical text P3 judges the same news; a real context
// change still changes the text.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-context-audit-scorecard-")); }

test("context-audit scorecard: two consecutive runs are byte-identical, clock-free, and P3-silent", () => {
  const root = fresh();
  try {
    const first = runContextAudit(root);
    const second = runContextAudit(root);
    assert.match(String(readContextAudit(root)?.at), /^\d{4}-\d{2}-\d{2}T/, "the recorded record keeps its stamp");
    const text = contextAuditText(second);
    assert.match(text, /^Context audit - \d+\/\d+ checks passed$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    const again = contextAuditText(first);
    assert.equal(again, text, "two runs at the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held context score the same news",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("context-audit scorecard: a real context change still changes the text", () => {
  const root = fresh();
  try {
    const before = contextAuditText(runContextAudit(root));
    assert.match(before, /Findings: none/);
    writeStandingFile(root, "sam", "persona", "A measured persona line for the context scorecard test.");
    const after = contextAuditText(runContextAudit(root));
    assert.notEqual(after, before, "a standing file growing the measured load changes the scorecard");
    assert.match(after, /sam: \d+ chars \(standing [1-9]\d*,/, "the load line carries the new standing chars");
    assert.doesNotMatch(after, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the changed text either");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("context-audit scorecard: sam-context-audit is allowlisted and rides the context-audit run door", () => {
  assert.ok(scriptCommandNames().includes(CONTEXT_AUDIT_SCRIPT));
  const argv = scriptArgv(fresh(), CONTEXT_AUDIT_SCRIPT);
  assert.equal(argv[0], process.execPath);
  assert.ok(argv.some(a => a.endsWith("cli.js")));
  assert.ok(argv.includes("context-audit") && argv.includes("run"));
});
