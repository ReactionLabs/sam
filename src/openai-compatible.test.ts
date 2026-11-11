import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { converse } from "./model-conversation.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

test("opt-in model transport sends messages and validates response on loopback", async () => {
  let observed: unknown;
  const server = createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    let raw = "";
    for await (const chunk of req) raw += chunk.toString();
    observed = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hello from mock model" } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${addr.port}/v1/chat/completions`, "");
    const reply = await converse(provider, { model: "mock", messages: [{ role: "user", content: "hi" }] });
    assert.equal(reply.message.content, "Hello from mock model");
    assert.deepEqual(observed, { model: "mock", messages: [{ role: "user", content: "hi" }], stream: false });
  } finally { server.close(); await once(server, "close"); }
});

test("provider retries an empty completion once, then surfaces it (owner defect 2026-11-10)", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.setHeader("Content-Type", "application/json");
    // First attempt: a completion with neither content nor tool
    // calls (the reasoning model spent its reply out of sight).
    // Second attempt answers normally.
    if (hits === 1) res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }));
    else res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Recovered answer" } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${addr.port}/v1/chat/completions`, "");
    const turn = await provider.completeConnectorTurn("mock", [{ role: "user", content: "hi" }], []);
    assert.equal(turn.content, "Recovered answer");
    assert.equal(hits, 2);
  } finally { server.close(); await once(server, "close"); }
});

test("provider gives up after three empty completions", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${addr.port}/v1/chat/completions`, "");
    await assert.rejects(provider.completeConnectorTurn("mock", [{ role: "user", content: "hi" }], []), /Empty model response/);
    assert.equal(hits, 3);
  } finally { server.close(); await once(server, "close"); }
});

test("provider strips a markup leak and keeps the prose (owner defect 2026-11-10)", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.setHeader("Content-Type", "application/json");
    // MiniMax leaked tool markup into the visible content around
    // real prose. The leak is machinery, not an answer failure: the
    // prose is the answer, stripped and returned on the first hit.
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Working on it <tool_call>{\"name\":\"x\"}</tool_call>" } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${addr.port}/v1/chat/completions`, "");
    const turn = await provider.completeConnectorTurn("mock", [{ role: "user", content: "hi" }], []);
    assert.equal(turn.content, "Working on it");
    assert.equal(hits, 1);
  } finally { server.close(); await once(server, "close"); }
});

test("provider gives up after three leak-only completions", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "<tool_call>x</tool_call>" } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${addr.port}/v1/chat/completions`, "");
    await assert.rejects(provider.completeConnectorTurn("mock", [{ role: "user", content: "hi" }], []), /Unsafe model output/);
    assert.equal(hits, 3);
  } finally { server.close(); await once(server, "close"); }
});

test("model transport rejects insecure remote endpoints and missing credentials", async () => {
  assert.throws(() => new OpenAICompatibleProvider("http://example.com/v1/chat/completions", "key"));
  assert.throws(() => new OpenAICompatibleProvider("https://user:secret@example.com/v1/chat/completions", "key"));
  assert.throws(() => new OpenAICompatibleProvider("https://example.com/v1/chat/completions?token=secret", "key"));
  const provider = new OpenAICompatibleProvider("https://example.com/v1/chat/completions", "");
  await assert.rejects(converse(provider, { model: "x", messages: [{ role: "user", content: "hi" }] }), /requires an API key/);
});

test("provider reports token usage from complete and connector turns (P11)", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: " counted " } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${addr.port}/v1/chat/completions`, "");
    const seen: Array<{ promptTokens: number; completionTokens: number; totalTokens: number; model: string }> = [];
    provider.onUsage = (usage, model) => { seen.push({ ...usage, model }); };
    await converse(provider, { model: "mock", messages: [{ role: "user", content: "hi" }] });
    const turn = await provider.completeConnectorTurn("mock", [{ role: "user", content: "hi" }], []);
    assert.equal(turn.content, "counted");
    assert.deepEqual(seen, [
      { promptTokens: 11, completionTokens: 7, totalTokens: 18, model: "mock" },
      { promptTokens: 11, completionTokens: 7, totalTokens: 18, model: "mock" },
    ]);
  } finally { server.close(); await once(server, "close"); }
});

test("streamed connector turns request and report usage (F2 regression)", async () => {
  // A real provider sends a usage event in an SSE stream ONLY when the
  // request sets stream_options.include_usage. The fake behaves the
  // same, so this test fails if the request ever drops the option.
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw) as { stream?: boolean; stream_options?: { include_usage?: boolean } };
      res.setHeader("Content-Type", "text/event-stream");
      const events = [
        "data: " + JSON.stringify({ choices: [{ delta: { content: "streamed " } }] }),
        "data: " + JSON.stringify({ choices: [{ delta: { content: "answer" } }] }),
      ];
      if (body.stream_options?.include_usage === true)
        events.push("data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: 13, completion_tokens: 4, total_tokens: 17 } }));
      events.push("data: [DONE]");
      res.end(events.join("\n\n") + "\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${addr.port}/v1/chat/completions`, "");
    const seen: Array<{ promptTokens: number; completionTokens: number; totalTokens: number; model: string }> = [];
    provider.onUsage = (usage, model) => { seen.push({ ...usage, model }); };
    const partials: string[] = [];
    provider.onPartial = (accumulated) => { partials.push(accumulated); };
    const turn = await provider.completeConnectorTurn("mock", [{ role: "user", content: "hi" }], []);
    assert.equal(turn.content, "streamed answer");
    assert.equal(partials[partials.length - 1], "streamed answer");
    assert.deepEqual(seen, [{ promptTokens: 13, completionTokens: 4, totalTokens: 17, model: "mock" }]);
  } finally { server.close(); await once(server, "close"); }
});

test("provider hides embedded reasoning and rejects reasoning-only replies", async () => {
  let body = "<think>private planning</think>Visible answer";
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: body } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${addr.port}/v1/chat/completions`, "");
    const request = { model: "mock", messages: [{ role: "user" as const, content: "hi" }] };
    assert.equal((await converse(provider, request)).message.content, "Visible answer");
    body = "<think>private planning</think>";
    await assert.rejects(converse(provider, request), /no safe visible content/);
    body = "<think>unterminated private planning";
    await assert.rejects(converse(provider, request), /unterminated reasoning/);
  } finally { server.close(); await once(server, "close"); }
});
