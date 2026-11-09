import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordChange, recordVerification, verificationGate, verificationStatus } from "./verification.js";
import { applyEdit, proposeEdit } from "./file-edits.js";
import { executeApprovedTestRun, requestTestRun } from "./approved-test-runner.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-verify-"));
}

test("verify-on-stop: an untouched workspace is clean and closable", () => {
  const root = scratch();
  try {
    assert.equal(verificationStatus(root).state, "clean");
    assert.equal(verificationGate(root).closable, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verify-on-stop: a change without fresh verification cannot close", () => {
  const root = scratch();
  try {
    recordChange(root, { path: "src/a.ts", replacementHash: "h1", source: "test" });
    const status = verificationStatus(root);
    assert.equal(status.state, "unverified");
    assert.deepEqual(status.pendingChanges.map(c => c.path), ["src/a.ts"]);
    const gate = verificationGate(root);
    assert.equal(gate.closable, false);
    assert.match(gate.reason, /src\/a\.ts/);
    // A build pass alone is half a verification: still not closable.
    recordVerification(root, { kind: "build", passed: true, runId: "r1" });
    assert.equal(verificationStatus(root).state, "unverified");
    assert.equal(verificationStatus(root).buildPassedAfterChange, true);
    assert.equal(verificationGate(root).closable, false);
    // The test pass completes it.
    recordVerification(root, { kind: "test", passed: true, runId: "r2" });
    assert.equal(verificationStatus(root).state, "verified");
    assert.deepEqual(verificationStatus(root).pendingChanges, []);
    assert.equal(verificationGate(root).closable, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verify-on-stop: a recorded failure closes as failed, and a later full pass supersedes it", () => {
  const root = scratch();
  try {
    recordChange(root, { path: "src/b.ts", replacementHash: "h2", source: "test" });
    recordVerification(root, { kind: "test", passed: false, runId: "r3" });
    const failed = verificationStatus(root);
    assert.equal(failed.state, "failed");
    const gate = verificationGate(root);
    assert.equal(gate.closable, true);
    assert.match(gate.reason, /never as done/);
    recordVerification(root, { kind: "build", passed: true, runId: "r4" });
    recordVerification(root, { kind: "test", passed: true, runId: "r5" });
    assert.equal(verificationStatus(root).state, "verified");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verify-on-stop: a change after verification reopens the gate, listing only the new change", () => {
  const root = scratch();
  try {
    recordChange(root, { path: "src/old.ts", replacementHash: "h1", source: "test" });
    recordVerification(root, { kind: "build", passed: true, runId: "r1" });
    recordVerification(root, { kind: "test", passed: true, runId: "r2" });
    assert.equal(verificationStatus(root).state, "verified");
    recordChange(root, { path: "src/new.ts", replacementHash: "h3", source: "test" });
    const status = verificationStatus(root);
    assert.equal(status.state, "unverified");
    assert.deepEqual(status.pendingChanges.map(c => c.path), ["src/new.ts"]);
    assert.equal(status.buildPassedAfterChange, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verify-on-stop: the real doors - an applied edit records pending, approved runs settle it", async () => {
  const root = scratch();
  try {
    writeFileSync(join(root, "note.txt"), "before");
    const proposal = proposeEdit(root, "note.txt", "after");
    const applied = applyEdit(root, proposal.id, proposal.digest);
    assert.equal(applied.verification, "pending");
    const pending = verificationStatus(root);
    assert.equal(pending.state, "unverified");
    assert.equal(pending.pendingChanges[0].source, "edit-apply");
    // A scratch verification rig: a stub compiler that exits 0 and one
    // real passing test file, driven through the approved runner.
    mkdirSync(join(root, "node_modules", "typescript", "bin"), { recursive: true });
    writeFileSync(join(root, "node_modules", "typescript", "bin", "tsc"), "process.exit(0);");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "pass.test.js"), "const test=require('node:test');const assert=require('node:assert');test('ok',()=>assert.ok(true));");
    const testRun = requestTestRun(root, "test");
    const testResult = await executeApprovedTestRun(root, testRun.id, testRun.digest, 10_000);
    assert.equal(testResult.passed, true);
    assert.equal(verificationStatus(root).state, "unverified");
    const buildRun = requestTestRun(root, "build");
    const buildResult = await executeApprovedTestRun(root, buildRun.id, buildRun.digest, 10_000);
    assert.equal(buildResult.passed, true);
    assert.equal(verificationStatus(root).state, "verified");
    assert.equal(verificationGate(root).closable, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
