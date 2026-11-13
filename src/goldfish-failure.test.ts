import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { goldfishFailureSummary, goldfishStatus, runGoldfishReview } from "./goldfish.js";
import { applyEdit, proposeEdit } from "./file-edits.js";
import { listChanges } from "./verification.js";
import { classifyDefect, rankDefects } from "./self-work.js";
import type { EditModel } from "./model-edit.js";

// Goldfish records ledger failure visibility (gap found
// 2026-11-13, hourly run 16:04): both touches of
// .sam/goldfish.jsonl were unguarded, so a dead append threw
// a spent review's computed verdict away (the coding / engine
// drains dressed it as a generic "review could not run") and
// a dead read threw out of goldfish status, the session gate,
// and the review run itself - with no trace in the activity
// ledger either way. A goldfish verdict is a permission, not
// a fact of work already landed, so BOTH seams fail closed:
// one goldfish-failed line per failed touch, then the
// rethrow exactly - an unrecorded PASS is never spent.
const CATALOG = "# Pattern Catalog\n\n## LOCAL-1: First local pattern (2026-11-09)\nSomething broke.\nCheck: check one.\n";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "sam-goldfish-fail-"));
  writeFileSync(join(root, "pattern-catalog.md"), CATALOG);
  writeFileSync(join(root, "code.ts"), "export const value = 1;\n");
  return root;
}

function applyChange(root: string): void {
  const proposal = proposeEdit(root, "code.ts", "export const value = 2;\n");
  applyEdit(root, proposal.id, proposal.digest);
}

const PASS_JSON = JSON.stringify({ verdict: "PASS", summary: "No concerns.", findings: [] });

function fakeProvider(calls: { n: number }): EditModel {
  return {
    complete: async () => { calls.n += 1; return { message: { content: PASS_JSON } }; },
  } as unknown as EditModel;
}

// Plant a directory where the records file belongs: the read
// throws EISDIR, the dead-ledger shape.
function plantDir(root: string) {
  mkdirSync(join(root, ".sam"), { recursive: true });
  mkdirSync(join(root, ".sam", "goldfish.jsonl"));
}

test("goldfish-failed: a dead read fails closed - one read line, then the rethrow", () => {
  const root = scratch();
  try {
    plantDir(root);
    assert.throws(() => goldfishStatus(root), /EISDIR|illegal operation/i,
      "a status folded from an unreadable records ledger would misstate coverage, so the read still throws");
    const lines = readActivity(root, 100, { kind: "goldfish-failed" });
    assert.equal(lines.length, 1, "exactly one line per failed read");
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Goldfish read failed for ledger: "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("goldfish-failed: a dead read stops a review before any model call is spent", async () => {
  const root = scratch();
  try {
    applyChange(root);
    plantDir(root);
    const calls = { n: 0 };
    await assert.rejects(runGoldfishReview(root, "spec", "test-model", fakeProvider(calls)), /EISDIR|illegal operation/i);
    assert.equal(calls.n, 0, "coverage is read first, so no model call is spent on a dead ledger");
    const lines = readActivity(root, 100, { kind: "goldfish-failed" });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Goldfish read failed for ledger: "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("goldfish-failed: a failed append alone ledgers once and the spent verdict is not returned as recorded", async () => {
  const root = scratch();
  try {
    applyChange(root);
    // A symlink to a missing target: existsSync reads false, so
    // the coverage read succeeds empty; the append follows the
    // link and dies ENOENT - the append-only failure shape.
    mkdirSync(join(root, ".sam"), { recursive: true });
    symlinkSync(join(root, "missing", "goldfish.jsonl"), join(root, ".sam", "goldfish.jsonl"));
    const calls = { n: 0 };
    await assert.rejects(runGoldfishReview(root, "spec-secret-words", "test-model", fakeProvider(calls)), /ENOENT/i,
      "an unrecorded PASS is never spent: the append rethrows after ledgering");
    assert.equal(calls.n, 1, "the review did run - exactly one model call was spent");
    const lines = readActivity(root, 100, { kind: "goldfish-failed" });
    assert.equal(lines.length, 1, "the read succeeded, so only the append ledgers");
    assert.ok(lines[0].summary.startsWith("Goldfish append failed for review PASS over 1 change(s): "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("spec-secret-words"), "the task spec never enters the line");
    assert.ok(!lines[0].summary.includes("No concerns"), "the review summary never enters the line");
    const hash = listChanges(root)[0]?.replacementHash ?? "";
    assert.ok(hash.length > 0 && !lines[0].summary.includes(hash), "no change hash enters the line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("goldfish-failed: a persistent read failure recurs per touch - that recurrence is the countable signal", () => {
  const root = scratch();
  try {
    plantDir(root);
    assert.throws(() => goldfishStatus(root));
    assert.throws(() => goldfishStatus(root));
    const lines = readActivity(root, 100, { kind: "goldfish-failed" });
    assert.equal(lines.length, 2, "one line per failed read, two reads");
    assert.equal(lines.filter(l => l.summary.startsWith("Goldfish read failed")).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("goldfish-failed: a healthy review records, reads back as pass, and ledgers nothing", async () => {
  const root = scratch();
  try {
    applyChange(root);
    const calls = { n: 0 };
    const record = await runGoldfishReview(root, "spec", "test-model", fakeProvider(calls));
    assert.equal(record.verdict, "PASS");
    assert.equal(goldfishStatus(root).state, "pass");
    assert.equal(readActivity(root, 100, { kind: "goldfish-failed" }).length, 0, "no failure line on the healthy path");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("goldfish failure summaries collapse and cap the verbatim reason", () => {
  const read = goldfishFailureSummary("read", "ledger", "EISDIR: illegal operation\n  on a directory");
  assert.ok(!read.includes("\n"), "the reason is one line");
  const append = goldfishFailureSummary("append", "review PASS over 1 change(s)", "x".repeat(500));
  assert.ok(append.length <= 200, "the summary is capped at 200");
  assert.ok(append.startsWith("Goldfish append failed for review PASS over 1 change(s)"), "an append failure names the review it could not record");
});

test("goldfish-failed kinds classify keyed by phase and rank", () => {
  const line = (summary: string) => ({ at: "2026-11-13T21:00:00.000Z", actor: "sam", kind: "goldfish-failed", summary });
  assert.deepEqual(classifyDefect(line("Goldfish append failed for review PASS over 1 change(s): ENOENT")),
    { key: "goldfish-failed:append", label: "goldfish ledger failures (append step)" });
  assert.deepEqual(classifyDefect(line("Goldfish read failed for ledger: EISDIR")),
    { key: "goldfish-failed:read", label: "goldfish ledger failures (read step)" });
  const root = scratch();
  try {
    recordActivity(root, "sam", "goldfish-failed", "Goldfish append failed for review PASS over 1 change(s): ENOENT");
    recordActivity(root, "sam", "goldfish-failed", "Goldfish read failed for ledger: EISDIR");
    const ranked = rankDefects(root);
    assert.equal(ranked.find(r => r.key === "goldfish-failed:append")?.count, 1);
    assert.equal(ranked.find(r => r.key === "goldfish-failed:read")?.count, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
