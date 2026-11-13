import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHeartbeatJob, runHeartbeat, tickStageFailure } from "./heartbeat.js";
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

test("tickStageFailure ledgers one tick-failed line in both records, reason capped", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-tick-guard-"));
  try {
    tickStageFailure(root, "consolidate", new Error("file is not a database"));
    const lines = heartbeatLog(root).filter((l) => l.type === "tick-failed");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].stage, "consolidate");
    assert.match(String(lines[0].reason), /not a database/);
    const activity = readActivity(root, 10, { kind: "tick-failed" });
    assert.equal(activity.length, 1);
    assert.equal(activity[0].actor, "sam");
    assert.match(activity[0].summary, /tick stage 'consolidate' failed: file is not a database/);
    // The class feeds the self-work defect queue, keyed by stage.
    assert.equal(classifyDefect(activity[0])?.key, "tick-failed:consolidate");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a consolidation failure no longer wedges the tick: the due job still runs and the failure is recorded once per tick", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-tick-guard-"));
  try {
    addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack");
    // A corrupt chats.db makes consolidation's ChatStore open throw -
    // the persistent-wedge shape: before the guard, every tick died on
    // its first statement and no job ever ran again.
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "chats.db"), "this is not a sqlite database");
    const first = await runHeartbeat(root, deps());
    assert.deepEqual(first.ran, ["stack watch"]);
    assert.ok(first.stageFailures.includes("consolidate"), "stageFailures names the failed stage: " + JSON.stringify(first.stageFailures));
    assert.equal(first.consolidation.scanned, 0);
    assert.equal(heartbeatLog(root).filter((l) => l.type === "tick-failed" && l.stage === "consolidate").length, 1);
    assert.equal(readActivity(root, 50, { kind: "tick-failed" }).filter((l) => /stage 'consolidate'/.test(l.summary)).length, 1);
    // The next tick records the still-failing stage again (countable,
    // one line per tick) and the job's schedule still advances.
    const second = await runHeartbeat(root, deps());
    assert.ok(second.stageFailures.includes("consolidate"));
    assert.equal(heartbeatLog(root).filter((l) => l.type === "tick-failed" && l.stage === "consolidate").length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a healthy tick records no stage failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-tick-guard-"));
  try {
    addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack");
    const r = await runHeartbeat(root, deps());
    assert.deepEqual(r.stageFailures, []);
    assert.deepEqual(r.ran, ["stack watch"]);
    assert.equal(heartbeatLog(root).filter((l) => l.type === "tick-failed").length, 0);
    assert.equal(readActivity(root, 50, { kind: "tick-failed" }).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
