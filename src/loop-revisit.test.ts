import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { listLoops, openLoop, updateOpenLoop, type OpenLoop } from "./loops.js";
import { loopDeliveryFailureSummary, parseRevisitReply, revisitDueLoops, revisitPrompt } from "./loop-revisit.js";
import { classifyDefect } from "./self-work.js";
import { runHeartbeat } from "./heartbeat.js";
import { addChannel } from "./channels.js";
import { saveBridgeState } from "./telegram.js";
import { readDeliveries } from "./delivery-outbox.js";
import { PreferenceStore } from "./preferences.js";
import { readActivity } from "./activity.js";

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-loop-revisit-")); }

function makeDue(root: string, id: string): void {
  // Through the store's own update door (the actions precedent):
  // tests never rewrite the store file around the store.
  const updated = updateOpenLoop(root, id, { dueAt: new Date(Date.now() - 60_000).toISOString() });
  if (!updated) throw new Error("makeDue: no such loop " + id);
}

function makeChat(root: string, title = "Main chat", profile?: string): string {
  const db = new ChatStore(root);
  try { return db.create(title, profile ?? null).id; } finally { db.close(); }
}

function messages(root: string, chatId: string) {
  const db = new ChatStore(root);
  try { return db.messages(chatId); } finally { db.close(); }
}

test("second answers: reply verdicts - markers first, P3 equivalence as the fallback", () => {
  assert.deepEqual(parseRevisitReply("UNCHANGED", "The stack is frozen at 282,966 candidates."), { verdict: "unchanged", text: "" });
  assert.deepEqual(parseRevisitReply("  unchanged.  ", "x"), { verdict: "unchanged", text: "" });
  assert.equal(parseRevisitReply("UPDATE: It moved to 300,000 candidates.", "x").verdict, "changed");
  assert.equal(parseRevisitReply("UPDATE: It moved to 300,000 candidates.", "x").text, "It moved to 300,000 candidates.");
  assert.equal(parseRevisitReply("RESOLVED: It restarted on 2026-11-10 and is advancing.", "x").verdict, "resolved");
  // Unmarked: the same facts rephrased are unchanged (fact-bag inclusion),
  // a changed value is an update, and an empty prior answer can never
  // read a real reply as unchanged.
  const prior = "Candidates total: 282,966. Newest candidate: 2026-11-04T22:45:59Z. Alert verdict count: 9. Paper setups entered: 20.";
  assert.equal(parseRevisitReply("The stack is still frozen: 282,966 candidates, newest 2026-11-04T22:45:59Z, 9 alerts, 20 entered.", prior).verdict, "unchanged");
  assert.equal(parseRevisitReply("The stack moved: 300,001 candidates now.", prior).verdict, "changed");
  assert.equal(parseRevisitReply("It restarted.", "").verdict, "changed");
  assert.equal(parseRevisitReply("", prior).verdict, "unchanged");
  assert.match(revisitPrompt({ question: "Q?", answer: "A.", watchFor: "W" } as OpenLoop), /RESOLVED:/);
});

test("second answers: unchanged stays silent in the owner's chat and reschedules", async () => {
  const root = scratch();
  try {
    const chatId = makeChat(root);
    const loop = openLoop(root, { profile: "sam", chatId, question: "Is the stack restarted?", answer: "Not yet.", watchFor: "newest candidate advancing", dueInHours: 2 });
    makeDue(root, loop.id);
    const before = messages(root, chatId).length;
    const r = await revisitDueLoops(root, { runTurn: async () => "UNCHANGED" });
    assert.deepEqual(r.checked, [loop.id]);
    assert.deepEqual(r.changed, []);
    assert.equal(messages(root, chatId).length, before);
    const after = listLoops(root)[0];
    assert.equal(after.status, "open");
    assert.equal(after.checks, 1);
    assert.ok(Date.parse(after.dueAt) > Date.now(), "the next look moved out by the loop interval");
    assert.equal(readActivity(root, 50).some(a => a.kind === "loop-updated"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("second answers: a changed answer posts into the original chat and becomes the recorded answer", async () => {
  const root = scratch();
  try {
    const chatId = makeChat(root);
    const loop = openLoop(root, { profile: "sam", chatId, question: "Is the stack restarted?", answer: "Not yet, frozen since Nov 4.", watchFor: "newest candidate advancing", dueInHours: 2 });
    makeDue(root, loop.id);
    const r = await revisitDueLoops(root, { runTurn: async () => "UPDATE: It restarted at 09:12 UTC; the newest candidate is 2026-11-10T09:12:00Z." });
    assert.deepEqual(r.changed, [loop.id]);
    const msgs = messages(root, chatId);
    const post = msgs[msgs.length - 1];
    assert.equal(post.role, "assistant");
    assert.match(post.content, /Update on your open loop/);
    assert.match(post.content, /It restarted at 09:12 UTC/);
    const after = listLoops(root)[0];
    assert.equal(after.status, "open");
    assert.match(after.answer, /It restarted at 09:12 UTC/);
    assert.equal(readActivity(root, 50).some(a => a.kind === "loop-updated"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("second answers: a resolved question posts its final answer and closes with the resolution", async () => {
  const root = scratch();
  try {
    const chatId = makeChat(root);
    const loop = openLoop(root, { profile: "sam", chatId, question: "Did the key land?", answer: "Not yet.", watchFor: "a key appearing in the vault", dueInHours: 2 });
    makeDue(root, loop.id);
    const r = await revisitDueLoops(root, { runTurn: async () => "RESOLVED: The key landed in the vault this morning." });
    assert.deepEqual(r.resolved, [loop.id]);
    const after = listLoops(root, { status: "closed" })[0];
    assert.equal(after.id, loop.id);
    assert.match(after.resolution ?? "", /key landed in the vault/);
    const msgs = messages(root, chatId);
    assert.match(msgs[msgs.length - 1].content, /now settled/);
    // A closed loop is never revisited again.
    const again = await revisitDueLoops(root, { runTurn: async () => { throw new Error("must not run"); } });
    assert.deepEqual(again.checked, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("second answers: a failed re-check reschedules and stays open; the per-tick cap holds", async () => {
  const root = scratch();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const loop = openLoop(root, { profile: "sam", question: "Question " + i + "?", answer: "Pending.", watchFor: "anything moving", dueInHours: 1 });
      makeDue(root, loop.id); ids.push(loop.id);
    }
    const r = await revisitDueLoops(root, { runTurn: async () => { throw new Error("model down"); } });
    assert.equal(r.checked.length, 3, "default cap is 3 per tick");
    assert.equal(r.failed.length, 3);
    const open = listLoops(root, { status: "open" });
    assert.equal(open.length, 5);
    assert.ok(open.filter(l => (l.checks ?? 0) === 1).length === 3);
    assert.equal(readActivity(root, 50).filter(a => a.kind === "loop-failed").length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("second answers: visitor chats and vanished chats close their loops without a turn", async () => {
  const root = scratch();
  try {
    const db = new ChatStore(root);
    const visitorChat = db.create("Visitor", null, { visitor: true });
    db.close();
    const a = openLoop(root, { profile: "sam", chatId: visitorChat.id, question: "Visitor loop?", answer: "x", watchFor: "y", dueInHours: 1 });
    const b = openLoop(root, { profile: "sam", chatId: "no-such-chat", question: "Orphan loop?", answer: "x", watchFor: "y", dueInHours: 1 });
    makeDue(root, a.id); makeDue(root, b.id);
    let turns = 0;
    const r = await revisitDueLoops(root, { runTurn: async () => { turns++; return "UPDATE: z"; } });
    assert.equal(turns, 0);
    assert.equal(r.checked.length, 2);
    const closed = listLoops(root, { status: "closed" });
    assert.equal(closed.length, 2);
    assert.match(closed.find(l => l.id === a.id)?.resolution ?? "", /visitor/);
    assert.match(closed.find(l => l.id === b.id)?.resolution ?? "", /no longer exists/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("second answers: a chatless loop adopts its check chat and posts the update there", async () => {
  const root = scratch();
  try {
    const loop = openLoop(root, { profile: "trading", question: "Did the verdict mix change?", answer: "ALERT 9 of 20.", watchFor: "ALERT count moving", dueInHours: 1 });
    makeDue(root, loop.id);
    const r = await revisitDueLoops(root, { runTurn: async () => "UPDATE: ALERT is now 11 of 20." });
    assert.deepEqual(r.changed, [loop.id]);
    const after = listLoops(root)[0];
    assert.ok(after.chatId, "the check chat was adopted as the loop's home");
    const msgs = messages(root, after.chatId as string);
    assert.ok(msgs.some(m => /ALERT is now 11/.test(m.content)), "the update landed in the adopted chat");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("second answers: the channel leg rides the outbox and the worthiness gate", async () => {
  const root = scratch();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "sam", "SAM_CHANNEL_TELEGRAM_TOKEN", [123]);
    const chatId = makeChat(root, "Telegram - sam");
    saveBridgeState(root, { offset: 0, chats: { "123": chatId } });
    // Worthy: no law against it - the update delivers through the outbox.
    const loop = openLoop(root, { profile: "sam", chatId, question: "Is the stack restarted?", answer: "Not yet.", watchFor: "candidates advancing", dueInHours: 1 });
    makeDue(root, loop.id);
    const sent: Array<{ channelId: string; text: string }> = [];
    const r = await revisitDueLoops(root, { runTurn: async () => "UPDATE: It restarted; candidates are advancing again.", deliver: async (channelId, text) => { sent.push({ channelId, text }); } });
    assert.deepEqual(r.changed, [loop.id]);
    assert.deepEqual(r.held, []);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channelId, channel.id);
    assert.equal(readDeliveries(root).filter(d => d.status === "delivered").length, 1);
    // Held: standing law denies the topic - the chat record still
    // lands, the channel push is suppressed on the outbox record.
    const prefs = new PreferenceStore(root);
    prefs.note("sam", "Never alert me about stack counts", "rule", "test");
    prefs.close();
    const loop2 = openLoop(root, { profile: "sam", chatId, question: "What are the stack counts?", answer: "Frozen.", watchFor: "stack counts moving", dueInHours: 1 });
    makeDue(root, loop2.id);
    const r2 = await revisitDueLoops(root, { runTurn: async () => "UPDATE: The stack counts moved: 300,001 candidates.", deliver: async (channelId, text) => { sent.push({ channelId, text }); } });
    assert.deepEqual(r2.held, [loop2.id]);
    assert.equal(sent.length, 1, "the held update never reached the channel");
    assert.equal(readDeliveries(root).filter(d => d.status === "suppressed").length, 1);
    const msgs = messages(root, chatId);
    assert.ok(msgs.some(m => /stack counts moved/.test(m.content)), "the chat record carries the held update");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("second answers: loopDeliveryFailureSummary names the attempt, and the terminal settle when capped", () => {
  const mid = loopDeliveryFailureSummary("channel down", 2, false);
  assert.match(mid, /Delivery for second answer failed \(attempt 2 of 5\): channel down/);
  assert.doesNotMatch(mid, /gave up/);
  const end = loopDeliveryFailureSummary("channel down", 5, true);
  assert.match(end, /attempt 5 of 5/);
  assert.match(end, /gave up after 5 attempts; the update will not be retried/);
  // Whitespace collapses and the line is capped, like its sibling seams.
  const messy = loopDeliveryFailureSummary("a\n\n  b\t c " + "x".repeat(400), 1, false);
  assert.ok(messy.length <= 200);
  assert.doesNotMatch(messy, /\n/);
});

test("second answers: a failed channel delivery ledgers one delivery-failed line and stays pending", async () => {
  const root = scratch();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "sam", "SAM_CHANNEL_TELEGRAM_TOKEN", [123]);
    const chatId = makeChat(root, "Telegram - sam");
    saveBridgeState(root, { offset: 0, chats: { "123": chatId } });
    const loop = openLoop(root, { profile: "sam", chatId, question: "Is the stack restarted?", answer: "Not yet.", watchFor: "candidates advancing", dueInHours: 1 });
    makeDue(root, loop.id);
    const r = await revisitDueLoops(root, { runTurn: async () => "UPDATE: It restarted; candidates are advancing again.", deliver: async () => { throw new Error("channel down"); } });
    assert.deepEqual(r.changed, [loop.id], "the loop's own state still advances - the chat record carries the update");
    const msgs = messages(root, chatId);
    assert.ok(msgs.some(m => /It restarted/.test(m.content)), "the update landed in the chat record despite the failed push");
    const deliveries = readDeliveries(root);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].status, "pending");
    assert.equal(deliveries[0].attempts, 1);
    assert.equal(deliveries[0].reason, "channel down");
    const failures = readActivity(root, 50).filter(a => a.kind === "delivery-failed");
    assert.equal(failures.length, 1, "exactly one delivery-failed activity line for the failed attempt");
    assert.equal(failures[0].actor, "sam");
    assert.match(failures[0].summary, /Delivery for second answer failed \(attempt 1 of 5\): channel down/);
    assert.equal(failures[0].summary.includes("It restarted"), false, "the delivery text never enters the failure line");
    assert.deepEqual(classifyDefect(failures[0]), { key: "delivery-failed", label: "heartbeat delivery failures" }, "self-work counts the line with the delivery-failed class");
    assert.equal(channel.id.length > 0, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("second answers: a delivered channel update writes no delivery-failed line", async () => {
  const root = scratch();
  try {
    addChannel(root, "telegram", "Dip Telegram", "sam", "SAM_CHANNEL_TELEGRAM_TOKEN", [123]);
    const chatId = makeChat(root, "Telegram - sam");
    saveBridgeState(root, { offset: 0, chats: { "123": chatId } });
    const loop = openLoop(root, { profile: "sam", chatId, question: "Is the stack restarted?", answer: "Not yet.", watchFor: "candidates advancing", dueInHours: 1 });
    makeDue(root, loop.id);
    await revisitDueLoops(root, { runTurn: async () => "UPDATE: It restarted.", deliver: async () => {} });
    assert.equal(readActivity(root, 50).filter(a => a.kind === "delivery-failed").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("second answers: the heartbeat tick revisits due loops and reports them", async () => {
  const root = scratch();
  try {
    const chatId = makeChat(root);
    const loop = openLoop(root, { profile: "sam", chatId, question: "Is the stack restarted?", answer: "Not yet.", watchFor: "candidates advancing", dueInHours: 1 });
    makeDue(root, loop.id);
    const deps = {
      ensureChat: async (title: string, profile: string) => makeChat(root, title, profile === "sam" ? undefined : profile),
      runTurn: async () => "UNCHANGED",
    };
    const r = await runHeartbeat(root, deps);
    assert.deepEqual(r.loops.checked, [loop.id]);
    assert.deepEqual(r.loops.changed, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
