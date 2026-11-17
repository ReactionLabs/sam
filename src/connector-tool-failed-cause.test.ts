import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addConnector } from "./connectors.js";
import { connectorChat, mcpToolFailureError } from "./connector-chat.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

// MCP tool failures carry their reason (gap found 2026-11-17,
// hourly run 00:04 EST): the connector loop's tool catch bound
// no error at all and returned {error:"MCP tool failed"} for
// every death of a connector read, discarding the classes the
// exchange layer separates (timeout conversion, authorization,
// HTTP status, missing credential) and every transport cause
// behind the bare "fetch failed" wrapper. The tool result is
// the only record of the death and the model reading it is the
// voice that reports it, so the error now composes through
// errorReason (the 04:04 bridge seam) via mcpToolFailureError:
// the prefix stays, the reason follows it, a non-Error throw
// keeps String(error), no bot token leaks, and the tool's
// arguments never enter the error.

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND mcp.invalid"), { code: "ENOTFOUND" }),
});

test("an MCP tool failure reason names the transport cause behind the wrapper", () => {
  assert.equal(mcpToolFailureError(dnsErr()), "MCP tool failed: fetch failed: getaddrinfo ENOTFOUND mcp.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  assert.equal(mcpToolFailureError(err), "MCP tool failed: fetch failed: read (ECONNRESET)");
});

test("causeless MCP errors surface their message after the prefix; a non-Error throw keeps String(error)", () => {
  assert.equal(mcpToolFailureError(new Error("MCP authorization failed")), "MCP tool failed: MCP authorization failed");
  assert.equal(mcpToolFailureError(new Error("MCP request timed out")), "MCP tool failed: MCP request timed out");
  assert.equal(mcpToolFailureError("plain string failure"), "MCP tool failed: plain string failure");
});

test("no bot token leaks through an MCP tool failure reason", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = mcpToolFailureError(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

async function runFailingToolTurn(fail: () => never): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "sam-mcp-cause-"));
  const oldFetch = globalThis.fetch, oldKey = process.env.SAM_MCP_TOKEN_TEST, oldHosts = process.env.SAM_MCP_ALLOWED_HOSTS;
  try {
    process.env.SAM_MCP_ALLOWED_HOSTS = "mcp.secondshiftos.com";
    process.env.SAM_MCP_TOKEN_TEST = "fake-key";
    addConnector(root, "Second Shift", "https://mcp.secondshiftos.com/mcp/v1", "SAM_MCP_TOKEN_TEST");
    let modelCalls = 0;
    const toolContents: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input), body = JSON.parse(String(init?.body));
      if (url.includes("model.example")) {
        modelCalls++;
        if (modelCalls === 1) {
          const msg = { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "mcp_whoami", arguments: "{}" } }] };
          return new Response(JSON.stringify({ choices: [{ message: msg }] }), { headers: { "Content-Type": "application/json" } });
        }
        for (const m of (body.messages ?? [])) if (m.role === "tool") toolContents.push(String(m.content));
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "The identity read failed." } }] }), { headers: { "Content-Type": "application/json" } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call") fail();
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: [{ name: "whoami" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "Content-Type": "application/json" } });
    };
    const provider = new OpenAICompatibleProvider("https://model.example/v1/chat/completions", "model-test-key");
    const result = await connectorChat(root, provider, "test-model", [{ role: "user", content: "Who am I connected as?" }]);
    assert.equal(result, "The identity read failed.");
    return toolContents;
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SAM_MCP_TOKEN_TEST; else process.env.SAM_MCP_TOKEN_TEST = oldKey;
    if (oldHosts === undefined) delete process.env.SAM_MCP_ALLOWED_HOSTS; else process.env.SAM_MCP_ALLOWED_HOSTS = oldHosts;
    rmSync(root, { recursive: true, force: true });
  }
}

test("a connector tool dying on transport hands the model the cause, not the bare label", async () => {
  const toolContents = await runFailingToolTurn(() => { throw dnsErr(); });
  assert.equal(toolContents.length, 1);
  assert.match(toolContents[0], /MCP tool failed: fetch failed: getaddrinfo ENOTFOUND mcp\.invalid/);
});

test("a connector tool dying on the exchange timeout hands the model the timeout class", async () => {
  const toolContents = await runFailingToolTurn(() => {
    throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  });
  assert.equal(toolContents.length, 1);
  assert.match(toolContents[0], /MCP tool failed: MCP request timed out/);
});
