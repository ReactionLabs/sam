import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_OWN_TOOLS, LOADER_TOOL_NAME, LOADER_LOOP_LIMIT, UPFRONT_LIMIT, deferredCatalogLine, isLoaderOnlyRound, loadedTools, loaderLoopFallbackAnswer, loaderLoopLedgerSummary, loaderLoopNudge, notLoadedStubContent, partitionTools, recordToolLoad, toolNameOf } from "./tool-tiers.js";
import { readActivity } from "./activity.js";
import { OWN_TOOLS, ownToolsChat } from "./own-tools.js";
import { addConnector } from "./connectors.js";
import { connectorChat } from "./connector-chat.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

function def(name: string): Record<string, unknown> {
  return { type: "function", function: { name, description: "Does " + name + " things for the chat and more words here", parameters: { type: "object", properties: {} } } };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-tiers-"));
}

const OWN_NAMES = ["sam_memory_search", "sam_memory_list", "sam_search_chats", "sam_workspace_list", "sam_workspace_read", "sam_search_skills", "sam_list_skills", "sam_read_skill", "sam_propose_action", "sam_save_note", "sam_react", "sam_reach", "sam_patch_note", "sam_author_skill", "sam_code", "sam_coding_task", "sam_spawn_subagent", "sam_handoff_task", "sam_ask_linked"];
const MCP_NAMES = ["whoami", "list_leads", "get_lead", "pipeline_summary", "analytics_summary", "coin_lookup", "list_candidates", "list_alerts", "paper_setups", "stack_health"];

test("tool tiers: at or below the threshold nothing is deferred and no loader exists", () => {
  const below = OWN_NAMES.slice(0, 15);
  const all = below.map(def);
  const part = partitionTools(all, new Set());
  assert.equal(part.active, false);
  assert.equal(part.upfront.length, below.length);
  assert.equal(part.deferred.length, 0);
});

test("tool tiers: above the threshold the core rides upfront and the rest is catalogued", () => {
  const all = [...MCP_NAMES.map(n => def("mcp_" + n)), ...OWN_NAMES.map(def)];
  const part = partitionTools(all, new Set());
  assert.equal(part.active, true);
  assert.equal(part.upfront.length, UPFRONT_LIMIT);
  for (const core of CORE_OWN_TOOLS) assert.ok(part.upfrontNames.has(core), core + " upfront");
  assert.equal(part.deferred.length, all.length - UPFRONT_LIMIT);
  assert.ok(part.deferred.some(d => d.name === "sam_handoff_task"));
  const line = deferredCatalogLine(part.deferred);
  assert.match(line, /sam_handoff_task/);
  assert.match(line, /sam_load_tools/);
});

test("tool tiers: a session-loaded tool is promoted upfront", () => {
  const all = [...MCP_NAMES.map(n => def("mcp_" + n)), ...OWN_NAMES.map(def)];
  const part = partitionTools(all, new Set(["sam_handoff_task"]));
  assert.ok(part.upfrontNames.has("sam_handoff_task"));
  assert.ok(!part.deferred.some(d => d.name === "sam_handoff_task"));
});

test("tool tiers: loads persist per chat, unknown names are refused, stubs name the loader", () => {
  const root = scratch();
  try {
    const valid = new Set([...OWN_NAMES, ...MCP_NAMES.map(n => "mcp_" + n)]);
    const first = recordToolLoad(root, "chat-1", ["sam_handoff_task", "sam_nope"], valid);
    assert.deepEqual(first.loaded, ["sam_handoff_task"]);
    assert.deepEqual(first.unknown, ["sam_nope"]);
    assert.deepEqual(loadedTools(root, "chat-1"), ["sam_handoff_task"]);
    assert.deepEqual(loadedTools(root, "chat-2"), []);
    const again = recordToolLoad(root, "chat-1", ["sam_handoff_task"], valid);
    assert.deepEqual(again.loaded, []);
    const stub = JSON.parse(notLoadedStubContent("sam_handoff_task")) as { note: string };
    assert.match(stub.note, /sam_load_tools/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tool tiers: own chats crossed the threshold with sam_search_chats (23 own tools after sam_reach + sam_senses + sam_brief + sam_spawn_subagent) - the core rides upfront, the rest is deferred with the loader", async () => {
  const root = scratch();
  try {
    assert.equal(OWN_TOOLS.length, 23);
    const sentNames: string[][] = [];
    let step = 0;
    const fake = {
      async completeConnectorTurn(_model: string, _messages: Array<Record<string, unknown>>, tools: Array<{ function?: { name?: string } }>) {
        sentNames.push(tools.map(t => t.function?.name ?? ""));
        step++;
        if (step === 1) return { content: null, calls: [{ id: "c1", name: "sam_workspace_list", args: {} }] };
        return { content: "Listed.", calls: [] };
      },
    } as unknown as OpenAICompatibleProvider;
    const reply = await ownToolsChat(root, "sam", fake, "test-model", [{ role: "user", content: "list files" }], undefined, "chat-x");
    assert.equal(reply, "Listed.");
    assert.equal(sentNames[0].length, UPFRONT_LIMIT + 1);
    assert.ok(sentNames[0].includes("sam_search_chats"), "chat search is core tier, offered upfront");
    assert.ok(sentNames[0].includes(LOADER_TOOL_NAME));
    assert.ok(!sentNames[0].includes("sam_handoff_task"), "handoff is deferred until loaded");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tool tiers: a connector chat defers, stubs an early call, loads, then offers the tool", async () => {
  const root = scratch();
  const oldFetch = globalThis.fetch, oldKey = process.env.SAM_MCP_TOKEN_TEST, oldHosts = process.env.SAM_MCP_ALLOWED_HOSTS;
  try {
    process.env.SAM_MCP_ALLOWED_HOSTS = "mcp.secondshiftos.com";
    process.env.SAM_MCP_TOKEN_TEST = "fake-key";
    addConnector(root, "Second Shift", "https://mcp.secondshiftos.com/mcp/v1", "SAM_MCP_TOKEN_TEST");
    let modelCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input), body = JSON.parse(String(init?.body));
      if (url.includes("model.example")) {
        modelCalls++;
        const sentNames = (body.tools ?? []).map((t: { function?: { name?: string } }) => t.function?.name);
        if (modelCalls === 1) {
          assert.ok(sentNames.length <= UPFRONT_LIMIT + 1, "upfront tier plus loader stays bounded");
          assert.ok(sentNames.includes("sam_load_tools"));
          assert.ok(!sentNames.includes("sam_handoff_task"), "handoff starts deferred");
          return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "sam_handoff_task", arguments: "{\"prompt\":\"deep work\"}" } }] } }] }), { headers: { "Content-Type": "application/json" } });
        }
        if (modelCalls === 2) {
          const toolMsg = (body.messages as Array<{ role: string; content: string }>).find(m => m.role === "tool");
          assert.ok(toolMsg && toolMsg.content.includes("sam_load_tools"), "the stub named the loader");
          return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-2", type: "function", function: { name: "sam_load_tools", arguments: "{\"names\":[\"sam_handoff_task\"]}" } }] } }] }), { headers: { "Content-Type": "application/json" } });
        }
        assert.ok(sentNames.includes("sam_handoff_task"), "loaded tool is offered on the next step");
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Loaded and ready." } }] }), { headers: { "Content-Type": "application/json" } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18" } : body.method === "tools/list" ? { tools: MCP_NAMES.map(name => ({ name })) } : { content: [{ type: "text", text: "ok" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "Content-Type": "application/json" } });
    };
    const provider = new OpenAICompatibleProvider("https://model.example/v1/chat/completions", "model-test-key");
    const result = await connectorChat(root, provider, "test-model", [{ role: "user", content: "hand this off" }], undefined, { actor: "sam", chatId: "tier-chat" });
    assert.equal(result, "Loaded and ready.");
    assert.deepEqual(loadedTools(root, "tier-chat"), ["sam_handoff_task"]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SAM_MCP_TOKEN_TEST; else process.env.SAM_MCP_TOKEN_TEST = oldKey;
    if (oldHosts === undefined) delete process.env.SAM_MCP_ALLOWED_HOSTS; else process.env.SAM_MCP_ALLOWED_HOSTS = oldHosts;
    rmSync(root, { recursive: true, force: true });
  }
});

test("loader-loop guard: helpers classify rounds and phrase the honest ending", () => {
  assert.equal(LOADER_LOOP_LIMIT, 2);
  assert.equal(isLoaderOnlyRound([LOADER_TOOL_NAME]), true);
  assert.equal(isLoaderOnlyRound([LOADER_TOOL_NAME, LOADER_TOOL_NAME]), true);
  assert.equal(isLoaderOnlyRound([LOADER_TOOL_NAME, "sam_memory_search"]), false);
  assert.equal(isLoaderOnlyRound([]), false);
  assert.match(loaderLoopNudge(), /call one of the tools you loaded/i);
  assert.match(loaderLoopLedgerSummary([LOADER_TOOL_NAME, LOADER_TOOL_NAME]), /Loader loop stopped: 2 consecutive/);
  const fallback = loaderLoopFallbackAnswer([LOADER_TOOL_NAME, LOADER_TOOL_NAME]);
  assert.match(fallback, /kept loading tools without using them/);
  assert.doesNotMatch(fallback, /tool budget|ran out of steps/);
});

test("loader-loop guard: one loader-only round nudges and the turn recovers by using a loaded tool", async () => {
  const root = scratch();
  try {
    const seen: string[] = [];
    let step = 0;
    const fake = {
      async completeConnectorTurn(_model: string, messages: Array<Record<string, unknown>>, _tools: unknown) {
        seen.push(messages.map(m => String(m.content ?? "")).join("\n"));
        step++;
        if (step === 1) return { content: null, calls: [{ id: "l1", name: LOADER_TOOL_NAME, args: { names: ["sam_handoff_task"] } }] };
        if (step === 2) return { content: null, calls: [{ id: "w1", name: "sam_workspace_list", args: {} }] };
        return { content: "Used the workspace tool.", calls: [] };
      },
    } as unknown as OpenAICompatibleProvider;
    const reply = await ownToolsChat(root, "sam", fake, "test-model", [{ role: "user", content: "list files then hand off" }], undefined, "chat-nudge");
    assert.equal(reply, "Used the workspace tool.");
    assert.match(seen[1], /Loader-loop guard/, "the second step carries the nudge");
    assert.equal(readActivity(root, 10, { kind: "loader-loop" }).length, 0, "a recovered turn is not a loader loop");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loader-loop guard: two consecutive loader-only rounds stop the own-tools turn honestly", async () => {
  const root = scratch();
  try {
    let step = 0;
    const fake = {
      async completeConnectorTurn(_model: string, _messages: Array<Record<string, unknown>>, tools: Array<unknown>) {
        step++;
        if (step === 1) return { content: null, calls: [{ id: "l1", name: LOADER_TOOL_NAME, args: { names: ["sam_handoff_task"] } }] };
        if (step === 2) return { content: null, calls: [{ id: "l2", name: LOADER_TOOL_NAME, args: { names: ["sam_ask_linked"] } }] };
        assert.equal(tools.length, 0, "after the trip only the tool-free synthesis runs");
        return { content: null, calls: [{ id: "l3", name: LOADER_TOOL_NAME, args: { names: ["sam_brief"] } }] };
      },
    } as unknown as OpenAICompatibleProvider;
    const reply = await ownToolsChat(root, "sam", fake, "test-model", [{ role: "user", content: "do the thing" }], undefined, "chat-trip");
    assert.equal(step, 3, "no third tool round ran");
    assert.match(reply, /kept loading tools without using them \(2 calls made: sam_load_tools, sam_load_tools\)/);
    const logged = readActivity(root, 10, { kind: "loader-loop" });
    assert.equal(logged.length, 1);
    assert.match(logged[0].summary, /Loader loop stopped/);
    assert.equal(readActivity(root, 10, { kind: "tool-budget" }).length, 0, "a loader loop is never dressed as a budget failure");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loader-loop guard: two consecutive loader-only rounds stop the connector turn honestly", async () => {
  const root = scratch();
  const oldFetch = globalThis.fetch, oldKey = process.env.SAM_MCP_TOKEN_TEST, oldHosts = process.env.SAM_MCP_ALLOWED_HOSTS;
  try {
    process.env.SAM_MCP_ALLOWED_HOSTS = "mcp.secondshiftos.com";
    process.env.SAM_MCP_TOKEN_TEST = "fake-key";
    addConnector(root, "Second Shift", "https://mcp.secondshiftos.com/mcp/v1", "SAM_MCP_TOKEN_TEST");
    let modelCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input), body = JSON.parse(String(init?.body));
      if (url.includes("model.example")) {
        modelCalls++;
        const names = modelCalls === 1 ? ["sam_handoff_task"] : ["sam_ask_linked"];
        if (modelCalls <= 2) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-" + modelCalls, type: "function", function: { name: "sam_load_tools", arguments: JSON.stringify({ names }) } }] } }] }), { headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-3", type: "function", function: { name: "sam_load_tools", arguments: "{\"names\":[\"sam_brief\"]}" } }] } }] }), { headers: { "Content-Type": "application/json" } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18" } : body.method === "tools/list" ? { tools: MCP_NAMES.map(name => ({ name })) } : { content: [{ type: "text", text: "ok" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "Content-Type": "application/json" } });
    };
    const provider = new OpenAICompatibleProvider("https://model.example/v1/chat/completions", "model-test-key");
    const result = await connectorChat(root, provider, "test-model", [{ role: "user", content: "check the stack" }], undefined, { actor: "trading", chatId: "tier-trip" });
    assert.match(result, /kept loading tools without using them/);
    assert.equal(modelCalls, 3, "two loader rounds plus the tool-free synthesis, no third tool round");
    assert.equal(readActivity(root, 10, { kind: "loader-loop" }).length, 1);
    assert.equal(readActivity(root, 10, { kind: "tool-budget" }).length, 0);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SAM_MCP_TOKEN_TEST; else process.env.SAM_MCP_TOKEN_TEST = oldKey;
    if (oldHosts === undefined) delete process.env.SAM_MCP_ALLOWED_HOSTS; else process.env.SAM_MCP_ALLOWED_HOSTS = oldHosts;
    rmSync(root, { recursive: true, force: true });
  }
});
