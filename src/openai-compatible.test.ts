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

test("model transport rejects insecure remote endpoints and missing credentials", async () => {
  assert.throws(() => new OpenAICompatibleProvider("http://example.com/v1/chat/completions", "key"));
  assert.throws(() => new OpenAICompatibleProvider("https://user:secret@example.com/v1/chat/completions", "key"));
  assert.throws(() => new OpenAICompatibleProvider("https://example.com/v1/chat/completions?token=secret", "key"));
  const provider = new OpenAICompatibleProvider("https://example.com/v1/chat/completions", "");
  await assert.rejects(converse(provider, { model: "x", messages: [{ role: "user", content: "hi" }] }), /requires an API key/);
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


test("memory write tool is advertised only after explicit write opt-in", async () => {
  const advertised: string[][] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk.toString();
    const body = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> };
    advertised.push((body.tools ?? []).map(tool => tool.function?.name ?? ""));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Ready." } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${addr.port}/v1/chat/completions`, "");
    const messages = [{ role: "user" as const, content: "Remember this." }];
    await provider.completeToolTurn("mock", messages, true, false, false);
    await provider.completeToolTurn("mock", messages, true, false, true);
    assert.deepEqual(advertised[0], ["memory_search", "memory_list"]);
    assert.deepEqual(advertised[1], ["memory_search", "memory_list", "memory_add"]);
  } finally { server.close(); await once(server, "close"); }
});
