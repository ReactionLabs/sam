import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { recordChange, recordVerification, verificationFailureSummary, verificationStatus } from "./verification.js";
import { classifyDefect, rankDefects } from "./self-work.js";

// Verification ledger failure visibility (gap found 2026-11-13,
// hourly run 15:04): both touches of .sam/verifications.jsonl
// were unguarded, so a dead append threw the already-landed
// work's record away (an applied edit, a code write, a known
// build/test verdict) or lost it silently (the C2 caller's
// catch), and a dead read threw out of every status and close
// check - with no trace in the activity ledger either way, so
// the gate's frozen picture was indistinguishable from truth.
// The append now follows the house contract (never throws,
// returns whether the record landed, one verification-failed
// line per failed touch) and the read fails closed (one line,
// then the rethrow) because a status folded from an unreadable
// ledger would read clean.
function scratch() {
  return mkdtempSync(join(tmpdir(), "sam-verification-fail-"));
}

// Plant a directory where the ledger file belongs: the read
// and the append both throw EISDIR, the dead-ledger shape.
function plantDir(root: string) {
  mkdirSync(join(root, ".sam"), { recursive: true });
  mkdirSync(join(root, ".sam", "verifications.jsonl"));
}

test("verification-failed: a dead ledger never eats a landed change - one append line, no throw", () => {
  const root = scratch();
  try {
    plantDir(root);
    let landed: boolean | undefined;
    assert.doesNotThrow(() => { landed = recordChange(root, { path: "src/a.ts", replacementHash: "deadbeefhash987654", source: "code-write" }); },
      "recording never breaks the work it records");
    assert.equal(landed, false, "the caller learns the record did not land");
    const lines = readActivity(root, 100, { kind: "verification-failed" });
    assert.equal(lines.length, 1, "exactly one line per failed append");
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Verification append failed for change src/a.ts (source code-write): "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("deadbeefhash987654"), "the content hash never enters the line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification-failed: a dead ledger never eats a known verdict", () => {
  const root = scratch();
  try {
    plantDir(root);
    let landed: boolean | undefined;
    assert.doesNotThrow(() => { landed = recordVerification(root, { kind: "build", passed: true, runId: "run-1234567890" }); });
    assert.equal(landed, false);
    const lines = readActivity(root, 100, { kind: "verification-failed" });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Verification append failed for verification build passed (run run-1234): "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification-failed: a failed append alone ledgers once (the read succeeds empty)", () => {
  const root = scratch();
  try {
    // A symlink to a missing target: existsSync reads false, so
    // the read succeeds empty; the append follows the link and
    // dies ENOENT - the append-only failure shape.
    mkdirSync(join(root, ".sam"), { recursive: true });
    symlinkSync(join(root, "missing", "verifications.jsonl"), join(root, ".sam", "verifications.jsonl"));
    assert.equal(verificationStatus(root).state, "clean", "the read succeeds on the absent-through-link ledger");
    assert.equal(recordVerification(root, { kind: "test", passed: false, runId: "r9" }), false);
    const lines = readActivity(root, 100, { kind: "verification-failed" });
    assert.equal(lines.length, 1, "the read succeeded, so only the append ledgers");
    assert.ok(lines[0].summary.startsWith("Verification append failed for verification test failed (run r9): "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification-failed: a dead read fails closed - one read line, then the rethrow", () => {
  const root = scratch();
  try {
    plantDir(root);
    assert.throws(() => verificationStatus(root), /EISDIR|illegal operation/i,
      "a status folded from an unreadable ledger would read clean, so the read still throws");
    const lines = readActivity(root, 100, { kind: "verification-failed" });
    assert.equal(lines.length, 1, "exactly one line per failed read");
    assert.ok(lines[0].summary.startsWith("Verification read failed for ledger: "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification-failed: a persistent append failure recurs per record - that recurrence is the countable signal", () => {
  const root = scratch();
  try {
    plantDir(root);
    recordChange(root, { path: "src/a.ts", replacementHash: "h1", source: "test" });
    recordChange(root, { path: "src/b.ts", replacementHash: "h2", source: "test" });
    recordVerification(root, { kind: "test", passed: true, runId: "r1" });
    const lines = readActivity(root, 100, { kind: "verification-failed" });
    assert.equal(lines.length, 3, "one line per failed append, three appends");
    assert.equal(lines.filter(l => l.summary.startsWith("Verification append failed")).length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification-failed: healthy records land, return true, and ledger nothing", () => {
  const root = scratch();
  try {
    assert.equal(recordChange(root, { path: "src/a.ts", replacementHash: "h1", source: "test" }), true);
    assert.equal(recordVerification(root, { kind: "build", passed: true, runId: "r1" }), true);
    assert.equal(recordVerification(root, { kind: "test", passed: true, runId: "r2" }), true);
    assert.equal(verificationStatus(root).state, "verified");
    assert.equal(readActivity(root, 100, { kind: "verification-failed" }).length, 0, "no failure line on the healthy path");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification failure summaries collapse and cap the verbatim reason", () => {
  const read = verificationFailureSummary("read", "ledger", "EISDIR: illegal operation\n  on a directory");
  assert.ok(!read.includes("\n"), "the reason is one line");
  const append = verificationFailureSummary("append", "change src/a.ts (source test)", "x".repeat(500));
  assert.ok(append.length <= 200, "the summary is capped at 200");
  assert.ok(append.startsWith("Verification append failed for change src/a.ts"), "an append failure names the event it could not record");
});

test("verification-failed kinds classify keyed by phase and rank", () => {
  const line = (summary: string) => ({ at: "2026-11-13T20:00:00.000Z", actor: "sam", kind: "verification-failed", summary });
  assert.deepEqual(classifyDefect(line("Verification append failed for change src/a.ts (source test): EISDIR")),
    { key: "verification-failed:append", label: "verification ledger failures (append step)" });
  assert.deepEqual(classifyDefect(line("Verification read failed for ledger: EISDIR")),
    { key: "verification-failed:read", label: "verification ledger failures (read step)" });
  const root = scratch();
  try {
    recordActivity(root, "sam", "verification-failed", "Verification append failed for change src/a.ts (source test): EISDIR");
    recordActivity(root, "sam", "verification-failed", "Verification read failed for ledger: EISDIR");
    const ranked = rankDefects(root);
    assert.equal(ranked.find(r => r.key === "verification-failed:append")?.count, 1);
    assert.equal(ranked.find(r => r.key === "verification-failed:read")?.count, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
