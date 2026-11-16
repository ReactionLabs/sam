import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageFailedSummary, enqueueChatMessage, listChatQueue, awaitChatQueue } from "./chat-queue.js";
import { ChatStore } from "./chats.js";

// Queued message failures carry their reason (gap found
// 2026-11-16, hourly run 11:04 EST): the drain catch bound no
// error at all, so every live message-failed line read as the
// bare accounting sentence and named nothing. The summary now
// composes its reason through errorReason (the 04:04 bridge
// seam): causeless errors keep their plain message, a
// transport wrapper names its cause, and no bot token leaks.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-msgcause-"));
}

function ledger(root: string): Array<{ actor: string; kind: string; summary: string }> {
  const file = join(root, ".sam", "activity.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(raw => JSON.parse(raw) as { actor: string; kind: string; summary: string });
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.minimax.io"), { code: "ENOTFOUND" }),
});

test("a message failure summary names the transport cause behind the wrapper", () => {
  assert.equal(
    messageFailedSummary("12345678-abcd", 2, dnsErr()),
    "A queued turn in chat 12345678 failed: fetch failed: getaddrinfo ENOTFOUND api.minimax.io; its 2 message(s) are marked failed in the queue, not lost",
  );
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  assert.equal(
    messageFailedSummary("12345678-abcd", 1, err),
    "A queued turn in chat 12345678 failed: fetch failed: read (ECONNRESET); its 1 message(s) are marked failed in the queue, not lost",
  );
});

test("causeless errors and plain strings keep their plain message in the accounting sentence", () => {
  assert.equal(
    messageFailedSummary("12345678-abcd", 1, new Error("Model not configured")),
    "A queued turn in chat 12345678 failed: Model not configured; its 1 message(s) are marked failed in the queue, not lost",
  );
  assert.equal(
    messageFailedSummary("12345678-abcd", 3, "plain string failure"),
    "A queued turn in chat 12345678 failed: plain string failure; its 3 message(s) are marked failed in the queue, not lost",
  );
});

test("no bot token leaks through a message failure summary", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const summary = messageFailedSummary("12345678-abcd", 1, err);
  assert.equal(summary.includes("AAE-secret_token"), false);
  assert.equal(summary.includes("987654"), false);
  assert.match(summary, /bot<redacted>/);
});

test("a long reason caps the composed summary at 200", () => {
  const summary = messageFailedSummary("12345678-abcd", 1, new Error("x".repeat(400)));
  assert.equal(summary.length, 200);
});

test("a drained turn that cannot run ledgers exactly one message-failed line carrying its reason, and no message content", async () => {
  const root = scratch();
  try {
    const store = new ChatStore(root);
    const chat = store.create("Queue cause chat", null);
    store.close();
    const item = enqueueChatMessage(root, { chatId: chat.id, content: "the owner's secret wording", source: "dashboard" });
    assert.equal(item.status, "queued");
    await awaitChatQueue(root, chat.id, 15000);
    const settled = listChatQueue(root, chat.id).find(i => i.id === item.id);
    assert.equal(settled?.status, "failed");
    const lines = ledger(root).filter(l => l.kind === "message-failed");
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /failed: Model not configured; its 1 message\(s\) are marked failed in the queue, not lost/);
    assert.equal(lines[0].summary.includes("secret wording"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
