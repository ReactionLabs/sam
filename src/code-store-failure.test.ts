import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { clearCodeRoot, codeFileExists, codeRoot, codeStoreFailureSummary, isCodeStoreLedgered, readCodeStore, setCodeRoot } from "./code.js";
import { classifyDefect } from "./self-work.js";

// Code store failure visibility (gap found 2026-11-15,
// hourly run 12:04): the code store (.sam/code.db - the
// designated code root, the C1 fence's one row) touched its
// file raw at readCodeStore and writeConfig, so a dead store
// threw with the seam unnamed into every caller riding
// codeRoot, none of which folds that read. Each touch now
// ledgers ONE code-store-failed
// line (read door at phase read, write door at phase write)
// and rethrows exactly, tagged; every caller's handling is
// unchanged and reads still fail closed (never folded as no
// designation, which would silently un-fence the coder
// hands dressed as an unset root).
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-code-fail-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  return { base, sam, proj };
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "code-store-failed" });
}

function plantDeadStore(sam: string): void {
  mkdirSync(join(sam, ".sam", "code.db"), { recursive: true });
}

test("code-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(codeStoreFailureSummary("read", "unable to open\n  database   file"), "Code store read failed: unable to open database file");
  assert.equal(codeStoreFailureSummary("write", "disk gone"), "Code store write failed: disk gone");
  assert.equal(codeStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "code-store-failed", summary: codeStoreFailureSummary(phase, "boom") }),
      { key: "code-store-failed:" + phase, label: "code store failures (" + phase + " step)" },
    );
  }
});

test("code-store-failed: a healthy round trip ledgers nothing", () => {
  const { base, sam, proj } = fixture();
  try {
    assert.equal(setCodeRoot(sam, proj), proj);
    assert.deepEqual(readCodeStore(sam), { version: 1, root: proj });
    assert.equal(codeRoot(sam), proj);
    clearCodeRoot(sam);
    assert.deepEqual(readCodeStore(sam), { version: 1, root: null });
    assert.equal(codeRoot(sam), null);
    assert.equal(failedLines(sam).length, 0);
    assert.equal(existsSync(join(sam, ".sam", "activity.jsonl")), true, "the code-root designation lines exist; no failure line joined them");
    assert.equal(readActivity(sam, 100, { kind: "code-store-failed" }).length, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code-store-failed: an absent store reads as no designation, creates nothing, and ledgers nothing", () => {
  const { base, sam } = fixture();
  try {
    assert.equal(readCodeStore(sam), null);
    assert.equal(codeRoot(sam), null);
    assert.equal(existsSync(join(sam, ".sam")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code-store-failed: a dead store at read ledgers exactly one read line, tagged, rethrows, and carries no config content", () => {
  const { base, sam, proj } = fixture();
  try {
    plantDeadStore(sam);
    assert.throws(() => readCodeStore(sam), (e: unknown) => isCodeStoreLedgered(e));
    const lines = failedLines(sam);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Code store read failed: "), lines[0].summary);
    assert.ok(!lines[0].summary.includes(proj), "the designated path is fence data, not failure data");
    assert.deepEqual(classifyDefect(lines[0]), { key: "code-store-failed:read", label: "code store failures (read step)" });
    // codeRoot rides the same read door: one more touch, one
    // more line, still tagged.
    assert.throws(() => codeRoot(sam), (e: unknown) => isCodeStoreLedgered(e));
    assert.equal(failedLines(sam).length, 2, "one line per failed touch - the recurrence is the countable signal");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code-store-failed: a caller riding codeRoot gains no second line for a touch the store already ledgered", () => {
  const { base, sam } = fixture();
  try {
    plantDeadStore(sam);
    // codeFileExists rides codeRoot outside its own catch (its
    // catch covers only the confined-path check), so a dead
    // store propagates through it tagged - and the caller adds
    // no second line for the store's touch.
    assert.throws(() => codeFileExists(sam, "probe.txt"), (e: unknown) => isCodeStoreLedgered(e));
    const lines = failedLines(sam);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Code store read failed: "), lines[0].summary);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code-store-failed: a dead store at write ledgers exactly one write line, tagged, and rethrows", () => {
  const { base, sam, proj } = fixture();
  try {
    plantDeadStore(sam);
    assert.throws(() => setCodeRoot(sam, proj), (e: unknown) => isCodeStoreLedgered(e));
    const lines = failedLines(sam);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Code store write failed: "), lines[0].summary);
    assert.ok(!lines[0].summary.includes(proj), "the designated path is fence data, not failure data");
    assert.deepEqual(classifyDefect(lines[0]), { key: "code-store-failed:write", label: "code store failures (write step)" });
    assert.throws(() => clearCodeRoot(sam), (e: unknown) => isCodeStoreLedgered(e));
    assert.equal(failedLines(sam).length, 2, "one line per failed touch");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code-store-failed: validation refusals are not store failures and ledger nothing", () => {
  const { base, sam } = fixture();
  try {
    assert.throws(() => setCodeRoot(sam, join(base, "missing")), /does not exist/);
    assert.throws(() => setCodeRoot(sam, sam), /cannot be the SAM home itself/);
    assert.equal(failedLines(sam).length, 0);
    assert.equal(existsSync(join(sam, ".sam")), false, "a refused designation creates nothing");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
