import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHeartbeatJob, recordDeliveryFailure, runHeartbeat } from "./heartbeat.js";
import { recordLoopDeliveryFailure } from "./loop-revisit.js";
import { pendingDeliveries, readDeliveries } from "./delivery-outbox.js";
import { readActivity } from "./activity.js";

// Delivery failures carry their cause (gap found 2026-11-16,
// hourly run 05:04 EST): the 04:04 bridge fix cured the poll
// seam, but recordDeliveryFailure / recordLoopDeliveryFailure
// and the outbox / heartbeats-log records still took
// error.message alone, so the live delivery-failed line read
// the bare undici "fetch failed" and named nothing. Every
// record of a failed delivery now rides errorReason.

const causeErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.telegram.org"), { code: "ENOTFOUND" }),
});

test("a heartbeat delivery failure ledgers the transport cause", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-delivery-cause-"));
  try {
    recordDeliveryFailure(root, "trading", "self-work", causeErr(), { attempts: 1, settled: false });
    const lines = readActivity(root, 10, { kind: "delivery-failed" });
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /Delivery for heartbeat 'self-work' failed \(attempt 1 of 5\): fetch failed: getaddrinfo ENOTFOUND api\.telegram\.org/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a second-answer delivery failure ledgers the transport cause", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-delivery-cause-"));
  try {
    recordLoopDeliveryFailure(root, "dip", causeErr(), { attempts: 5, settled: true });
    const lines = readActivity(root, 10, { kind: "delivery-failed" });
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /fetch failed: getaddrinfo ENOTFOUND api\.telegram\.org/);
    assert.match(lines[0].summary, /gave up after 5 attempts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a causeless delivery error reads exactly as before, and no bot token leaks", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-delivery-cause-"));
  try {
    recordDeliveryFailure(root, "trading", "stack watch", new Error("Telegram request failed (HTTP 502)"), { attempts: 2, settled: false });
    const url = "https://api.telegram.org/bot123456:AAE-secret_token/sendMessage";
    recordDeliveryFailure(root, "trading", "stack watch",
      new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") }), { attempts: 3, settled: false });
    const lines = readActivity(root, 10, { kind: "delivery-failed" });
    assert.equal(lines.length, 2);
    assert.match(lines[0].summary, /: Telegram request failed \(HTTP 502\)$/);
    assert.equal(lines[1].summary.includes("AAE-secret_token"), false);
    assert.equal(lines[1].summary.includes("123456"), false);
    assert.match(lines[1].summary, /bot<redacted>/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed fresh delivery records the cause in the activity line, the outbox fold, and the heartbeats log", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-delivery-cause-"));
  try {
    addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack", "chan-1");
    const deps = {
      ensureChat: async () => "hb-chat",
      runTurn: async () => "Candidates total: 282,966",
      deliver: async () => { throw causeErr(); },
    } as never;
    const first = await runHeartbeat(root, deps);
    assert.deepEqual(first.changed, ["stack watch"]);
    const activity = readActivity(root, 50, { kind: "delivery-failed" });
    assert.equal(activity.length, 1);
    assert.match(activity[0].summary, /fetch failed: getaddrinfo ENOTFOUND api\.telegram\.org/);
    const pending = pendingDeliveries(root);
    assert.equal(pending.length, 1);
    const fold = readDeliveries(root).find(d => d.id === pending[0].id);
    assert.match(JSON.stringify(fold), /ENOTFOUND/);
    const log = readFileSync(join(root, ".sam", "heartbeats.jsonl"), "utf8")
      .split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
      .filter(l => l.type === "delivery-failed");
    assert.equal(log.length, 1);
    assert.match(String(log[0].reason), /fetch failed: getaddrinfo ENOTFOUND api\.telegram\.org/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
