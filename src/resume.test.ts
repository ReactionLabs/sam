import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleSse } from "./openai-compatible.js";
import { ChatStore } from "./chats.js";
import { runChatTurn } from "./agent-turn.js";

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-resume-")); }
function useEnv(): NodeJS.ProcessEnv {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    PATH: "/usr/bin:/bin",
    SAM_MODEL_PROVIDER: "minimax",
    SAM_MODEL: "MiniMax-M2.5",
    MINIMAX_API_KEY: "test-key",
  });
  return saved;
}
function restore(saved: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
}

test("assembleSse joins content deltas and tool-call fragments, and ignores a trailing partial event", () => {
  const raw = [
    'data: {"choices":[{"delta":{"content":"Hello "}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"world"},"index":0}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
    "",
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"sam_list_skills","arguments":""}}]}}]}',
    "",
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}',
    "",
    "data: {not-json",
    "",
  ].join("\n");
  const assembled = assembleSse(raw);
  assert.equal(assembled.content, "Hello world");
  assert.equal(assembled.usage?.totalTokens, 5);
  assert.equal(assembled.toolCalls.length, 1);
  assert.equal(assembled.toolCalls[0].id, "call-1");
  assert.equal(assembled.toolCalls[0].function.name, "sam_list_skills");
  assert.equal(assembled.toolCalls[0].function.arguments, "{}");
});

test("a killed stream stays partial and a resume continues from that text", async () => {
  const root = scratch();
  const saved = useEnv();
  const oldFetch = globalThis.fetch;
  const bodies: string[] = [];
  try {
    let phase: "kill" | "resume" = "kill";
    globalThis.fetch = async (_input, init) => {
      bodies.push(String(init?.body));
      if (phase === "kill") {
        let n = 0;
        const chunks = ['data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n'];
        const stream = new ReadableStream({
          pull(controller) {
            if (n >= chunks.length) { controller.error(new Error("socket hang up")); return; }
            controller.enqueue(new TextEncoder().encode(chunks[n++]));
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "world." } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }), { headers: { "Content-Type": "application/json" } });
    };
    const db = new ChatStore(root);
    const chat = db.create("Resume");
    db.close();
    await assert.rejects(() => runChatTurn(root, chat.id, "say hello"), /socket hang up/);
    const mid = new ChatStore(root);
    const partial = mid.messages(chat.id);
    mid.close();
    assert.equal(partial.filter(m => m.role === "user").length, 1);
    const assistant = partial.find(m => m.role === "assistant");
    assert.ok(assistant);
    assert.equal(assistant?.content, "Hello");
    assert.equal(assistant?.partial, 1, "a killed reply is stored as partial, never as a finished answer");
    phase = "resume";
    const reply = await runChatTurn(root, chat.id, "say hello");
    assert.equal(reply, "Hello world.");
    const done = new ChatStore(root);
    const messages = done.messages(chat.id);
    done.close();
    assert.equal(messages.filter(m => m.role === "user").length, 1, "resume does not add a second user message");
    const finished = messages.filter(m => m.role === "assistant");
    assert.equal(finished.length, 1);
    assert.equal(finished[0].content, "Hello world.");
    assert.equal(finished[0].partial, 0);
    assert.match(bodies[bodies.length - 1], /incomplete reply/);
    assert.match(bodies[bodies.length - 1], /Hello/);
  } finally {
    globalThis.fetch = oldFetch;
    restore(saved);
    rmSync(root, { recursive: true, force: true });
  }
});
