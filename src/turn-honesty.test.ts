import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatibleProvider, stripModelMarkup } from "./openai-compatible.js";
import { ownToolsChat } from "./own-tools.js";

// Owner defect 2026-11-10 (the stack watch chat): a turn that ran out
// of ROUNDS with 1 of 6 calls used told the owner "I reached the tool
// budget", and the follow-up turn died on a raw "Unsafe model output"
// when the model leaked its tool markup twice in a row. These tests
// pin the two fixes: leaks are stripped (the prose is the answer), and
// a turn's ending is named for what actually ended it.

test("stripModelMarkup keeps the prose and drops the machinery", () => {
  assert.equal(stripModelMarkup("Renamed it. <tool_call>{\"name\":\"x\"}</tool_call>"), "Renamed it.");
  assert.equal(stripModelMarkup("First part <invoke name=\"y\">args</invoke> second part"), "First part  second part");
  assert.equal(stripModelMarkup("Answer.<tool_call>{\"unclosed\":true"), "Answer.");
  assert.equal(stripModelMarkup("<think>hidden</think>Visible."), "Visible.");
  assert.equal(stripModelMarkup("Text </think> more"), "Text  more");
  assert.equal(stripModelMarkup("<tool_call>only machinery</tool_call>"), "");
  assert.equal(stripModelMarkup("[>"), "", "bracket debris is machinery remains, not an answer");
  assert.equal(stripModelMarkup("\u2764\uFE0F"), "\u2764\uFE0F", "an emoji-only reply is a real reply");
});

async function withServer(handler: (hit: number, res: import("node:http").ServerResponse) => void, run: (provider: OpenAICompatibleProvider, hits: () => number) => Promise<void>): Promise<void> {
  let hits = 0;
  const server = createServer((_req, res) => { hits++; res.setHeader("Content-Type", "application/json"); handler(hits, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${addr.port}/v1/chat/completions`, "");
    await run(provider, () => hits);
  } finally { server.close(); await once(server, "close"); }
}

const reply = (content: string) => JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });

test("a markup leak around real prose returns the prose, not a dead turn", async () => {
  await withServer((_hit, res) => res.end(reply("Renamed the chat. <tool_call>{\"name\":\"sam_manage_chats\"}</tool_call>")), async (provider) => {
    const turn = await provider.completeConnectorTurn("mock", [{ role: "user", content: "rename it" }], []);
    assert.equal(turn.content, "Renamed the chat.");
    assert.equal(turn.calls.length, 0);
  });
});

test("leak-only completions retry through a streak of two, then answer", async () => {
  await withServer((hit, res) => res.end(reply(hit < 3 ? "<tool_call>junk</tool_call>" : "Recovered.")), async (provider, hits) => {
    const turn = await provider.completeConnectorTurn("mock", [{ role: "user", content: "hi" }], []);
    assert.equal(turn.content, "Recovered.");
    assert.equal(hits(), 3);
  });
});

test("leak-only completions still surface after the third attempt", async () => {
  await withServer((_hit, res) => res.end(reply("<tool_call>junk</tool_call>")), async (provider, hits) => {
    await assert.rejects(() => provider.completeConnectorTurn("mock", [{ role: "user", content: "hi" }], []), /Unsafe model output/);
    assert.equal(hits(), 3);
  });
});

test("a batched completion above the old 4-call cap parses whole (owner defect 2026-11-10)", async () => {
  const calls = (n: number) => Array.from({ length: n }, (_v, i) => ({ id: "c" + i, type: "function", function: { name: "sam_memory_list", arguments: "{}" } }));
  await withServer((_hit, res) => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: calls(6) } }] })), async (provider) => {
    const turn = await provider.completeConnectorTurn("mock", [{ role: "user", content: "archive the others" }], []);
    assert.equal(turn.calls.length, 6);
  });
  await withServer((_hit, res) => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: calls(13) } }] })), async (provider) => {
    await assert.rejects(() => provider.completeConnectorTurn("mock", [{ role: "user", content: "hi" }], []), /Too many tool calls/);
  });
});

test("a turn that runs out of steps says steps, not tool budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-steps-"));
  try {
    let round = 0;
    const fake = {
      completeConnectorTurn: async (_model: string, _messages: Array<Record<string, unknown>>, tools: Array<Record<string, unknown>>) => {
        round++;
        // Every step - including the tool-free synthesis (tools: []) -
        // asks for a tool, the exact M2.5 misbehavior from the defect.
        return { content: null, calls: [{ id: "c" + round, name: "sam_memory_list", args: {} }] };
      },
    } as unknown as OpenAICompatibleProvider;
    const answer = await ownToolsChat(root, "sam", fake, "test-model", [{ role: "user", content: "keep checking" }], undefined, undefined, { rounds: 2, maxCalls: 6 });
    assert.match(answer, /ran out of steps/);
    assert.doesNotMatch(answer, /tool budget/);
    const ledger = readFileSync(join(root, ".sam", "activity.jsonl"), "utf8");
    assert.match(ledger, /Turn step limit reached/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a poisoned long history gets one context-reset retry before any tool runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-ctxreset-"));
  try {
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let i = 0; i < 6; i++) { history.push({ role: "user", content: "old ask " + i }); history.push({ role: "assistant", content: "old answer " + i }); }
    let calls = 0; let secondCallLength = 0;
    const fake = {
      completeConnectorTurn: async (_model: string, messages: Array<Record<string, unknown>>, _tools: Array<Record<string, unknown>>) => {
        calls++;
        if (calls === 1) throw new Error("Unsafe model output");
        secondCallLength = messages.length;
        return { content: "Recovered on a trimmed context.", calls: [] };
      },
    } as unknown as OpenAICompatibleProvider;
    const answer = await ownToolsChat(root, "sam", fake, "test-model", history);
    assert.equal(answer, "Recovered on a trimmed context.");
    assert.equal(secondCallLength, 7, "system line plus the last six messages");
    assert.match(readFileSync(join(root, ".sam", "activity.jsonl"), "utf8"), /Context reset after 'Unsafe model output'/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("no context reset once a tool has executed - the error surfaces instead", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-ctxreset2-"));
  try {
    let calls = 0;
    const fake = {
      completeConnectorTurn: async (_model: string, _messages: Array<Record<string, unknown>>, _tools: Array<Record<string, unknown>>) => {
        calls++;
        if (calls === 1) return { content: null, calls: [{ id: "x1", name: "sam_memory_list", args: {} }] };
        throw new Error("Unsafe model output");
      },
    } as unknown as OpenAICompatibleProvider;
    await assert.rejects(() => ownToolsChat(root, "sam", fake, "test-model", [{ role: "user", content: "go" }]), /Unsafe model output/);
    const ledgerPath = join(root, ".sam", "activity.jsonl");
    assert.doesNotMatch(existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "", /Context reset/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
