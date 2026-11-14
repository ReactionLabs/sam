import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { runChatTurn } from "./agent-turn.js";
import {
  assembleTurnMessages,
  dedupeMessageIds,
  duplicateMessageIdCount,
  RESUME_PARTIAL_INSTRUCTION,
} from "./prompt-assembly.js";

test("dedupe by message id: first occurrence wins, id-less entries always pass", () => {
  const items = [
    { id: "a", content: "first a" },
    { id: "b", content: "b" },
    { id: "a", content: "second a" },
    { content: "no id 1" },
    { content: "no id 2" },
    { id: "b", content: "second b" },
  ];
  assert.deepEqual(dedupeMessageIds(items).map(i => i.content), ["first a", "b", "no id 1", "no id 2"]);
  assert.equal(duplicateMessageIdCount(items), 2);
  assert.equal(duplicateMessageIdCount([{ id: "x" }, { id: "y" }, {}]), 0);
});

test("assemble: the current message already in history is not appended again (history copy wins)", () => {
  const kept = [
    { id: "m1", role: "user" as const, content: "earlier", source: "telegram" },
    { id: "m2", role: "assistant" as const, content: "answer" },
    { id: "m3", role: "user" as const, content: "are u there?", source: "telegram" },
  ];
  const out = assembleTurnMessages({ kept, currentId: "m3", currentContent: "are u there?", currentSource: "telegram", resuming: false });
  assert.equal(out.length, 3);
  assert.equal(out.filter(m => m.content.includes("are u there?")).length, 1);
  assert.equal(out[2].content, "[metadata source=telegram]\nare u there?");
});

test("assemble: a current message missing from the kept tail is appended exactly once", () => {
  const kept = [{ id: "m1", role: "user" as const, content: "earlier", source: "dashboard" }];
  const out = assembleTurnMessages({ kept, currentId: "m9", currentContent: "fresh words", currentSource: "dashboard", resuming: false });
  assert.equal(out.length, 2);
  assert.equal(out.filter(m => m.content.includes("fresh words")).length, 1);
  assert.equal(out[1].content, "[metadata source=dashboard]\nfresh words");
});

test("assemble: duplicate ids inside the kept tail collapse to the first copy", () => {
  const kept = [
    { id: "m1", role: "user" as const, content: "same words", source: "telegram" },
    { id: "m1", role: "user" as const, content: "same words", source: "telegram" },
  ];
  const out = assembleTurnMessages({ kept, currentId: "m1", currentContent: "same words", currentSource: "telegram", resuming: false });
  assert.equal(out.length, 1);
});

test("assemble: resuming appends the continuation instruction, never a second copy of the ask", () => {
  const kept = [
    { id: "m1", role: "user" as const, content: "the ask", source: "api" },
    { id: "m2", role: "assistant" as const, content: "partial reply" },
  ];
  const out = assembleTurnMessages({ kept, currentId: "m1", currentContent: "the ask", currentSource: "api", resuming: true });
  assert.equal(out.filter(m => m.content.includes("the ask")).length, 1);
  assert.equal(out[out.length - 1].content, RESUME_PARTIAL_INSTRUCTION);
});

test("a live turn sends the owner's message to the model exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-prompt-assembly-"));
  const saved = { ...process.env };
  const oldFetch = globalThis.fetch;
  const bodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
  try {
    process.env.SAM_MODEL_PROVIDER = "minimax";
    process.env.SAM_MODEL = "MiniMax-M2.5";
    process.env.MINIMAX_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      if (init && typeof init.body === "string") {
        try { bodies.push(JSON.parse(init.body) as { messages?: Array<{ role: string; content: string }> }); } catch { /* not a model body */ }
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Answer." } }] }), { headers: { "Content-Type": "application/json" } });
    };
    const db = new ChatStore(root);
    const chatId = db.create("Dedupe").id;
    db.add(chatId, "user", "earlier from telegram", "telegram");
    db.add(chatId, "assistant", "ack");
    db.close();
    const reply = await runChatTurn(root, chatId, "are u there?", { source: "telegram" });
    assert.equal(reply, "Answer.");
    assert.ok(bodies.length >= 1, "the model was called");
    const prompt = bodies[0].messages ?? [];
    assert.equal(prompt.filter(m => m.content.includes("are u there?")).length, 1, "the current message appears once in the prompt");
    assert.equal(prompt.filter(m => m.content === "[metadata source=telegram]\nare u there?").length, 1);
    assert.equal(prompt.filter(m => m.content.includes("earlier from telegram")).length, 1, "history appears once too");
    // The store itself still holds each message exactly once.
    const check = new ChatStore(root);
    try {
      const msgs = check.messages(chatId);
      assert.equal(msgs.filter(m => m.content === "are u there?").length, 1);
    } finally { check.close(); }
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});
