import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChatTurn, TURN_FAILURE_MESSAGE } from "./agent-turn.js";
import { PROVIDER_OVERLOAD_MESSAGE } from "./provider-retry.js";
import {
  awaitChatQueue,
  enqueueChatMessage,
  listChatQueue,
  mergeQueueIntoMessages,
  resendFailedMessage,
  type QueueItem,
} from "./chat-queue.js";
import { ChatStore } from "./chats.js";
import { listArtifacts } from "./artifacts.js";
import { assembleTurnMessages, RESEND_INSTRUCTION } from "./prompt-assembly.js";
import { MALFORMED_COMPLETION_ATTEMPTS, TOOL_CALL_ARGUMENTS_MAX_CHARS } from "./openai-compatible.js";
import { createTurnControl } from "./turn-control.js";

// Chat trust sprint (Dip live defects, 2026-11-15 ~17:56 EST):
// one send rendered as two bubbles, and two sends that failed
// silently. The pins: a queue item decorates its own message
// row instead of rendering as a second bubble; a malformed
// model completion is a fresh-attempt class, not a dead turn,
// and a legitimate large tool call (an artifact page) passes
// the validator its own contract promises; a failed owner turn
// always leaves one plain sentence in the chat; and a failed
// message resends as itself - same row, same bubble - and can
// then succeed.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-chat-trust-"));
}

function ledger(root: string): Array<{ actor: string; kind: string; summary: string }> {
  const file = join(root, ".sam", "activity.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(raw => JSON.parse(raw) as { actor: string; kind: string; summary: string });
}

function installEnv(): () => void {
  const saved = { ...process.env };
  process.env.SAM_MODEL_PROVIDER = "minimax";
  process.env.SAM_MODEL = "MiniMax-M2.5";
  process.env.MINIMAX_API_KEY = "test-key";
  return () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  };
}

function jsonResponse(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", ...message } }] }), {
    headers: { "Content-Type": "application/json" },
  });
}

function item(partial: Partial<QueueItem> & { id: string }): QueueItem {
  return {
    chatId: "chat-1", content: "hello", source: "dashboard", status: "failed",
    createdAt: "2026-11-15T22:54:25.000Z", settledAt: null, messageId: null, ...partial,
  };
}
function msg(partial: Record<string, unknown> & { id: string }): { id: string; role: string; content: string; source?: unknown; created_at: string } {
  return { role: "user", content: "hello", source: "dashboard", created_at: "2026-11-15T22:54:25.100Z", ...partial };
}

test("merge: a stamped failed item decorates its own message and leaves the queue list", () => {
  const messages = [msg({ id: "m1" }), msg({ id: "m2", role: "assistant", content: "note", source: "unknown" })];
  const merged = mergeQueueIntoMessages(messages, [item({ id: "q1", messageId: "m1" })]);
  assert.equal(merged.messages[0].queueStatus, "failed");
  assert.equal(merged.messages[0].queueId, "q1", "the bubble carries the queue id its Resend control needs");
  assert.equal(merged.messages[1].queueStatus, undefined);
  assert.deepEqual(merged.queue, [], "the send renders once - as its message, never also as a queue row");
});

test("merge: legacy items match by content, source, and order - identical sends each land on their own bubble", () => {
  const messages = [
    msg({ id: "m1", created_at: "2026-11-15T22:54:25.100Z" }),
    msg({ id: "m2", created_at: "2026-11-15T22:55:11.100Z" }),
  ];
  const merged = mergeQueueIntoMessages(messages, [
    item({ id: "q1", createdAt: "2026-11-15T22:54:25.000Z" }),
    item({ id: "q2", createdAt: "2026-11-15T22:55:11.000Z" }),
  ]);
  assert.equal(merged.messages[0].queueId, "q1");
  assert.equal(merged.messages[1].queueId, "q2", "consumption order: the second identical send decorates the second bubble, not the first twice");
  assert.deepEqual(merged.queue, []);
});

test("merge: a resent item waiting on its row decorates it as queued; row-less states stay standalone", () => {
  const messages = [msg({ id: "m1" })];
  const resent = mergeQueueIntoMessages(messages, [item({ id: "q1", status: "queued", messageId: "m1" })]);
  assert.equal(resent.messages[0].queueStatus, "queued", "during the re-drive the one bubble shows the send as pending again");
  assert.deepEqual(resent.queue, []);
  const settled = mergeQueueIntoMessages(messages, [item({ id: "q2", status: "folded", messageId: "m1" })]);
  assert.equal(settled.messages[0].queueStatus, undefined, "a folded send is just a message again");
  assert.deepEqual(settled.queue, [], "and never renders as a queue row either");
  const orphan = mergeQueueIntoMessages(messages, [item({ id: "q3", status: "cancelled" }), item({ id: "q4", status: "dropped" })]);
  assert.deepEqual(orphan.queue.map(q => q.id), ["q3", "q4"], "cancelled and dropped sends have no transcript row - they render as themselves, once");
  assert.equal(orphan.messages[0].queueStatus, undefined);
});

test("assembly: a resent message is deduped to its history row and the nudge makes the ask live", () => {
  const kept = [
    { id: "m1", role: "user" as const, content: "Can u make an artifact?", source: "dashboard" },
    { id: "m2", role: "assistant" as const, content: TURN_FAILURE_MESSAGE },
  ];
  const assembled = assembleTurnMessages({ kept, currentId: "m1", currentContent: "Can u make an artifact?", currentSource: "dashboard", resuming: false, resent: true });
  assert.equal(assembled.filter(m => m.content.includes("Can u make an artifact?")).length, 1, "the resent words enter the prompt exactly once");
  assert.equal(assembled[assembled.length - 1].content, RESEND_INSTRUCTION, "the last word is the nudge, not the failure note");
  const fresh = assembleTurnMessages({ kept, currentId: "m1", currentContent: "Can u make an artifact?", currentSource: "dashboard", resuming: false });
  assert.ok(!fresh.some(m => m.content === RESEND_INSTRUCTION), "a first attempt never sees the nudge");
});

test("a malformed completion redraws inside the turn - two bad draws, then the answer", async () => {
  const root = scratch();
  const restoreEnv = installEnv();
  const oldFetch = globalThis.fetch;
  try {
    const store = new ChatStore(root);
    const chat = store.create("Malformed draws");
    store.close();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls <= 2) {
        return jsonResponse({
          content: null,
          tool_calls: [{ id: "c" + calls, type: "function", function: { name: "sam_artifact", arguments: "[1,2,3]" } }],
        });
      }
      return jsonResponse({ content: "Drawn clean this time." });
    };
    const reply = await runChatTurn(root, chat.id, "make me something");
    assert.equal(reply, "Drawn clean this time.");
    assert.equal(calls, 3, "two malformed draws and one clean - no more, no fewer");
    const lines = ledger(root);
    assert.equal(lines.filter(l => l.kind === "malformed-completion").length, 2, "each rejection ledgered with its check");
    assert.match(lines.find(l => l.kind === "malformed-completion")!.summary, /not a JSON object/, "the ledger names which check failed");
    assert.equal(lines.filter(l => l.kind === "turn-failed").length, 0, "a recovered turn is not a failed turn");
    const peek = new ChatStore(root);
    const messages = peek.messages(chat.id);
    peek.close();
    assert.deepEqual(messages.filter(m => m.role === "assistant").map(m => m.content), ["Drawn clean this time."], "exactly one saved answer");
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a full-size artifact call passes the validator its contract promises", async () => {
  const root = scratch();
  const restoreEnv = installEnv();
  const oldFetch = globalThis.fetch;
  try {
    const store = new ChatStore(root);
    const chat = store.create("Calculator ask");
    store.close();
    const page = "<!doctype html><title>Calculator</title><p>" + "x".repeat(6000) + "</p>";
    const args = JSON.stringify({ action: "create", title: "Calculator", kind: "html", content: page });
    assert.ok(args.length > 4000, "the call is over the old cap - the shape that killed the owner's turns");
    assert.ok(args.length < TOOL_CALL_ARGUMENTS_MAX_CHARS);
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        // sam_artifact rides the deferred tier: the model loads
        // it first, the way the real flow goes.
        return jsonResponse({
          content: null,
          tool_calls: [{ id: "call-0", type: "function", function: { name: "sam_load_tools", arguments: JSON.stringify({ names: ["sam_artifact"] }) } }],
        });
      }
      if (calls === 2) {
        return jsonResponse({
          content: null,
          tool_calls: [{ id: "call-1", type: "function", function: { name: "sam_artifact", arguments: args } }],
        });
      }
      return jsonResponse({ content: "Made your calculator." });
    };
    const reply = await runChatTurn(root, chat.id, "Go ahead and try to make something like a calculator");
    assert.equal(reply, "Made your calculator.");
    assert.equal(listArtifacts(root, "sam").filter(a => a.title === "Calculator").length, 1, "the artifact the owner asked for actually exists");
    const lines = ledger(root);
    assert.equal(lines.filter(l => l.kind === "malformed-completion").length, 0);
    assert.equal(lines.filter(l => l.kind === "turn-failed").length, 0);
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a persistently malformed completion fails the turn - with the plain note in the chat, never silence", async () => {
  const root = scratch();
  const restoreEnv = installEnv();
  const oldFetch = globalThis.fetch;
  try {
    const store = new ChatStore(root);
    const chat = store.create("Always malformed");
    store.close();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return jsonResponse({
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "sam_artifact", arguments: "[1,2,3]" } }],
      });
    };
    await assert.rejects(() => runChatTurn(root, chat.id, "make me something"), /Invalid tool arguments/, "the failure still surfaces for the queue's failed marking");
    assert.equal(calls, MALFORMED_COMPLETION_ATTEMPTS, "the bounded redraw budget, then it gives up");
    const peek = new ChatStore(root);
    const messages = peek.messages(chat.id);
    peek.close();
    assert.deepEqual(messages.filter(m => m.role === "user").map(m => m.content), ["make me something"], "the owner's message is saved");
    assert.deepEqual(messages.filter(m => m.role === "assistant").map(m => m.content), [TURN_FAILURE_MESSAGE], "exactly one assistant row - the plain failure note");
    assert.ok(!messages.some(m => m.content === PROVIDER_OVERLOAD_MESSAGE), "a malformed completion is not dressed as a provider overload");
    const lines = ledger(root);
    assert.equal(lines.filter(l => l.kind === "malformed-completion").length, MALFORMED_COMPLETION_ATTEMPTS);
    assert.equal(lines.filter(l => l.kind === "turn-failure-note").length, 1);
    assert.equal(lines.filter(l => l.kind === "turn-failed").length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a turn the deadline catches keeps the deadline's own words, not the failure note", async () => {
  const root = scratch();
  const restoreEnv = installEnv();
  const oldFetch = globalThis.fetch;
  try {
    const store = new ChatStore(root);
    const chat = store.create("Deadline words");
    store.close();
    globalThis.fetch = async () => {
      await new Promise(r => setTimeout(r, 25));
      return new Response("bad request", { status: 400 });
    };
    const control = createTurnControl(root, chat.id, { deadlineMs: 1 });
    const reply = await runChatTurn(root, chat.id, "a slow ask", { control }).catch(() => "");
    const peek = new ChatStore(root);
    const messages = peek.messages(chat.id);
    peek.close();
    const assistantTexts = messages.filter(m => m.role === "assistant").map(m => m.content);
    assert.ok(!assistantTexts.includes(TURN_FAILURE_MESSAGE), "the general note never overrides the deadline close");
    assert.ok(reply.includes("time limit") || assistantTexts.some(t => t.includes("time limit")), "the close the owner reads is the deadline's");
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resend: a failed send re-drives as itself - one bubble, one row, then the answer lands", async () => {
  const root = scratch();
  const restoreEnv = installEnv();
  const oldFetch = globalThis.fetch;
  try {
    const store = new ChatStore(root);
    const chat = store.create("Resend me");
    store.close();
    let healthy = false;
    globalThis.fetch = async () => healthy
      ? jsonResponse({ content: "Here is the answer you asked for." })
      : new Response("bad request", { status: 400 });
    const queued = enqueueChatMessage(root, { chatId: chat.id, content: "Can u make an artifact?", source: "dashboard" });
    await awaitChatQueue(root, chat.id, 60_000);
    let queue = listChatQueue(root, chat.id);
    const failed = queue.find(i => i.id === queued.id)!;
    assert.equal(failed.status, "failed");
    assert.ok(failed.messageId, "the failed item is stamped with the row its turn saved");
    let peek = new ChatStore(root);
    let messages = peek.messages(chat.id);
    peek.close();
    assert.deepEqual(messages.filter(m => m.role === "user").map(m => m.content), ["Can u make an artifact?"]);
    assert.deepEqual(messages.filter(m => m.role === "assistant").map(m => m.content), [TURN_FAILURE_MESSAGE], "the failure was never silent");
    const merged = mergeQueueIntoMessages(messages, queue);
    assert.equal(merged.messages.find(m => m.role === "user")!.queueStatus, "failed", "the payload decorates the send's own bubble");
    assert.equal(merged.messages.find(m => m.role === "user")!.queueId, queued.id);
    assert.ok(!merged.queue.some(q => q.id === queued.id), "and the send no longer rides the queue list - one bubble, not two");
    // Only a failed item resends.
    assert.throws(() => resendFailedMessage(root, chat.id, "00000000-0000-0000-0000-000000000000"), /not found/);
    healthy = true;
    const resent = resendFailedMessage(root, chat.id, queued.id);
    assert.equal(resent.status, "queued");
    assert.equal(resent.messageId, failed.messageId, "the resend keeps the original row's link");
    await awaitChatQueue(root, chat.id, 60_000);
    queue = listChatQueue(root, chat.id);
    assert.equal(queue.find(i => i.id === queued.id)!.status, "folded", "the resent send settled into a completed turn");
    peek = new ChatStore(root);
    messages = peek.messages(chat.id);
    peek.close();
    assert.deepEqual(messages.filter(m => m.role === "user").map(m => m.content), ["Can u make an artifact?"], "still exactly one copy of the owner's words");
    assert.deepEqual(
      messages.filter(m => m.role === "assistant").map(m => m.content),
      [TURN_FAILURE_MESSAGE, "Here is the answer you asked for."],
      "the answer lands in the same chat, under the same bubble",
    );
    assert.throws(() => resendFailedMessage(root, chat.id, queued.id), /Only a failed/, "a settled send cannot be resent");
    const lines = ledger(root);
    assert.equal(lines.filter(l => l.kind === "message-resent").length, 1);
    assert.equal(lines.filter(l => l.kind === "message-failed").length, 1, "only the first attempt failed");
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});
