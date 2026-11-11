import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSchedule, ownerTimezone } from "./schedule.js";
import { addHeartbeatJob, addScheduledJob, heartbeatJobs, heartbeatLog, jobDue, jobNextRun, runHeartbeat, updateHeartbeatJob } from "./heartbeat.js";
import { proposeAction, decideAction, listActions } from "./actions.js";
import { addChannel } from "./channels.js";
import { saveBridgeState } from "./telegram.js";
import { ChatStore } from "./chats.js";

// The Telegram reminder gaps (2026-11-10): a heartbeat proposed
// from a channel chat carried no channel, a one-shot reminder was
// unrepresentable (it became a daily job), and a scheduled job
// with no timezone meant UTC - 3am owner time for an 8am ask.
// These tests pin the three fixes at their seams.

const deps = (over: Record<string, unknown> = {}) => ({
  ensureChat: async () => "hb-chat",
  runTurn: async () => "Time to stretch.",
  ...over,
}) as never;

function localPartsIn(tz: string, at: Date): Record<string, number> {
  const p: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return p;
}
const pad = (n: number) => String(n).padStart(2, "0");

test("compileSchedule: one-shot forms compile to an absolute instant in the job's timezone", () => {
  // ISO date + clock, interpreted in America/New_York: two days out
  // at 08:00 local, whatever today is.
  const future = new Date(Date.now() + 2 * 24 * 3600 * 1000);
  const lp = localPartsIn("America/New_York", future);
  const phrase = "once at " + lp.year + "-" + pad(lp.month) + "-" + pad(lp.day) + " 08:00";
  const iso = compileSchedule(phrase, "America/New_York");
  assert.equal(iso.kind, "once");
  assert.equal(iso.cron, null);
  assert.ok(iso.onceAt);
  const back = localPartsIn("America/New_York", new Date(iso.onceAt as string));
  assert.equal(back.year, lp.year); assert.equal(back.month, lp.month); assert.equal(back.day, lp.day);
  assert.equal(back.hour, 8); assert.equal(back.minute, 0);
  // today / tomorrow forms ride the same conversion.
  const tomorrow = compileSchedule("once at 8am tomorrow", "UTC");
  assert.equal(tomorrow.kind, "once");
  const tParts = localPartsIn("UTC", new Date(tomorrow.onceAt as string));
  assert.equal(tParts.hour, 8);
  const todayUtc = localPartsIn("UTC", new Date());
  const expected = new Date(Date.UTC(todayUtc.year, todayUtc.month - 1, todayUtc.day + 1));
  assert.equal(tParts.day, expected.getUTCDate());
  assert.equal(tParts.month, expected.getUTCMonth() + 1);
  // A one-shot already past is refused at compile time - it could
  // never fire, so it is never stored and never becomes a card.
  assert.throws(() => compileSchedule("once at 2020-01-01 08:00", "UTC"), /already past/);
  assert.throws(() => compileSchedule("once whenever", "UTC"), /Cannot read the schedule/);
});

test("ownerTimezone: SAM_OWNER_TIMEZONE wins, an invalid value falls back, the default is the owner's zone", () => {
  const saved = process.env.SAM_OWNER_TIMEZONE;
  try {
    delete process.env.SAM_OWNER_TIMEZONE;
    assert.equal(ownerTimezone(), "America/New_York");
    process.env.SAM_OWNER_TIMEZONE = "Europe/London";
    assert.equal(ownerTimezone(), "Europe/London");
    process.env.SAM_OWNER_TIMEZONE = "Mars/Olympus";
    assert.equal(ownerTimezone(), "America/New_York");
  } finally {
    if (saved === undefined) delete process.env.SAM_OWNER_TIMEZONE; else process.env.SAM_OWNER_TIMEZONE = saved;
  }
});

test("addScheduledJob: no timezone means the owner's timezone; an explicit one wins; one-shots store onceAt", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-once-"));
  try {
    const daily = addScheduledJob(root, { name: "morning", profile: "dip", schedule: "daily at 9am", prompt: "Hi" });
    assert.equal(daily.timezone, "America/New_York");
    const utc = addScheduledJob(root, { name: "utc job", profile: "dip", schedule: "daily at 9am", timezone: "UTC", prompt: "Hi" });
    assert.equal(utc.timezone, "UTC");
    const future = new Date(Date.now() + 3 * 3600 * 1000);
    const lp = localPartsIn("UTC", future);
    const once = addScheduledJob(root, { name: "dentist", profile: "dip", schedule: "once at " + lp.year + "-" + pad(lp.month) + "-" + pad(lp.day) + " " + pad(lp.hour) + ":" + pad(lp.minute), timezone: "UTC", prompt: "Remind me" });
    assert.ok(once.onceAt && Math.abs(Date.parse(once.onceAt) - future.getTime()) < 60_000);
    assert.equal(once.cron, null);
    assert.equal(jobDue(once, new Date()), false); // not yet
    assert.equal(jobNextRun(once)?.toISOString(), once.onceAt);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a due one-shot fires exactly once and retires itself; a recurring job stays", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-once-"));
  try {
    const future = new Date(Date.now() + 3600 * 1000);
    const lp = localPartsIn("UTC", future);
    addScheduledJob(root, { name: "dentist", profile: "sam", schedule: "once at " + lp.year + "-" + pad(lp.month) + "-" + pad(lp.day) + " " + pad(lp.hour) + ":" + pad(lp.minute), timezone: "UTC", prompt: "Remind me", channelId: "chan-1" });
    addHeartbeatJob(root, "stack watch", 30, "sam", "Check");
    // Force the one-shot due by moving its instant into the past.
    const jobs = heartbeatJobs(root);
    updateHeartbeatJob(root, jobs[0].id, { onceAt: "2020-01-01T00:00:00.000Z" });
    const deliveries: string[] = [];
    const d = deps({ deliver: async (_id: string, text: string) => { deliveries.push(text); } });
    const first = await runHeartbeat(root, d);
    assert.ok(first.ran.includes("dentist"));
    assert.equal(deliveries.length, 1);
    assert.ok(deliveries[0].includes("Time to stretch."));
    // The one-shot is GONE from the store; the recurring job remains.
    const after = heartbeatJobs(root);
    assert.deepEqual(after.map(j => j.name), ["stack watch"]);
    assert.ok(heartbeatLog(root, 50).some(l => l.type === "job-retired" && l.name === "dentist"));
    // A later tick has nothing to refire.
    const second = await runHeartbeat(root, deps({ runTurn: async () => "again" }));
    assert.ok(!second.ran.includes("dentist"));
    assert.equal(deliveries.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a one-shot whose turn fails still retires (the failure is logged once, never refired every tick)", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-once-"));
  try {
    const future = new Date(Date.now() + 3600 * 1000);
    const lp = localPartsIn("UTC", future);
    addScheduledJob(root, { name: "dentist", profile: "sam", schedule: "once at " + lp.year + "-" + pad(lp.month) + "-" + pad(lp.day) + " " + pad(lp.hour) + ":" + pad(lp.minute), timezone: "UTC", prompt: "Remind me" });
    const jobs = heartbeatJobs(root);
    updateHeartbeatJob(root, jobs[0].id, { onceAt: "2020-01-01T00:00:00.000Z" });
    const r = await runHeartbeat(root, deps({ runTurn: async () => { throw new Error("model down"); } }));
    assert.deepEqual(r.failed, ["dentist"]);
    assert.deepEqual(heartbeatJobs(root), []);
    assert.ok(heartbeatLog(root, 50).some(l => l.type === "job-retired" && l.name === "dentist"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channel inheritance: a heartbeat proposed in a Telegram chat delivers back to that channel", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-once-"));
  try {
    const db = new ChatStore(root);
    db.createAgent("dip", "the owner's own SAM");
    const tgChat = db.create("Telegram · dip", "dip");
    const plainChat = db.create("Daily chat", "dip");
    db.close();
    const channel = addChannel(root, "telegram", "Dip Telegram", "dip", "SAM_CHANNEL_TG_MAIN", [6300316150]);
    saveBridgeState(root, { offset: 0, chats: { "6300316150": tgChat.id } });
    // Proposed from the Telegram chat with no channelId: the stored
    // card already carries the channel, and approval creates a job
    // bound to it.
    const p = proposeAction(root, { actor: "dip", kind: "heartbeat", title: "8am reminder", detail: JSON.stringify({ name: "8am reminder", schedule: "daily at 8am", profile: "dip", prompt: "Say the reminder" }), chatId: tgChat.id });
    const stored = JSON.parse(listActions(root).find(a => a.id === p.id)!.detail) as { channelId?: string };
    assert.equal(stored.channelId, channel.id);
    const decided = await decideAction(root, p.id, true);
    assert.equal(decided.status, "done");
    assert.equal(heartbeatJobs(root)[0].channelId, channel.id);
    // The inherited job also defaults to the owner's timezone.
    assert.equal(heartbeatJobs(root)[0].timezone, "America/New_York");
    // Proposed from a chat that lives on no channel: nothing inherited.
    const p2 = proposeAction(root, { actor: "dip", kind: "heartbeat", title: "Dashboard job", detail: JSON.stringify({ name: "dash job", schedule: "daily at 9am", profile: "dip", prompt: "Hi" }), chatId: plainChat.id });
    const stored2 = JSON.parse(listActions(root).find(a => a.id === p2.id)!.detail) as { channelId?: string };
    assert.equal(stored2.channelId, undefined);
    // An explicit channelId wins over inheritance, and an unknown
    // one is refused at proposal time naming the registry.
    const p3 = proposeAction(root, { actor: "dip", kind: "heartbeat", title: "Explicit", detail: JSON.stringify({ name: "explicit job", schedule: "daily at 9am", profile: "dip", prompt: "Hi", channelId: channel.id }), chatId: plainChat.id });
    assert.equal((JSON.parse(listActions(root).find(a => a.id === p3.id)!.detail) as { channelId?: string }).channelId, channel.id);
    assert.throws(() => proposeAction(root, { actor: "dip", kind: "heartbeat", title: "Bogus", detail: JSON.stringify({ name: "bogus job", schedule: "daily at 9am", profile: "dip", prompt: "Hi", channelId: "nope" }) }), /Unknown channel "nope".*Dip Telegram/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a one-shot proposal from a channel chat executes to a one-shot job on that channel", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-once-"));
  try {
    const db = new ChatStore(root);
    db.createAgent("dip", "the owner's own SAM");
    const tgChat = db.create("Telegram · dip", "dip");
    db.close();
    const channel = addChannel(root, "telegram", "Dip Telegram", "dip", "SAM_CHANNEL_TG_MAIN", [6300316150]);
    saveBridgeState(root, { offset: 0, chats: { "6300316150": tgChat.id } });
    const p = proposeAction(root, { actor: "dip", kind: "heartbeat", title: "Dentist reminder", detail: JSON.stringify({ name: "dentist reminder", schedule: "once at 8am tomorrow", profile: "dip", prompt: "Remind the owner about the dentist" }), chatId: tgChat.id });
    const decided = await decideAction(root, p.id, true);
    assert.equal(decided.status, "done");
    const job = heartbeatJobs(root)[0];
    assert.ok(job.onceAt);
    assert.equal(job.channelId, channel.id);
    assert.equal(job.timezone, "America/New_York");
    // 8am tomorrow in the owner's zone, not 8am UTC.
    const back = localPartsIn("America/New_York", new Date(job.onceAt as string));
    assert.equal(back.hour, 8);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
