import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityFailureSummary, recordActivity, readActivity } from "./activity.js";
import { buildSelfWorkSpec, classifyDefect, rankDefects } from "./self-work.js";

// Activity ledger read failure visibility (gap found
// 2026-11-13, hourly run 22:04): readActivity caught ANY
// filesystem error and returned [], so a dead ledger read as
// "SAM did nothing and nothing ever failed" to every surface
// that folds it as truth - self-work's defect queue,
// observability, status, the CLI. The read now fails closed
// (one activity-failed line attempted through recordActivity
// itself, then the rethrow exactly); the append keeps its
// swallow-by-design contract, an absent ledger still reads
// [], and torn-line parsing stays forgiving.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-act-fail-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  return { base, sam };
}

// Plant a directory where the ledger file belongs: the read
// and the append both throw EISDIR, the dead-ledger shape.
function plantDir(sam: string) {
  mkdirSync(join(sam, ".sam"), { recursive: true });
  mkdirSync(join(sam, ".sam", "activity.jsonl"));
}

test("activity-failed summary: names the read, collapses and caps the reason, carries no ledger content", () => {
  const s = activityFailureSummary("EISDIR: illegal operation\non a directory");
  assert.ok(s.startsWith("Activity read failed: EISDIR"), s);
  assert.ok(!s.includes("\n"), "the reason is collapsed to one line");
  assert.ok(activityFailureSummary("x".repeat(500)).length <= 300);
  assert.equal(activityFailureSummary(""), "Activity read failed: unknown error");
});

test("a dead activity read rethrows instead of folding to a silent empty history", () => {
  const { base, sam } = fixture();
  try {
    plantDir(sam);
    assert.throws(() => readActivity(sam, 30), /EISDIR|illegal operation|directory/i);
    // The defect queue folds the same read: it must surface
    // the dead ledger too, never report zero defects over it.
    assert.throws(() => rankDefects(sam), /EISDIR|illegal operation|directory/i);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("an absent activity ledger still reads [] and a healthy ledger reads back with filters intact", () => {
  const { base, sam } = fixture();
  try {
    assert.deepEqual(readActivity(sam, 30), [], "a fresh install genuinely did nothing");
    recordActivity(sam, "trading", "turn", "t1");
    recordActivity(sam, "owner", "approved", "o1");
    assert.equal(readActivity(sam, 30).length, 2);
    assert.deepEqual(readActivity(sam, 30, { kind: "turn" }).map(l => l.summary), ["t1"]);
    assert.equal(readActivity(sam, 30, { kind: "activity-failed" }).length, 0, "healthy reads ledger no failure lines");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("recordActivity still never throws on a dead ledger: the append contract is unchanged", () => {
  const { base, sam } = fixture();
  try {
    plantDir(sam);
    recordActivity(sam, "sam", "turn", "must not throw");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("self-work classifies and specs the activity-failed class keyed by phase", () => {
  const { base, sam } = fixture();
  try {
    const line = { at: "2026-11-13T22:00:00.000Z", actor: "sam", kind: "activity-failed", summary: activityFailureSummary("EISDIR: illegal operation on a directory") };
    const cls = classifyDefect(line);
    assert.equal(cls?.key, "activity-failed:read");
    assert.equal(cls?.label, "activity ledger failures (read step)");
    recordActivity(sam, "sam", "activity-failed", line.summary);
    recordActivity(sam, "sam", "activity-failed", line.summary);
    const ranked = rankDefects(sam);
    assert.equal(ranked[0]?.key, "activity-failed:read");
    assert.equal(ranked[0]?.count, 2);
    const run = buildSelfWorkSpec(sam, null);
    assert.equal(run.spec?.defectKey, "activity-failed:read");
    assert.ok(run.spec?.files.includes("activity.ts"));
    assert.ok(run.spec?.endGoal.includes("activity ledger stops failing"), run.spec?.endGoal);
    assert.ok(run.spec?.doneLooksLike.some(d => d.includes("fails closed")), run.spec?.doneLooksLike.join(" | "));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
