import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHeartbeatJob, deliveryFailureSummary, runHeartbeat } from "./heartbeat.js";
import { markAttemptFailed, pendingDeliveries, queueDelivery, readDeliveries } from "./delivery-outbox.js";
import { readActivity } from "./activity.js";
import { classifyDefect } from "./self-work.js";

const deps = (over: Record<string, unknown> = {}) => ({
  ensureChat: async () => "hb-chat",
  runTurn: async () => "All quiet.",
  ...over,
}) as never;

function heartbeatLog(root: string): Record<string, unknown>[] {
  try {
    return readFileSync(join(root, ".sam", "heartbeats.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch { return []; }
}

test("deliveryFailureSummary names the attempt, and the terminal settle when capped", () => {
  const mid = deliveryFailureSummary("stack watch", "channel down", 2, false);
  assert.match(mid, /Delivery for heartbeat 'stack watch' failed \(attempt 2 of 5\): channel down/);
  assert.doesNotMatch(mid, /gave up/);
  const end = deliveryFailureSummary("stack watch", "channel down", 5, true);
  assert.match(end, /gave up after 5 attempts; the update will not be retried/);
  assert.ok(end.length <= 200);
});

test("markAttemptFailed reports the attempt count and the terminal settle", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-delivery-failure-"));
  try {
    const rec = queueDelivery(root, { jobId: "j1", jobName: "stack watch", profile: "trading", channelId: "chan-1", text: "owed news" });
    for (let i = 1; i <= 4; i++) {
      const r = markAttemptFailed(root, rec.id, "channel down");
      assert.equal(r.attempts, i);
      assert.equal(r.settled, false);
    }
    const fifth = markAttemptFailed(root, rec.id, "channel down");
    assert.equal(fifth.attempts, 5);
    assert.equal(fifth.settled, true);
    assert.equal(readDeliveries(root)[0].status, "failed");
    // An unknown id reports no attempt and no settle, and stays harmless.
    assert.deepEqual(markAttemptFailed(root, "no-such-id", "x"), { attempts: 0, settled: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed fresh delivery writes one delivery-failed activity line with the reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-delivery-failure-"));
  try {
    addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack", "chan-1");
    const d = deps({
      runTurn: async () => "Candidates total: 282,966",
      deliver: async () => { throw new Error("channel down"); },
    });
    const first = await runHeartbeat(root, d);
    assert.deepEqual(first.changed, ["stack watch"]);
    const activity = readActivity(root, 50, { kind: "delivery-failed" });
    assert.equal(activity.length, 1);
    assert.equal(activity[0].actor, "trading");
    assert.match(activity[0].summary, /Delivery for heartbeat 'stack watch' failed \(attempt 1 of 5\): channel down/);
    // The class feeds the self-work defect queue.
    assert.equal(classifyDefect(activity[0])?.key, "delivery-failed");
    // The heartbeats line now carries the reason too (parity with job-failed).
    const hb = heartbeatLog(root).filter((l) => l.type === "delivery-failed");
    assert.equal(hb.length, 1);
    assert.match(String(hb[0].reason), /channel down/);
    // The record stays pending for the recovery leg - behavior unchanged.
    assert.equal(pendingDeliveries(root).length, 1);
    assert.equal(pendingDeliveries(root)[0].attempts, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed recovery redelivery writes one delivery-failed activity line per tick", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-delivery-failure-"));
  try {
    queueDelivery(root, { jobId: "j1", jobName: "stack watch", profile: "trading", channelId: "chan-1", text: "owed news" });
    const d = deps({ deliver: async () => { throw new Error("channel down"); } });
    await runHeartbeat(root, d);
    const activity = readActivity(root, 50, { kind: "delivery-failed" });
    assert.equal(activity.length, 1);
    assert.equal(activity[0].actor, "trading");
    assert.match(activity[0].summary, /attempt 1 of 5/);
    const hb = heartbeatLog(root).filter((l) => l.type === "delivery-failed");
    assert.equal(hb.length, 1);
    assert.match(String(hb[0].reason), /channel down/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the fifth failed attempt ledgers the terminal settle, and later ticks stay silent", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-delivery-failure-"));
  try {
    queueDelivery(root, { jobId: "j1", jobName: "stack watch", profile: "trading", channelId: "chan-1", text: "owed news" });
    const d = deps({ deliver: async () => { throw new Error("channel down"); } });
    for (let i = 0; i < 5; i++) await runHeartbeat(root, d);
    const activity = readActivity(root, 50, { kind: "delivery-failed" });
    assert.equal(activity.length, 5);
    assert.doesNotMatch(activity[3].summary, /gave up/);
    assert.match(activity[4].summary, /attempt 5 of 5.*gave up after 5 attempts/);
    assert.equal(readDeliveries(root)[0].status, "failed");
    // Terminal: a further tick neither retries nor ledgers again.
    await runHeartbeat(root, d);
    assert.equal(readActivity(root, 50, { kind: "delivery-failed" }).length, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a successful delivery writes no delivery-failed line", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-delivery-failure-"));
  try {
    addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack", "chan-1");
    const d = deps({
      runTurn: async () => "Candidates total: 282,966",
      deliver: async () => {},
    });
    await runHeartbeat(root, d);
    assert.equal(readActivity(root, 50, { kind: "delivery-failed" }).length, 0);
    assert.equal(readDeliveries(root)[0].status, "delivered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
