import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import {
  deliverySummary, markAttemptFailed, markDelivered, markSuppressed,
  outboxFailureSummary, pendingDeliveries, queueDelivery, readDeliveries,
} from "./delivery-outbox.js";
import { classifyDefect, rankDefects } from "./self-work.js";

// Delivery outbox ledger failure visibility (gap found
// 2026-11-13, hourly run 20:04): both touches of
// .sam/delivery-outbox.jsonl were unguarded, so a dead queue
// append lost a changed reply's only durable record, a dead
// markDelivered append threw inside the send's own try and
// reclassified a delivered update as a failed attempt, a dead
// markAttemptFailed append threw out of the failure handler,
// and a dead read threw raw out of the heartbeat legs, status,
// and the CLI - while folding it to [] would have read as
// "no deliveries owed". The read and the queue append now fail
// closed (one outbox-failed line, then the rethrow); the
// transition appends never throw and never reclassify the
// send, attempt, or hold that already happened.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-outbox-fail-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  return { base, sam };
}

// Plant a directory where the ledger file belongs: the read
// and the append both throw EISDIR, the dead-ledger shape.
function plantDir(sam: string) {
  mkdirSync(join(sam, ".sam"), { recursive: true });
  mkdirSync(join(sam, ".sam", "delivery-outbox.jsonl"));
}

// Plant a dangling symlink: existsSync reads false, so the
// read succeeds empty; the append follows the link and dies
// ENOENT - the append-only failure shape.
function plantSymlink(base: string, sam: string) {
  mkdirSync(join(sam, ".sam"), { recursive: true });
  symlinkSync(join(base, "missing", "delivery-outbox.jsonl"), join(sam, ".sam", "delivery-outbox.jsonl"));
}

const job = { jobId: "j1", jobName: "stack watch", profile: "trading", channelId: "chan-1", text: "owed news, secret delivery body" };

test("outbox-failed: a dead read fails closed - one read line, then the rethrow", () => {
  const { base, sam } = fixture();
  try {
    plantDir(sam);
    assert.throws(() => readDeliveries(sam), /EISDIR|illegal operation/i,
      "a fold to [] would read as no deliveries owed, so the read still throws");
    const lines = readActivity(sam, 100, { kind: "outbox-failed" });
    assert.equal(lines.length, 1, "exactly one line per failed read");
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Delivery outbox read failed for ledger: "), lines[0].summary);
    // The summary fold rides the same seam and surfaces too.
    assert.throws(() => deliverySummary(sam), /EISDIR|illegal operation/i);
    assert.equal(readActivity(sam, 100, { kind: "outbox-failed" }).length, 2, "one line per failed touch");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("outbox-failed: a dead queue append fails closed - one append line naming the job, then the rethrow", () => {
  const { base, sam } = fixture();
  try {
    plantDir(sam);
    assert.throws(() => queueDelivery(sam, job), /EISDIR|illegal operation/i,
      "an unrecorded queue is a delivery owed that nobody can prove was owed, so the queue still throws");
    const lines = readActivity(sam, 100, { kind: "outbox-failed" });
    assert.equal(lines.length, 1, "exactly one line per failed queue");
    assert.equal(lines[0].actor, "trading", "the queue line carries the delivery's profile");
    assert.ok(lines[0].summary.startsWith("Delivery outbox append failed for queued delivery for heartbeat 'stack watch': "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("secret delivery body"), "the delivery text never enters the line");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("outbox-failed: an append-only queue failure ledgers once - the dangling symlink shape", () => {
  const { base, sam } = fixture();
  try {
    plantSymlink(base, sam);
    assert.throws(() => queueDelivery(sam, job), /ENOENT/i);
    assert.deepEqual(readDeliveries(sam), [], "the record did not land - the ledger still reads empty, honestly");
    const lines = readActivity(sam, 100, { kind: "outbox-failed" });
    assert.equal(lines.length, 1, "the read succeeded, so only the append ledgers");
    assert.ok(lines[0].summary.startsWith("Delivery outbox append failed for queued delivery"), lines[0].summary);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("outbox-failed: transition appends never throw and never reclassify - delivered, suppressed, attempt-failed", () => {
  const { base, sam } = fixture();
  try {
    const rec = queueDelivery(sam, job);
    // Swap the landed ledger for a dangling symlink: reads now
    // succeed empty, every append dies ENOENT.
    rmSync(join(sam, ".sam", "delivery-outbox.jsonl"));
    symlinkSync(join(base, "missing", "delivery-outbox.jsonl"), join(sam, ".sam", "delivery-outbox.jsonl"));
    assert.equal(markDelivered(sam, rec.id, false), false, "a delivered send reports its record did not land instead of throwing");
    assert.equal(markSuppressed(sam, rec.id, "held"), false);
    assert.deepEqual(markAttemptFailed(sam, rec.id, "channel down"), { attempts: 0, settled: false },
      "the attempt handler returns instead of throwing out of the caller's catch");
    const lines = readActivity(sam, 100, { kind: "outbox-failed" });
    assert.equal(lines.length, 3, "one append line per failed transition");
    assert.ok(lines.every(l => l.summary.startsWith("Delivery outbox append failed for ")), lines.map(l => l.summary).join(" | "));
    assert.ok(lines[0].summary.includes("delivered event for delivery " + rec.id.slice(0, 8)), lines[0].summary);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("outbox-failed: markAttemptFailed on a fully dead ledger stands on the read line plus one append line", () => {
  const { base, sam } = fixture();
  try {
    plantDir(sam);
    let result: { attempts: number; settled: boolean } | undefined;
    assert.doesNotThrow(() => { result = markAttemptFailed(sam, "some-id", "channel down"); },
      "the failure handler itself never throws");
    assert.deepEqual(result, { attempts: 0, settled: false }, "a dead read reads as an unknown count, never a fabricated one");
    const lines = readActivity(sam, 100, { kind: "outbox-failed" });
    assert.equal(lines.filter(l => l.summary.startsWith("Delivery outbox read failed")).length, 1, "the dead read ledgers once, under its own seam");
    assert.equal(lines.filter(l => l.summary.startsWith("Delivery outbox append failed")).length, 1, "the dead append ledgers once, never mislabeled a read");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("outbox-failed: healthy deliveries queue, transition, read back, and ledger nothing", () => {
  const { base, sam } = fixture();
  try {
    const rec = queueDelivery(sam, job);
    assert.deepEqual(markAttemptFailed(sam, rec.id, "channel down"), { attempts: 1, settled: false });
    assert.equal(pendingDeliveries(sam).length, 1);
    assert.equal(markDelivered(sam, rec.id, true), true);
    const held = queueDelivery(sam, { ...job, jobId: "j2" });
    assert.equal(markSuppressed(sam, held.id, "held by the worthiness gate"), true);
    const all = readDeliveries(sam);
    assert.equal(all[0].status, "delivered");
    assert.equal(all[1].status, "suppressed");
    assert.deepEqual(deliverySummary(sam), { pending: 0, delivered: 1, suppressed: 1, failed: 0, recovered: 1 });
    assert.equal(readActivity(sam, 100, { kind: "outbox-failed" }).length, 0, "no failure line on the healthy path");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("outbox failure summaries collapse and cap the verbatim reason", () => {
  const read = outboxFailureSummary("read", "ledger", "EISDIR: illegal operation\n  on a directory");
  assert.ok(!read.includes("\n"), "the reason is one line");
  const append = outboxFailureSummary("append", "queued delivery for heartbeat 'stack watch'", "x".repeat(500));
  assert.ok(append.length <= 200, "the summary is capped at 200");
  assert.ok(append.startsWith("Delivery outbox append failed for queued delivery"), "an append failure names the event it could not record");
});

test("outbox-failed kinds classify keyed by phase and rank", () => {
  const line = (summary: string) => ({ at: "2026-11-14T01:00:00.000Z", actor: "sam", kind: "outbox-failed", summary });
  assert.deepEqual(classifyDefect(line("Delivery outbox append failed for queued delivery for heartbeat 'stack watch': ENOENT")),
    { key: "outbox-failed:append", label: "delivery outbox ledger failures (append step)" });
  assert.deepEqual(classifyDefect(line("Delivery outbox read failed for ledger: EISDIR")),
    { key: "outbox-failed:read", label: "delivery outbox ledger failures (read step)" });
  const { base, sam } = fixture();
  try {
    recordActivity(sam, "sam", "outbox-failed", "Delivery outbox append failed for queued delivery for heartbeat 'stack watch': ENOENT");
    recordActivity(sam, "sam", "outbox-failed", "Delivery outbox read failed for ledger: EISDIR");
    const ranked = rankDefects(sam);
    assert.equal(ranked.find(r => r.key === "outbox-failed:append")?.count, 1);
    assert.equal(ranked.find(r => r.key === "outbox-failed:read")?.count, 1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
