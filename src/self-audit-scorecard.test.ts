import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCodeRoot } from "./code.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";
import { SELF_AUDIT_SCRIPT, readSelfAudit, runSelfAudit, selfAuditText } from "./self-audit.js";

// The self-audit's daily-measurement wiring (2026-11-17,
// mirroring the eval battery's 13:04, task battery's 14:04,
// and answer judge's 15:04 fixes): the capability map last
// ran on the box on 2026-11-12 while the daily self-work job
// grounds its defect specs in that recorded map, and no
// heartbeat job refreshed it. selfAuditText is the script
// job's stdout and is P3-diffed on its facts, so it carries
// no clock reading (the record's `at` stamp is an ISO date
// fact and would announce "changed" daily at an identical
// map). Two consecutive runs at the same state produce
// byte-identical text P3 judges the same news; a real
// capability change still changes the text.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-self-audit-scorecard-")); }

test("self-audit scorecard: two consecutive runs are byte-identical, clock-free, and P3-silent", () => {
  const root = fresh();
  try {
    const first = runSelfAudit(root, {});
    const second = runSelfAudit(root, {});
    assert.match(String(readSelfAudit(root)?.at), /^\d{4}-\d{2}-\d{2}T/, "the recorded record keeps its stamp");
    const text = selfAuditText(second);
    assert.match(text, /^Capability self-audit$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    const again = selfAuditText(first);
    assert.equal(again, text, "two runs at the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held self-audit map the same news",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-audit scorecard: a real capability change still changes the text", () => {
  const root = fresh();
  const codeRoot = fresh();
  try {
    writeFileSync(join(codeRoot, "package.json"), JSON.stringify({ name: "x", scripts: { build: "true", test: "true" } }));
    const before = selfAuditText(runSelfAudit(root, {}));
    assert.match(before, /coder hands: no code root is designated/);
    setCodeRoot(root, codeRoot);
    const after = selfAuditText(runSelfAudit(root, {}));
    assert.notEqual(after, before, "designating a code root changes the map");
    assert.match(after, /coder hands in the code root/);
    assert.doesNotMatch(after, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the changed text either");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(codeRoot, { recursive: true, force: true }); }
});

test("self-audit scorecard: sam-self-audit is allowlisted and rides the self-audit run door", () => {
  assert.ok(scriptCommandNames().includes(SELF_AUDIT_SCRIPT));
  const argv = scriptArgv(fresh(), SELF_AUDIT_SCRIPT);
  assert.equal(argv[0], process.execPath);
  assert.ok(argv.some(a => a.endsWith("cli.js")));
  assert.ok(argv.includes("self-audit") && argv.includes("run"));
});
