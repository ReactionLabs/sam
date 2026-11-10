import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addConnector } from "./connectors.js";
import { connectorChat } from "./connector-chat.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

// S4 latency: independent calls in one round run concurrently - the
// round costs the slowest call, not the sum. Two 400ms tool calls in
// one round must finish well under the 800ms sequential floor.
test("parallel tools: one round's independent calls run concurrently, results in call order", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-parallel-"));
  const oldFetch = globalThis.fetch, oldKey = process.env.SAM_MCP_TOKEN_TEST, oldHosts = process.env.SAM_MCP_ALLOWED_HOSTS;
  try {
    process.env.SAM_MCP_ALLOWED_HOSTS = "mcp.secondshiftos.com";
    process.env.SAM_MCP_TOKEN_TEST = "fake-key";
    addConnector(root, "Second Shift", "https://mcp.secondshiftos.com/mcp/v1", "SAM_MCP_TOKEN_TEST");
    let modelCalls = 0;
    const toolResultsSeen: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input), body = JSON.parse(String(init?.body));
      if (url.includes("model.example")) {
        modelCalls++;
        if (modelCalls === 1) {
          return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [
            { id: "call-1", type: "function", function: { name: "mcp_whoami", arguments: "{}" } },
            { id: "call-2", type: "function", function: { name: "mcp_stack_health", arguments: "{}" } },
          ] } }] }), { headers: { "Content-Type": "application/json" } });
        }
        for (const m of body.messages as Array<{ role: string; tool_call_id?: string; content: string }>) if (m.role === "tool") toolResultsSeen.push(m.tool_call_id + "=" + m.content);
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Both done." } }] }), { headers: { "Content-Type": "application/json" } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call") await new Promise(r => setTimeout(r, 400));
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18" } : body.method === "tools/list" ? { tools: [{ name: "whoami" }, { name: "stack_health" }] } : { content: [{ type: "text", text: "data for " + body.params.name }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "Content-Type": "application/json" } });
    };
    const provider = new OpenAICompatibleProvider("https://model.example/v1/chat/completions", "model-test-key");
    const started = Date.now();
    const result = await connectorChat(root, provider, "test-model", [{ role: "user", content: "check both" }]);
    const elapsed = Date.now() - started;
    assert.equal(result, "Both done.");
    assert.ok(elapsed < 700, "two 400ms calls in one round should overlap, took " + elapsed + "ms");
    assert.equal(toolResultsSeen.length, 2);
    assert.ok(toolResultsSeen[0].startsWith("call-1="), "tool messages stay in call order");
    assert.ok(toolResultsSeen[1].startsWith("call-2="));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SAM_MCP_TOKEN_TEST; else process.env.SAM_MCP_TOKEN_TEST = oldKey;
    if (oldHosts === undefined) delete process.env.SAM_MCP_ALLOWED_HOSTS; else process.env.SAM_MCP_ALLOWED_HOSTS = oldHosts;
    rmSync(root, { recursive: true, force: true });
  }
});
