import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import {
  chatQueueFailureSummary, isChatQueueLedgered,
} from "./chat-queue-failure.js";
import {
  chatTurnActive, drainChatQueue, enqueueChatMessage, listChatQueue,
  resetChatTurn, resumeChatQueues,
} from "./chat-queue.js";
import { bumpTurnGeneration, claimTokenFor, turnGeneration } from "./turn-control.js";
import { classifyDefect } from "./self-work.js";

// Chat queue store failure visibility (gap found 2026-11-15,
// hourly run 09:04): the chat queue store (.sam/chat-queue.db)
// landed with the burst-queue + stuck-turn work after the
// store census enumerated its stores, and every touch in BOTH
// modules that share the file (chat-queue.ts and
// turn-control.ts) opened it raw. Each touch now ledgers ONE
// chat-queue-failed line (writes at phase write, reads at
// phase read) through the shared chat-queue-failure seam and
// rethrows exactly, tagged; a touch already ledgered by an
// inner door gains no second line across either handle.
const MARKER = "zorblax quindle owner words";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-queue-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "chat-queue-failed" });
}

function plantDeadStore(root: string): void {
  mkdirSync(join(root, ".sam", "chat-queue.db"), { recursive: true });
}

test("chat-queue-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(chatQueueFailureSummary("read", "unable to open\n  database   file"), "Chat queue store read failed: unable to open database file");
  assert.equal(chatQueueFailureSummary("write", "disk gone"), "Chat queue store write failed: disk gone");
  assert.equal(chatQueueFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "chat-queue-failed", summary: chatQueueFailureSummary(phase, "boom") }),
      { key: "chat-queue-failed:" + phase, label: "chat queue store failures (" + phase + " step)" },
    );
  }
});

test("chat-queue-failed: dead reads ledger exactly one read line per touch across both handles, with no second line from nested doors", () => {
  const root = scratch();
  try {
    plantDeadStore(root);

    assert.throws(() => listChatQueue(root, "chat-a"), (e: unknown) => isChatQueueLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Chat queue store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "chat-queue-failed:read", label: "chat queue store failures (read step)" });

    // chatTurnActive rides claimRow: the inner door ledgers,
    // the outer touch gains no second line.
    assert.throws(() => chatTurnActive(root, "chat-a"), (e: unknown) => isChatQueueLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "one line for the chatTurnActive touch, none extra from claimRow inside it");

    // The turn-control handle on the same file ledgers through
    // the same seam.
    assert.throws(() => turnGeneration(root, "chat-a"), (e: unknown) => isChatQueueLedgered(e));
    assert.throws(() => claimTokenFor(root, "chat-a"), (e: unknown) => isChatQueueLedgered(e));
    assert.throws(() => resumeChatQueues(root), (e: unknown) => isChatQueueLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 5);
    assert.ok(lines.every(l => l.summary.startsWith("Chat queue store read failed: ")), "every dead read names the read phase");
    assert.ok(!JSON.stringify(lines).includes("zorblax"), "no queue record ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat-queue-failed: dead writes ledger exactly one write line per touch and never carry message content", () => {
  const root = scratch();
  try {
    plantDeadStore(root);

    assert.throws(
      () => enqueueChatMessage(root, { chatId: "chat-a", content: MARKER }),
      (e: unknown) => isChatQueueLedgered(e),
    );
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Chat queue store write failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "chat-queue-failed:write", label: "chat queue store failures (write step)" });

    assert.throws(() => bumpTurnGeneration(root, "chat-a"), (e: unknown) => isChatQueueLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2);
    assert.ok(lines[1].summary.startsWith("Chat queue store write failed: "), lines[1].summary);

    assert.ok(!JSON.stringify(lines).includes("zorblax"), "message content is the owner's words, never failure data");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat-queue-failed: a dead drain rejects tagged with exactly one write line", async () => {
  const root = scratch();
  try {
    plantDeadStore(root);
    await assert.rejects(drainChatQueue(root, "chat-drain"), (e: unknown) => isChatQueueLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Chat queue store write failed: "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat-queue-failed: reset on a dead store ledgers exactly one line across both modules", () => {
  const root = scratch();
  try {
    plantDeadStore(root);
    // resetChatTurn (chat-queue.ts, phase write) reads its
    // claim first through claimRow (phase read): the first
    // failing touch ledgers once and the outer touch adds none.
    assert.throws(() => resetChatTurn(root, "chat-a"), (e: unknown) => isChatQueueLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "one line total for the whole reset touch chain");
    assert.ok(lines[0].summary.startsWith("Chat queue store read failed: "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat-queue-failed: a fresh install reads as an empty queue with no line", () => {
  const root = scratch();
  try {
    assert.deepEqual(listChatQueue(root, "chat-a"), []);
    assert.equal(chatTurnActive(root, "chat-a"), false);
    assert.equal(turnGeneration(root, "chat-a"), 0);
    assert.equal(claimTokenFor(root, "chat-a"), null);
    assert.deepEqual(resumeChatQueues(root), []);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat-queue-failed: a healthy store exercises both modules with zero failure lines", () => {
  const root = scratch();
  try {
    assert.equal(bumpTurnGeneration(root, "chat-a"), 1);
    assert.equal(turnGeneration(root, "chat-a"), 1);
    assert.equal(claimTokenFor(root, "chat-a"), null);

    const nevermind = enqueueChatMessage(root, { chatId: "chat-a", content: "nevermind" });
    assert.equal(nevermind.effect, "nevermind");
    assert.equal(nevermind.status, "consumed");
    const stop = enqueueChatMessage(root, { chatId: "chat-a", content: "stop" });
    assert.equal(stop.effect, "stop");

    const items = listChatQueue(root, "chat-a");
    assert.equal(items.length, 2);
    assert.ok(items.every(i => i.status === "consumed" || i.status === "dropped"));
    assert.equal(chatTurnActive(root, "chat-a"), false);
    assert.deepEqual(resumeChatQueues(root), []);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
