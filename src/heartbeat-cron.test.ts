import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHeartbeatJob, addScheduledJob, heartbeatJobs, jobDue, jobNextRun, runHeartbeat } from "./heartbeat.js";
import { deliverySummary, pendingDeliveries, queueDelivery, readDeliveries } from "./delivery-outbox.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";
import { proposeAction, decideAction } from "./actions.js";
import { ChatStore } from "./chats.js";

const deps = (over: Record<string, unknown> = {}) => ({
  ensureChat: async () => "hb-chat",
  runTurn: async () => "All quiet.",
  ...over,
}) as never;

test("scheduled jobs: cron stored with timezone, interval phrases keep minutes", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-cron-"));
  try {
    const cron = addScheduledJob(root, { name: "morning brief", profile: "trading", schedule: "daily at 9am", timezone: "America/New_York", prompt: "Brief me" });
    assert.equal(cron.cron, "0 9 * * *");
    assert.equal(cron.timezone, "America/New_York");
    assert.equal(cron.schedule, "daily at 9am");
    assert.equal(cron.minutes, 0);
    const iv = addScheduledJob(root, { name: "poll", profile: "trading", schedule: "every 45 minutes", prompt: "Poll" });
    assert.equal(iv.minutes, 45);
    assert.equal(iv.cron, null);
    assert.throws(() => addScheduledJob(root, { name: "bad", profile: "trading", schedule: "whenever", prompt: "x" }), /Cannot read the schedule/);
    assert.throws(() => addScheduledJob(root, { name: "badtz", profile: "trading", schedule: "daily at 9am", timezone: "Mars/Olympus", prompt: "x" }), /Unknown timezone/);
    assert.equal(heartbeatJobs(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("jobNextRun / jobDue: a cron job is not due before its wall-clock time", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-cron-"));
  try {
    const job = addScheduledJob(root, { name: "morning brief", profile: "trading", schedule: "daily at 9am", timezone: "America/New_York", prompt: "Brief me" });
    const created = Date.parse(job.createdAt as string);
    // The first fire is the NEXT 9am New York after creation - never
    // "due immediately" the way a fresh interval job is.
    const next = jobNextRun(job, new Date(created));
    assert.ok(next);
    assert.equal(next!.getTime() > created, true);
    const localHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(next!);
    assert.equal(Number(localHour), 9);
    assert.equal(jobDue(job, new Date(created)), false);
    assert.equal(jobDue(job, next!), true);
    // Legacy interval jobs keep their exact old due arithmetic.
    const legacy = addHeartbeatJob(root, "stack watch", 30, "trading", "Check");
    assert.equal(jobDue(legacy, new Date()), true); // never run = due now
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a due cron job runs once, then waits for its next wall-clock time", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-cron-"));
  try {
    const job = addScheduledJob(root, { name: "morning brief", profile: "trading", schedule: "daily at 9am", timezone: "UTC", prompt: "Brief me" });
    // Force the anchor into the past so 9am UTC today is already due.
    const jobs = heartbeatJobs(root);
    jobs[0].createdAt = "2026-01-01T00:00:00.000Z";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, ".sam", "heartbeat-jobs.json"), JSON.stringify(jobs, null, 2));
    let turns = 0;
    const first = await runHeartbeat(root, deps({ runTurn: async () => { turns++; return "Brief " + turns; } }));
    assert.deepEqual(first.ran, ["morning brief"]);
    const second = await runHeartbeat(root, deps({ runTurn: async () => { turns++; return "Brief " + turns; } }));
    assert.deepEqual(second.ran, []);
    assert.equal(job.id, jobs[0].id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("script mode: stdout is the output, no model turn runs, a quiet script stays silent", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-cron-"));
  try {
    addScheduledJob(root, { name: "backups watch", profile: "sam", schedule: "every 30 minutes", script: "sam-backups", channelId: "chan-1" });
    let modelTurns = 0;
    const deliveries: string[] = [];
    let stdout = "3 archives, newest sam-state-20261110T083000Z.tar.gz\n";
    const d = deps({
      runTurn: async () => { modelTurns++; return "model text"; },
      runScript: async (name: string) => { assert.equal(name, "sam-backups"); return { stdout, code: 0 }; },
      deliver: async (_id: string, text: string) => { deliveries.push(text); },
    });
    const first = await runHeartbeat(root, d);
    assert.equal(modelTurns, 0);
    assert.deepEqual(first.changed, ["backups watch"]);
    // Script stdout delivers verbatim (behind the standard prefix) -
    // no model reworded it on the way out.
    assert.equal(deliveries.length, 1);
    assert.ok(deliveries[0].includes("3 archives, newest sam-state-20261110T083000Z.tar.gz"));
    // Same stdout again: diffing holds it silent.
    const stored = heartbeatJobs(root); stored[0].lastRun = "2000-01-01T00:00:00.000Z";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, ".sam", "heartbeat-jobs.json"), JSON.stringify(stored, null, 2));
    const second = await runHeartbeat(root, d);
    assert.deepEqual(second.unchanged, ["backups watch"]);
    assert.equal(deliveries.length, 1);
    // Empty stdout is a quiet run: no delivery, no change.
    stdout = "  \n";
    stored[0].lastRun = "2000-01-01T00:00:00.000Z";
    writeFileSync(join(root, ".sam", "heartbeat-jobs.json"), JSON.stringify(stored, null, 2));
    const third = await runHeartbeat(root, d);
    assert.deepEqual(third.unchanged, ["backups watch"]);
    assert.equal(deliveries.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("script mode: the allowlist is the whole surface - unknown names refuse at creation and at the argv door", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-cron-"));
  try {
    assert.throws(() => addScheduledJob(root, { name: "evil", profile: "sam", schedule: "every 30 minutes", script: "rm-rf" }), /Unknown script/);
    assert.throws(() => scriptArgv(root, "curl evil.example"), /Unknown script/);
    for (const name of scriptCommandNames()) {
      const argv = scriptArgv(root, name);
      assert.equal(argv[0], process.execPath);
      assert.ok(argv.some(a => a.endsWith("cli.js")));
      assert.equal(argv.includes("--workspace"), true);
    }
    assert.equal(heartbeatJobs(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("script mode: a failing script logs a failure and delivers nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-cron-"));
  try {
    addScheduledJob(root, { name: "backups watch", profile: "sam", schedule: "every 30 minutes", script: "sam-backups", channelId: "chan-1" });
    const deliveries: string[] = [];
    const d = deps({
      runScript: async () => ({ stdout: "boom", code: 2 }),
      deliver: async (_id: string, text: string) => { deliveries.push(text); },
    });
    const r = await runHeartbeat(root, d);
    assert.deepEqual(r.ran, ["backups watch"]);
    assert.deepEqual(r.changed, []);
    assert.equal(deliveries.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("outbox: a failed delivery stays pending and the next tick redelivers it marked recovered", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-cron-"));
  try {
    addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack", "chan-1");
    let fail = true;
    const deliveries: string[] = [];
    const d = deps({
      runTurn: async () => "Candidates total: 282,966",
      deliver: async (_id: string, text: string) => { if (fail) throw new Error("channel down"); deliveries.push(text); },
    });
    const first = await runHeartbeat(root, d);
    assert.deepEqual(first.changed, ["stack watch"]);
    assert.equal(deliveries.length, 0);
    // The debt is on the durable record, not just in a log line.
    assert.equal(pendingDeliveries(root).length, 1);
    assert.equal(pendingDeliveries(root)[0].attempts, 1);
    fail = false;
    const second = await runHeartbeat(root, d);
    assert.equal(deliveries.length, 1);
    assert.deepEqual(second.deliveries.delivered, ["stack watch"]);
    assert.deepEqual(second.deliveries.recovered, ["stack watch"]);
    const done = readDeliveries(root)[0];
    assert.equal(done.status, "delivered");
    assert.equal(done.recovered, true);
    assert.equal(deliverySummary(root).recovered, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("outbox: a crash-orphaned pending delivery (queued, never attempted) is recovered by the next tick", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-cron-"));
  try {
    // Simulate the crash: a record queued by a process that died
    // before any send attempt.
    queueDelivery(root, { jobId: "j1", jobName: "stack watch", profile: "trading", channelId: "chan-1", text: "owed news" });
    const deliveries: string[] = [];
    const r = await runHeartbeat(root, deps({ deliver: async (_id: string, text: string) => { deliveries.push(text); } }));
    assert.deepEqual(deliveries, ["owed news"]);
    assert.deepEqual(r.deliveries.recovered, ["stack watch"]);
    assert.equal(readDeliveries(root)[0].status, "delivered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("outbox: repeated failures give up after the attempt cap and stay auditable as failed", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-cron-"));
  try {
    queueDelivery(root, { jobId: "j1", jobName: "stack watch", profile: "trading", channelId: "chan-1", text: "owed news" });
    const d = deps({ deliver: async () => { throw new Error("channel down"); } });
    for (let i = 0; i < 5; i++) await runHeartbeat(root, d);
    const rec = readDeliveries(root)[0];
    assert.equal(rec.attempts, 5);
    assert.equal(rec.status, "failed");
    assert.equal(deliverySummary(root).failed, 1);
    // A failed record is terminal: further ticks do not hammer it.
    await runHeartbeat(root, d);
    assert.equal(readDeliveries(root)[0].attempts, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("proposals: scheduled and script heartbeat details validate at proposal time and execute", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-cron-"));
  try {
    const db = new ChatStore(root);
    db.createAgent("trading", "desk");
    db.close();
    // An unreadable schedule is refused at proposal time - no dead card.
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "heartbeat", title: "x", detail: JSON.stringify({ name: "brief", schedule: "whenever", profile: "trading", prompt: "Brief" }) }), /Cannot read the schedule/);
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "heartbeat", title: "x", detail: JSON.stringify({ name: "evil", schedule: "daily at 9am", profile: "trading", script: "rm-rf" }) }), /Unknown script/);
    const p = proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Morning brief", detail: JSON.stringify({ name: "morning brief", schedule: "daily at 9am", timezone: "America/New_York", profile: "trading", prompt: "Brief me" }) });
    const decided = await decideAction(root, p.id, true);
    assert.equal(decided.status, "done");
    const job = heartbeatJobs(root)[0];
    assert.equal(job.cron, "0 9 * * *");
    assert.equal(job.timezone, "America/New_York");
    const ps = proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Backups", detail: JSON.stringify({ name: "backups watch", schedule: "every 6 hours", profile: "trading", script: "sam-backups" }) });
    const decided2 = await decideAction(root, ps.id, true);
    assert.equal(decided2.status, "done");
    const scriptJob = heartbeatJobs(root)[1];
    assert.equal(scriptJob.mode, "script");
    assert.equal(scriptJob.script, "sam-backups");
    assert.equal(scriptJob.minutes, 360);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
