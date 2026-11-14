import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { assessDelivery, readDeliveryLedger, worthinessFailureSummary, worthinessReadFailureSummary } from "./worthiness.js";
import { PreferenceStore } from "./preferences.js";
import { classifyDefect, rankDefects } from "./self-work.js";

// Worthiness ledger failure visibility (gap found 2026-11-13,
// hourly run 14:04): assessDelivery appended its assessment
// unguarded, so a dead delivery-ledger threw the verdict away
// (the heartbeat jobs stage ate it as a generic tick failure
// with the delivery left pending and undecided; the loop
// revisit aborted before its state advanced), a dead read
// killed the assessment before any verdict existed, and the
// gate's duplicate/rate memory - which reads nothing but this
// ledger - froze with no trace anywhere. The gate now owns
// both touches: one worthiness-failed line per failed touch,
// and the verdict returns regardless.
function scratch() {
  return mkdtempSync(join(tmpdir(), "sam-worthiness-fail-"));
}

// Plant a directory where the ledger file belongs: the read
// and the append both throw EISDIR, the dead-ledger shape.
function plantDir(root: string) {
  mkdirSync(join(root, ".sam"), { recursive: true });
  mkdirSync(join(root, ".sam", "delivery-ledger.jsonl"));
}

test("worthiness-failed: a dead ledger never eats the verdict - one line per failed touch", () => {
  const root = scratch();
  try {
    plantDir(root);
    let verdict;
    assert.doesNotThrow(() => { verdict = assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "Secret news 987654 broke." }); },
      "the gate never breaks the delivery it judges");
    assert.deepEqual(verdict, { deliver: true, reason: "worthy" }, "with no readable history and no law, the verdict is computed and returned");
    const lines = readActivity(root, 100, { kind: "worthiness-failed" });
    assert.equal(lines.length, 2, "exactly one line per failed touch (read, then append)");
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Worthiness read failed for profile sam (heartbeat): "), lines[0].summary);
    assert.ok(lines[1].summary.startsWith("Worthiness append failed for profile sam (heartbeat, verdict deliver): "), lines[1].summary);
    assert.ok(!lines[0].summary.includes("987654") && !lines[1].summary.includes("987654"), "the message text never enters the line");
    assert.ok(!lines[0].summary.includes("Secret news") && !lines[1].summary.includes("Secret news"), "the message text never enters the line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worthiness-failed: a failed append alone ledgers once and the held verdict still returns", () => {
  const root = scratch();
  try {
    // A symlink to a missing target: existsSync reads false, so
    // the read succeeds empty; the append follows the link and
    // dies ENOENT - the append-only failure shape.
    mkdirSync(join(root, ".sam"), { recursive: true });
    symlinkSync(join(root, "missing", "delivery-ledger.jsonl"), join(root, ".sam", "delivery-ledger.jsonl"));
    const prefs = new PreferenceStore(root);
    prefs.note("sam", "Never alert me about crypto prices", "rule", "test");
    prefs.close();
    const verdict = assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "Crypto prices moved again." });
    assert.deepEqual(verdict, { deliver: false, reason: "law: never alert about crypto" }, "the law verdict is computed and returned");
    const lines = readActivity(root, 100, { kind: "worthiness-failed" });
    assert.equal(lines.length, 1, "the read succeeded, so only the append ledgers");
    assert.ok(lines[0].summary.startsWith("Worthiness append failed for profile sam (heartbeat, verdict held): "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worthiness-failed: a persistent failure recurs per assessment - that recurrence is the countable signal", () => {
  const root = scratch();
  try {
    plantDir(root);
    assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "First update." });
    assessDelivery(root, { profile: "dip", kind: "second-answer", text: "Second update." });
    const lines = readActivity(root, 100, { kind: "worthiness-failed" });
    assert.equal(lines.length, 4, "two failed touches per assessment, two assessments");
    assert.equal(lines.filter(l => l.summary.startsWith("Worthiness read failed")).length, 2);
    assert.equal(lines.filter(l => l.summary.startsWith("Worthiness append failed")).length, 2);
    assert.equal(lines[2].actor, "dip", "the failing assessment's profile is the line's actor");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worthiness-failed: a healthy assessment records and ledgers nothing", () => {
  const root = scratch();
  try {
    assert.equal(assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "The stack restarted." }).deliver, true);
    assert.equal(readActivity(root, 100, { kind: "worthiness-failed" }).length, 0, "no failure line on the healthy path");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worthiness failure summaries collapse and cap the verbatim reason", () => {
  const read = worthinessFailureSummary("read", "sam", "heartbeat", null, "EISDIR: illegal operation\n  on a directory");
  assert.ok(!read.includes("\n"), "the reason is one line");
  const append = worthinessFailureSummary("append", "sam", "heartbeat", { deliver: false, reason: "duplicate" }, "x".repeat(500));
  assert.ok(append.length <= 200, "the summary is capped at 200");
  assert.ok(append.includes("verdict held"), "an append failure names the verdict it could not record");
});

test("worthiness-failed: a dead direct read ledgers one generic line and rethrows, never folds to zero counts", () => {
  const root = scratch();
  try {
    plantDir(root);
    assert.throws(() => readDeliveryLedger(root, 500), /EISDIR/, "the direct read rethrows exactly instead of folding to []");
    const lines = readActivity(root, 100, { kind: "worthiness-failed" });
    assert.equal(lines.length, 1, "exactly one read line for the dead direct read");
    assert.equal(lines[0].actor, "sam", "the reader is the system - no assessment is in hand");
    assert.ok(lines[0].summary.startsWith("Worthiness read failed: "), lines[0].summary);
    assert.throws(() => readDeliveryLedger(root, 100), /EISDIR/, "the CLI list surface rides the same reader");
    assert.equal(readActivity(root, 100, { kind: "worthiness-failed" }).length, 2,
      "each direct surface ledgers its own one line - no surface dies raw");
    assert.deepEqual(classifyDefect(lines[0]), { key: "worthiness-failed:read", label: "worthiness ledger failures (read step)" },
      "the generic shape classifies into the same read class as the assessed shape");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worthiness-failed: an absent ledger still reads empty on the direct surfaces and ledgers nothing", () => {
  const root = scratch();
  try {
    assert.deepEqual(readDeliveryLedger(root), []);
    assert.deepEqual(readDeliveryLedger(root, 500), []);
    assert.equal(readActivity(root, 100, { kind: "worthiness-failed" }).length, 0, "a fresh install genuinely assessed nothing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worthiness read failure summaries collapse and cap the verbatim reason", () => {
  const s = worthinessReadFailureSummary("EISDIR: illegal operation\n  on a directory");
  assert.ok(!s.includes("\n"), "the reason is one line");
  assert.equal(s, "Worthiness read failed: EISDIR: illegal operation on a directory");
  const capped = worthinessReadFailureSummary("x".repeat(500));
  assert.ok(capped.length <= 200, "the summary is capped at 200");
});

test("worthiness-failed kinds classify keyed by phase and rank", () => {
  const line = (summary: string) => ({ at: "2026-11-13T19:00:00.000Z", actor: "sam", kind: "worthiness-failed", summary });
  assert.deepEqual(classifyDefect(line("Worthiness read failed for profile sam (heartbeat): EISDIR")),
    { key: "worthiness-failed:read", label: "worthiness ledger failures (read step)" });
  assert.deepEqual(classifyDefect(line("Worthiness append failed for profile sam (heartbeat, verdict deliver): ENOENT")),
    { key: "worthiness-failed:append", label: "worthiness ledger failures (append step)" });
  const root = scratch();
  try {
    recordActivity(root, "sam", "worthiness-failed", "Worthiness read failed for profile sam (heartbeat): EISDIR");
    recordActivity(root, "sam", "worthiness-failed", "Worthiness append failed for profile sam (heartbeat, verdict deliver): EISDIR");
    const ranked = rankDefects(root);
    assert.equal(ranked.find(r => r.key === "worthiness-failed:read")?.count, 1);
    assert.equal(ranked.find(r => r.key === "worthiness-failed:append")?.count, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
