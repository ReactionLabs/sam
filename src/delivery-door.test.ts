import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel, updateChannel } from "./channels.js";
import { saveBridgeState } from "./telegram.js";
import { addHeartbeatJob, deliverToChannel, runHeartbeat } from "./heartbeat.js";
import { pendingDeliveries, queueDelivery, readDeliveries } from "./delivery-outbox.js";
import { readActivity } from "./activity.js";

// The delivery door (gap found 2026-11-13): deliverToChannel used to
// no-op silently for a missing channel, a disabled channel, a
// telegram channel with zero bridged chats, and a webhook channel -
// and every caller then marked the outbox record DELIVERED, a false
// success record. Each undeliverable shape now throws a named
// refusal, so the failure rides the delivery-failed seam (ledgered,
// pending, settled failed at the cap) instead of settling delivered.

const noSend = async () => { throw new Error("send must not be called"); };
const noPost = async () => { throw new Error("post must not be called"); };

function scratch(fn: (root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "sam-delivery-door-"));
    try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };
}

test("an unknown channel id refuses by name instead of settling delivered", scratch(async (root) => {
  await assert.rejects(
    deliverToChannel(root, "no-such-channel", "owed news", noSend, noPost),
    /Delivery channel not found: no-such-channel/,
  );
}));

test("a disabled channel refuses naming the channel", scratch(async (root) => {
  const channel = addChannel(root, "discord", "announcements", "sam", "SAM_CHANNEL_DISCORD_TEST", []);
  updateChannel(root, channel.id, { enabled: false });
  await assert.rejects(
    deliverToChannel(root, channel.id, "owed news", noSend, noPost),
    /Delivery channel disabled: announcements/,
  );
}));

test("a telegram channel with no bridged chats refuses naming the empty audience", scratch(async (root) => {
  const channel = addChannel(root, "telegram", "Dip Telegram", "dip", "SAM_CHANNEL_TG_TEST", [111]);
  let sends = 0;
  await assert.rejects(
    deliverToChannel(root, channel.id, "owed news", async () => { sends++; }, noPost),
    /Telegram channel 'Dip Telegram' has no bridged chats/,
  );
  assert.equal(sends, 0);
}));

test("a webhook channel refuses as an undeliverable target", scratch(async (root) => {
  const channel = addChannel(root, "webhook", "trigger door", "sam", "SAM_CHANNEL_HOOK_TEST", []);
  await assert.rejects(
    deliverToChannel(root, channel.id, "owed news", noSend, noPost),
    /Channel 'trigger door' \(webhook\) cannot deliver messages/,
  );
}));

test("a telegram channel with bridged chats sends to every chat, suffix stripped", scratch(async (root) => {
  const channel = addChannel(root, "telegram", "Dip Telegram", "dip", "SAM_CHANNEL_TG_TEST", [111]);
  saveBridgeState(root, { offset: 0, chats: { "12345": "chat-a", "678:trading": "chat-b" } });
  const sent: Array<[number, string]> = [];
  await deliverToChannel(root, channel.id, "the news", async (chatId, text) => { sent.push([chatId, text]); }, noPost);
  assert.deepEqual(sent, [[12345, "the news"], [678, "the news"]]);
}));

test("a discord channel delegates to its poster", scratch(async (root) => {
  const channel = addChannel(root, "discord", "announcements", "sam", "SAM_CHANNEL_DISCORD_TEST", []);
  let posted = 0;
  await deliverToChannel(root, channel.id, "the news", noSend, async (ch, text) => {
    assert.equal(ch.id, channel.id);
    assert.equal(text, "the news");
    posted++;
    return 1;
  });
  assert.equal(posted, 1);
}));

test("a fresh delivery to a missing channel stays pending with a delivery-failed line", scratch(async (root) => {
  addHeartbeatJob(root, "stack watch", 30, "trading", "Check the stack", "gone-channel");
  const result = await runHeartbeat(root, {
    ensureChat: async () => "hb-chat",
    runTurn: async () => "Candidates total: 282,966",
    deliver: (channelId: string, text: string) => deliverToChannel(root, channelId, text, noSend, noPost),
  } as never);
  assert.deepEqual(result.changed, ["stack watch"]);
  // Not delivered, not recovered: pending at attempt 1, reason on the record.
  const records = readDeliveries(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "pending");
  assert.equal(records[0].attempts, 1);
  assert.match(records[0].reason ?? "", /Delivery channel not found: gone-channel/);
  const activity = readActivity(root, 50, { kind: "delivery-failed" });
  assert.equal(activity.length, 1);
  assert.match(activity[0].summary, /attempt 1 of 5.*Delivery channel not found: gone-channel/);
}));

test("a pending delivery to a missing channel is retried by the recovery leg, never recovered", scratch(async (root) => {
  queueDelivery(root, { jobId: "j1", jobName: "stack watch", profile: "trading", channelId: "gone-channel", text: "owed news" });
  const deps = {
    ensureChat: async () => "hb-chat",
    runTurn: async () => "All quiet.",
    deliver: (channelId: string, text: string) => deliverToChannel(root, channelId, text, noSend, noPost),
  } as never;
  const first = await runHeartbeat(root, deps);
  assert.deepEqual(first.deliveries.delivered, []);
  assert.deepEqual(first.deliveries.recovered, []);
  assert.equal(first.deliveries.pending, 1);
  assert.equal(pendingDeliveries(root).length, 1);
  // Five failed attempts settle the record failed - the honest terminal
  // state the false-delivered bug used to skip straight past.
  for (let i = 0; i < 4; i++) await runHeartbeat(root, deps);
  assert.equal(readDeliveries(root)[0].status, "failed");
  assert.equal(readActivity(root, 50, { kind: "delivery-failed" }).length, 5);
}));
