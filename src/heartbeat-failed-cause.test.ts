import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHeartbeatJob, addScheduledJob, heartbeatFailedSummary, heartbeatScriptFailedSummary, heartbeatFailureReason, runHeartbeat, heartbeatJobs } from "./heartbeat.js";
import { readActivity } from "./activity.js";

// Heartbeat job failures carry their cause (gap found
// 2026-11-16, hourly run 13:04 EST): both job-failure catch
// sites in the tick took e.message alone, so a job dying on
// transport ledgered the bare "fetch failed" wrapper in both
// the job-failed log line and the heartbeat-failed activity
// line. The reasons now compose through errorReason (the
// 04:04 bridge seam): causeless errors keep their plain
// message, a transport wrapper names its cause, and no bot
// token leaks.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-hb-cause-"));
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.minimax.io"), { code: "ENOTFOUND" }),
});

const deps = (over: Record<string, unknown> = {}) => ({
  ensureChat: async () => "hb-chat",
  runTurn: async () => "All quiet.",
  ...over,
}) as never;

function heartbeatLog(root: string): Record<string, unknown>[] {
  return readFileSync(join(root, ".sam", "heartbeats.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
}

test("a heartbeat failure summary names the transport cause behind the wrapper", () => {
  assert.equal(
    heartbeatFailedSummary("stack watch", dnsErr()),
    "Heartbeat 'stack watch' failed: fetch failed: getaddrinfo ENOTFOUND api.minimax.io",
  );
  assert.equal(heartbeatFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
});

test("a heartbeat script failure summary names the transport cause behind the wrapper", () => {
  assert.equal(
    heartbeatScriptFailedSummary("backups watch", dnsErr()),
    "Heartbeat 'backups watch' script failed: fetch failed: getaddrinfo ENOTFOUND api.minimax.io",
  );
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  assert.equal(
    heartbeatFailedSummary("stack watch", err),
    "Heartbeat 'stack watch' failed: fetch failed: read (ECONNRESET)",
  );
});

test("causeless heartbeat errors keep their plain message in both summaries", () => {
  assert.equal(
    heartbeatFailedSummary("stack watch", new Error("Unsafe model output")),
    "Heartbeat 'stack watch' failed: Unsafe model output",
  );
  assert.equal(
    heartbeatScriptFailedSummary("backups watch", new Error("spawn blew up")),
    "Heartbeat 'backups watch' script failed: spawn blew up",
  );
  assert.equal(heartbeatFailedSummary("stack watch", "plain string failure"), "Heartbeat 'stack watch' failed: plain string failure");
});

test("no bot token leaks through a heartbeat failure summary", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const summary = heartbeatFailedSummary("stack watch", err);
  assert.equal(summary.includes("AAE-secret_token"), false);
  assert.equal(summary.includes("987654"), false);
  assert.match(summary, /bot<redacted>/);
});

test("a heartbeat failure reason slice caps at 160 in the activity summary, not in the log reason", () => {
  const summary = heartbeatFailedSummary("stack watch", new Error("x".repeat(400)));
  assert.equal(summary, "Heartbeat 'stack watch' failed: " + "x".repeat(160));
  assert.equal(heartbeatFailureReason(new Error("x".repeat(400))).length, 400);
});

test("an agent job dying on transport carries its cause in both failure records, and the tick still isolates it", async () => {
  const root = scratch();
  try {
    addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack");
    const out = await runHeartbeat(root, deps({ runTurn: async () => { throw dnsErr(); } }));
    assert.deepEqual(out.failed, ["stack watch"]);
    assert.deepEqual(out.ran, ["stack watch"]);
    const failed = heartbeatLog(root).find(l => l.type === "job-failed");
    assert.equal(failed?.reason, "fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
    const line = readActivity(root, 500).find(l => l.kind === "heartbeat-failed");
    assert.equal(line?.summary, "Heartbeat 'stack watch' failed: fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
    // lastRun advanced: the schedule moves on, the failure is recorded once.
    const job = heartbeatJobs(root)[0];
    assert.ok(job.lastRun);
    const second = await runHeartbeat(root, deps({ runTurn: async () => { throw dnsErr(); } }));
    assert.deepEqual(second.ran, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a script job whose runner throws on transport carries its cause in both failure records", async () => {
  const root = scratch();
  try {
    addScheduledJob(root, { name: "backups watch", profile: "sam", schedule: "every 30 minutes", script: "sam-backups" });
    const out = await runHeartbeat(root, deps({ runScript: async () => { throw dnsErr(); } }));
    assert.deepEqual(out.failed, ["backups watch"]);
    const failed = heartbeatLog(root).find(l => l.type === "job-failed");
    assert.equal(failed?.reason, "fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
    const line = readActivity(root, 500).find(l => l.kind === "heartbeat-failed");
    assert.equal(line?.summary, "Heartbeat 'backups watch' script failed: fetch failed: getaddrinfo ENOTFOUND api.minimax.io");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a causeless agent job failure reads byte-identically in both records", async () => {
  const root = scratch();
  try {
    addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack");
    const out = await runHeartbeat(root, deps({ runTurn: async () => { throw new Error("Unsafe model output"); } }));
    assert.deepEqual(out.failed, ["stack watch"]);
    const failed = heartbeatLog(root).find(l => l.type === "job-failed");
    assert.equal(failed?.reason, "Unsafe model output");
    const line = readActivity(root, 500).find(l => l.kind === "heartbeat-failed");
    assert.equal(line?.summary, "Heartbeat 'stack watch' failed: Unsafe model output");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
