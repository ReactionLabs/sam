import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyScorecardText } from "./goldfish.js";
import { recordChange, recordVerification } from "./verification.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The verify-on-stop daily-measurement wiring (2026-11-18,
// mirroring the doctor read/fix split at 00:04): verify
// status had no plain-text scorecard, no script allowlist
// entry, and no daily job, so the harness's own
// done-discipline - a ledger sitting unverified, goldfish
// coverage slipping - would surface only when a session
// tried to close against the gate. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it
// carries no clock reading and no free text: states and
// counts only - never a pending path, a hash, a gate
// reason, a finding, or a spec. The scorecard path records
// nothing, runs no build or test, spends no model call,
// and never reviews; every state here is built through the
// ledger's own public doors (recordChange /
// recordVerification), never around them.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-verify-scorecard-"));
}

test("verify scorecard: a bare install is clean, stable, clock-free, and P3-silent", () => {
  const dir = scratch();
  try {
    const text = verifyScorecardText(dir);
    assert.match(text, /^Verification: clean$/m);
    assert.match(text, /^Pending changes: 0$/m);
    assert.match(text, /^Goldfish: none$/m);
    assert.match(text, /^Goldfish changes: 0 total, 0 uncovered$/m);
    assert.match(text, /^Session: closable, outcome done$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    const again = verifyScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held verify scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verify scorecard: an unverified change names no path or hash, and a flip moves the text", () => {
  const dir = scratch();
  try {
    const clean = verifyScorecardText(dir);
    recordChange(dir, { path: "src/secret-shaped-name.ts", replacementHash: "deadbeefhash", source: "code-write" });
    const text = verifyScorecardText(dir);
    assert.match(text, /^Verification: unverified$/m);
    assert.match(text, /^Pending changes: 1$/m);
    assert.match(text, /^Build after change: not passed$/m);
    assert.match(text, /^Test after change: not passed$/m);
    assert.match(text, /^Goldfish: stale$/m);
    assert.match(text, /^Goldfish changes: 1 total, 1 uncovered$/m);
    assert.match(text, /^Session: not closable, outcome open$/m);
    assert.equal(text.includes("secret-shaped-name"), false, "pending paths never surface");
    assert.equal(text.includes("deadbeefhash"), false, "hashes never surface");
    assert.equal(text.includes("code-write"), false, "change sources never surface");
    assert.notEqual(text, clean, "a change landing unverified changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verify scorecard: a fresh build and test pass verifies the epoch and clears pending", () => {
  const dir = scratch();
  try {
    recordChange(dir, { path: "src/a.ts", replacementHash: "h1", source: "test" });
    recordVerification(dir, { kind: "build", passed: true, runId: "r1" });
    const half = verifyScorecardText(dir);
    assert.match(half, /^Verification: unverified$/m, "build alone does not verify");
    assert.match(half, /^Build after change: passed$/m);
    assert.match(half, /^Test after change: not passed$/m);
    recordVerification(dir, { kind: "test", passed: true, runId: "r2" });
    const text = verifyScorecardText(dir);
    assert.match(text, /^Verification: verified$/m);
    assert.match(text, /^Pending changes: 0$/m);
    assert.match(text, /^Goldfish changes: 1 total, 1 uncovered$/m, "verification is not review: coverage still owes a goldfish pass");
    assert.match(text, /^Session: not closable, outcome open$/m, "verified but unreviewed still cannot close as done");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verify scorecard: a failed verification closes as failed, never as done", () => {
  const dir = scratch();
  try {
    recordChange(dir, { path: "src/a.ts", replacementHash: "h1", source: "test" });
    recordVerification(dir, { kind: "test", passed: false, runId: "r1" });
    const text = verifyScorecardText(dir);
    assert.match(text, /^Verification: failed$/m);
    assert.match(text, /^Session: closable, outcome failed$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verify scorecard: the allowlist argv rides verify scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-verify"));
  const argv = scriptArgv("/tmp/sam-root", "sam-verify");
  assert.ok(argv);
  assert.deepEqual(argv.slice(-2), ["verify", "scorecard"]);
  assert.ok(argv.includes("/tmp/sam-root"));
});
