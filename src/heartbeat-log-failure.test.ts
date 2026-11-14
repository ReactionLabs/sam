import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { addHeartbeatJob, heartbeatLog, heartbeatLogFailureSummary, runHeartbeat, tickStageFailure } from "./heartbeat.js";
import { classifyDefect, rankDefects } from "./self-work.js";

// Heartbeat log failure visibility (gap found 2026-11-13,
// hourly run 21:04): .sam/heartbeats.jsonl was the one ledger
// never in the failure-visibility family - appendLog was a bare
// appendFileSync and the read a bare readFileSync. Worse, the
// tick guard's own tick-failed line rides that append BEFORE
// its activity line, so a dead heartbeat log threw inside
// guardTickStage's catch, the activity line never landed, and
// the whole tick died with only the systemd journal as witness.
// The append now never throws (one heartbeat-log-failed line,
// type + job name only, never the entry payload) and returns
// whether it landed; the read fails closed (one line, then the
// rethrow), because status and the brief fold this log as truth.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-hblog-fail-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  return { base, sam };
}

// Plant a directory where the log file belongs: the read and
// the append both throw EISDIR, the dead-ledger shape.
function plantDir(sam: string) {
  mkdirSync(join(sam, ".sam"), { recursive: true });
  mkdirSync(join(sam, ".sam", "heartbeats.jsonl"));
}

// Plant a dangling symlink: existsSync reads false, so the
// read succeeds empty; the append follows the link and dies
// ENOENT - the append-only failure shape.
function plantSymlink(base: string, sam: string) {
  mkdirSync(join(sam, ".sam"), { recursive: true });
  symlinkSync(join(base, "missing", "heartbeats.jsonl"), join(sam, ".sam", "heartbeats.jsonl"));
}

const deps = (over: Record<string, unknown> = {}) => ({
  ensureChat: async () => "hb-chat",
  runTurn: async () => "All quiet.",
  ...over,
}) as never;

test("heartbeat-log-failed summary: names phase, entry type and job, caps the reason, never carries payload", () => {
  const s = heartbeatLogFailureSummary("append", "job", "stack watch", "EISDIR: illegal operation\non a directory");
  assert.ok(s.startsWith("Heartbeat log append failed for job job 'stack watch': EISDIR"), s);
  assert.ok(!s.includes("\n"), "the reason is collapsed to one line");
  assert.equal(heartbeatLogFailureSummary("read", "ledger", null, "boom"), "Heartbeat log read failed for ledger: boom");
  assert.ok(heartbeatLogFailureSummary("append", "job", null, "x".repeat(500)).length <= 300);
});

test("a dead append never throws and ledgers exactly one append line naming type and job, never the reply", async () => {
  const { base, sam } = fixture();
  try {
    plantSymlink(base, sam);
    addHeartbeatJob(sam, "stack watch", 30, "trading", "Check the stack");
    const result = await runHeartbeat(sam, deps({ runTurn: async () => "secret reply preview text" }));
    assert.deepEqual(result.ran, ["stack watch"], "the job still ran - the log never breaks the tick");
    const lines = readActivity(sam, 200, { kind: "heartbeat-log-failed" });
    assert.ok(lines.length >= 1, "at least the changed job's append failure landed");
    assert.ok(lines.every((l) => l.actor === "sam"));
    assert.ok(lines.every((l) => l.summary.startsWith("Heartbeat log append failed for ")), lines.map((l) => l.summary).join(" | "));
    assert.ok(lines.some((l) => l.summary.includes("job 'stack watch'")), lines.map((l) => l.summary).join(" | "));
    assert.ok(!lines.some((l) => l.summary.includes("secret reply preview")), "the entry payload (reply preview) never enters the failure line");
    assert.equal(classifyDefect(lines[0])?.key, "heartbeat-log-failed:append");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the tick guard survives a dead heartbeat log: tickStageFailure's activity line always lands", () => {
  const { sam } = fixture();
  try {
    plantDir(sam);
    // Before the fix this threw out of tickStageFailure itself:
    // the append is its first statement, so the guard died on its
    // own pen and no activity line was ever recorded.
    tickStageFailure(sam, "consolidate", new Error("file is not a database"));
    const activity = readActivity(sam, 50, { kind: "tick-failed" });
    assert.equal(activity.length, 1, "the tick-failed activity line landed despite the dead log");
    assert.match(activity[0].summary, /tick stage 'consolidate' failed: file is not a database/);
    const failures = readActivity(sam, 50, { kind: "heartbeat-log-failed" });
    assert.equal(failures.length, 1, "exactly one append line for the failed tick-failed append");
    assert.ok(failures[0].summary.startsWith("Heartbeat log append failed for tick-failed: "), failures[0].summary);
  } finally { rmSync(sam.replace(/\/home$/, ""), { recursive: true, force: true }); }
});

test("a dead read fails closed: one read line, then the rethrow; absent still reads []", () => {
  const { base, sam } = fixture();
  try {
    assert.deepEqual(heartbeatLog(sam), [], "an absent log reads [] with no failure line");
    assert.equal(readActivity(sam, 50, { kind: "heartbeat-log-failed" }).length, 0);
    plantDir(sam);
    assert.throws(() => heartbeatLog(sam), /EISDIR|illegal operation/i,
      "a fold to [] would report no failed jobs and no ticks ever, so the read still throws");
    const lines = readActivity(sam, 50, { kind: "heartbeat-log-failed" });
    assert.equal(lines.length, 1, "exactly one line per failed read");
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Heartbeat log read failed for ledger: "), lines[0].summary);
    assert.equal(classifyDefect(lines[0])?.key, "heartbeat-log-failed:read");
    const ranked = rankDefects(sam);
    assert.ok(ranked.some((d) => d.key === "heartbeat-log-failed:read"), "self-work ranks the class: " + JSON.stringify(ranked.map((d) => d.key)));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a healthy tick writes its log lines with zero failure lines", async () => {
  const { base, sam } = fixture();
  try {
    addHeartbeatJob(sam, "stack watch", 30, "trading", "Check the stack");
    const result = await runHeartbeat(sam, deps());
    assert.deepEqual(result.ran, ["stack watch"]);
    assert.ok(heartbeatLog(sam).some((l) => l.type === "job"), "the job line landed in the real log");
    assert.equal(readActivity(sam, 50, { kind: "heartbeat-log-failed" }).length, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
