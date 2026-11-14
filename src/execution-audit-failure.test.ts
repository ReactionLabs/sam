import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionAuditFailureSummary, recentExecutionAuditLogs, requestTestRun, executeApprovedTestRun } from "./approved-test-runner.js";
import { readActivity } from "./activity.js";
import { verificationStatus } from "./verification.js";
import { buildSelfWorkSpec, classifyDefect, rankDefects } from "./self-work.js";

// Execution-audit ledger failure visibility (gap found
// 2026-11-13, hourly run 23:04): audit() was a bare
// appendFileSync whose "started" call runs after the one-use
// authorization is consumed and whose "finished" call runs
// before recordVerification, so a dead append spent the
// owner's tap without executing, or discarded a finished
// run's result and left the gate unsettled; and the status
// read was bare, so a dead read killed the whole status
// payload. The append now never throws (one
// execution-audit-failed line, returns whether it landed);
// the read fails closed (one line, then the rethrow).
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-exec-audit-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  mkdirSync(join(sam, "dist"));
  writeFileSync(join(sam, "package.json"), '{"type":"module"}');
  writeFileSync(join(sam, "dist", "demo.test.js"), 'import test from "node:test"; test("works",()=>{});\n');
  return { base, sam };
}
function failures(sam: string) {
  return readActivity(sam, 100, { kind: "execution-audit-failed" });
}
// Append-dead, read-healthy: a dangling symlink - appends
// follow it to a missing target (ENOENT), existsSync reads
// it as absent.
function plantDangling(sam: string) {
  mkdirSync(join(sam, ".sam"), { recursive: true });
  symlinkSync(join(sam, "no-such-dir", "execution-audit.jsonl"), join(sam, ".sam", "execution-audit.jsonl"));
}
// Fully dead: a directory where the ledger file belongs.
function plantDir(sam: string) {
  mkdirSync(join(sam, ".sam"), { recursive: true });
  mkdirSync(join(sam, ".sam", "execution-audit.jsonl"));
}

test("execution-audit-failed summary: names phase and event, collapses and caps the reason, carries no digest", () => {
  const s = executionAuditFailureSummary("append", "started test (run 12345678)", "ENOENT: no such file\nor directory");
  assert.ok(s.startsWith("Execution audit append failed for started test (run 12345678): ENOENT"), s);
  assert.ok(!s.includes("\n"), "the reason is collapsed to one line");
  assert.ok(executionAuditFailureSummary("read", "ledger", "x".repeat(500)).length <= 200);
  assert.equal(executionAuditFailureSummary("read", "ledger", ""), "Execution audit read failed for ledger: unknown error");
});

test("a dead audit append never breaks the run: the request lands, the approved run executes, its result returns, and verification still settles", async () => {
  const { base, sam } = fixture();
  try {
    plantDangling(sam);
    const request = requestTestRun(sam, "test");
    assert.equal(failures(sam).length, 1, "the requested append ledgers exactly one line");
    assert.match(failures(sam)[0].summary, /^Execution audit append failed for requested test \(run /);
    const result = await executeApprovedTestRun(sam, request.id, request.digest, 10_000);
    assert.equal(result.passed, true, "the run still executes and its result still returns");
    assert.equal(failures(sam).length, 3, "started and finished appends each ledger exactly one line");
    assert.match(failures(sam)[1].summary, /^Execution audit append failed for started test \(run /);
    assert.match(failures(sam)[2].summary, /^Execution audit append failed for finished test \(run /);
    const digestLeaked = failures(sam).some(l => l.summary.includes(request.digest));
    assert.equal(digestLeaked, false, "no failure line carries the approval digest");
    assert.ok(verificationStatus(sam).lastVerificationAt, "recordVerification still settles the gate after the dead finished append");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a dead audit read rethrows instead of presenting an empty history, with exactly one read line", () => {
  const { base, sam } = fixture();
  try {
    plantDir(sam);
    assert.throws(() => recentExecutionAuditLogs(sam), /EISDIR|illegal operation|directory/i);
    assert.equal(failures(sam).length, 1);
    assert.match(failures(sam)[0].summary, /^Execution audit read failed for ledger: /);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("an absent audit ledger still reads [] and a healthy run records all three events with zero failure lines", async () => {
  const { base, sam } = fixture();
  try {
    assert.deepEqual(recentExecutionAuditLogs(sam), [], "a fresh install has no approved runs yet");
    const request = requestTestRun(sam, "test");
    const result = await executeApprovedTestRun(sam, request.id, request.digest, 10_000);
    assert.equal(result.passed, true);
    const logs = recentExecutionAuditLogs(sam);
    assert.equal(logs.length, 3);
    assert.match(logs[0], /"event":"requested"/);
    assert.match(logs[1], /"event":"started"/);
    assert.match(logs[2], /"event":"finished"/);
    assert.equal(failures(sam).length, 0, "healthy touches ledger no failure lines");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("self-work classifies and specs the execution-audit-failed class keyed by phase", () => {
  const { base, sam } = fixture();
  try {
    const line = { at: "2026-11-13T23:00:00.000Z", actor: "sam", kind: "execution-audit-failed", summary: executionAuditFailureSummary("append", "started test (run 12345678)", "ENOENT: no such file or directory") };
    const cls = classifyDefect(line);
    assert.equal(cls?.key, "execution-audit-failed:append");
    assert.equal(cls?.label, "execution-audit ledger failures (append step)");
    const readCls = classifyDefect({ ...line, summary: executionAuditFailureSummary("read", "ledger", "EISDIR: illegal operation on a directory") });
    assert.equal(readCls?.key, "execution-audit-failed:read");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("self-work ranks and specs execution-audit-failed from ledgered lines", async () => {
  const { base, sam } = fixture();
  try {
    plantDangling(sam);
    const request = requestTestRun(sam, "test");
    await executeApprovedTestRun(sam, request.id, request.digest, 10_000);
    const ranked = rankDefects(sam);
    assert.equal(ranked[0]?.key, "execution-audit-failed:append");
    assert.equal(ranked[0]?.count, 3);
    const run = buildSelfWorkSpec(sam, null);
    assert.equal(run.spec?.defectKey, "execution-audit-failed:append");
    assert.ok(run.spec?.files.includes("approved-test-runner.ts"));
    assert.ok(run.spec?.endGoal.includes("execution-audit ledger stops failing"), run.spec?.endGoal);
    assert.ok(run.spec?.doneLooksLike.some(d => d.includes("fails closed")), run.spec?.doneLooksLike.join(" | "));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
