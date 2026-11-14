import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {addConnector} from "./connectors.js";
import {connectorChat} from "./connector-chat.js";
import {listActions} from "./actions.js";
import {readActivity} from "./activity.js";
import {OpenAICompatibleProvider} from "./openai-compatible.js";

test("connector chat executes approved read-only MCP tool and summarizes response",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-chat-mcp-"));
 const oldFetch=globalThis.fetch,oldKey=process.env.SAM_MCP_TOKEN_TEST,oldHosts=process.env.SAM_MCP_ALLOWED_HOSTS;
 try{
  process.env.SAM_MCP_ALLOWED_HOSTS="mcp.secondshiftos.com";
  process.env.SAM_MCP_TOKEN_TEST="fake-key";
  addConnector(root,"Second Shift","https://mcp.secondshiftos.com/mcp/v1","SAM_MCP_TOKEN_TEST");
  let modelCalls=0;let toolCalls=0;
  globalThis.fetch=async(input,init)=>{
   const url=String(input),body=JSON.parse(String(init?.body));
   if(url.includes("model.example")){
    modelCalls++;
    const msg=modelCalls===1?{role:"assistant",content:null,tool_calls:[{id:"call-1",type:"function",function:{name:"mcp_whoami",arguments:"{}"}}]}:{role:"assistant",content:"Connected to Second Shift."};
    return new Response(JSON.stringify({choices:[{message:msg}]}),{headers:{"Content-Type":"application/json"}});
   }
   if(body.method==="notifications/initialized")return new Response(null,{status:202});
   if(body.method==="tools/call"){toolCalls++;assert.equal(body.params.name,"whoami");}
   const result=body.method==="initialize"?{protocolVersion:"2025-06-18"}:body.method==="tools/list"?{tools:[{name:"whoami"},{name:"update_lead_stage"}]}:{content:[{type:"text",text:"tenant-scoped identity"}]};
   return new Response(JSON.stringify({jsonrpc:"2.0",id:body.id,result}),{headers:{"Content-Type":"application/json"}});
  };
  const provider=new OpenAICompatibleProvider("https://model.example/v1/chat/completions","model-test-key");
  const result=await connectorChat(root,provider,"test-model",[{role:"user",content:"Who am I connected as?"}]);
  assert.equal(result,"Connected to Second Shift.");
  assert.equal(toolCalls,1);
  assert.equal(modelCalls,2);
 }finally{
  globalThis.fetch=oldFetch;
  if(oldKey===undefined)delete process.env.SAM_MCP_TOKEN_TEST;else process.env.SAM_MCP_TOKEN_TEST=oldKey;
  if(oldHosts===undefined)delete process.env.SAM_MCP_ALLOWED_HOSTS;else process.env.SAM_MCP_ALLOWED_HOSTS=oldHosts;
  rmSync(root,{recursive:true,force:true});
 }
});

test("connector chat pinned to a profile connector routes there and passes bounded args",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-chat-pin-"));
 const oldFetch=globalThis.fetch,oldA=process.env.SAM_MCP_TOKEN_TEST,oldB=process.env.SAM_MCP_TOKEN_NINES,oldHosts=process.env.SAM_MCP_ALLOWED_HOSTS;
 try{
  process.env.SAM_MCP_ALLOWED_HOSTS="mcp.secondshiftos.com,trading.example.com";
  process.env.SAM_MCP_TOKEN_TEST="fake-a";
  process.env.SAM_MCP_TOKEN_NINES="fake-b";
  addConnector(root,"Second Shift","https://mcp.secondshiftos.com/mcp/v1","SAM_MCP_TOKEN_TEST");
  const nines=addConnector(root,"Nines","https://trading.example.com/mcp/v1","SAM_MCP_TOKEN_NINES");
  let modelCalls=0;const mcpHosts:string[]=[];
  globalThis.fetch=async(input,init)=>{
   const url=String(input),body=JSON.parse(String(init?.body));
   if(url.includes("model.example")){
    modelCalls++;
    const msg=modelCalls===1?{role:"assistant",content:null,tool_calls:[{id:"call-1",type:"function",function:{name:"mcp_coin_lookup",arguments:"{\"query\":\"KABUTO\"}"}}]}:{role:"assistant",content:"Found KABUTO."};
    return new Response(JSON.stringify({choices:[{message:msg}]}),{headers:{"Content-Type":"application/json"}});
   }
   mcpHosts.push(new URL(url).hostname);
   if(body.method==="notifications/initialized")return new Response(null,{status:202});
   if(body.method==="tools/call"){assert.equal(body.params.name,"coin_lookup");assert.deepEqual(body.params.arguments,{query:"KABUTO"});}
   const result=body.method==="initialize"?{protocolVersion:"2025-06-18"}:body.method==="tools/list"?{tools:[{name:"coin_lookup"},{name:"stack_health"},{name:"update_lead_stage"}]}:{content:[{type:"text",text:"KABUTO rows"}]};
   return new Response(JSON.stringify({jsonrpc:"2.0",id:body.id,result}),{headers:{"Content-Type":"application/json"}});
  };
  const provider=new OpenAICompatibleProvider("https://model.example/v1/chat/completions","model-test-key");
  const result=await connectorChat(root,provider,"test-model",[{role:"user",content:"Look up KABUTO"}],nines.id);
  assert.equal(result,"Found KABUTO.");
  assert.ok(mcpHosts.length>0&&mcpHosts.every(h=>h==="trading.example.com"));
 }finally{
  globalThis.fetch=oldFetch;
  if(oldA===undefined)delete process.env.SAM_MCP_TOKEN_TEST;else process.env.SAM_MCP_TOKEN_TEST=oldA;
  if(oldB===undefined)delete process.env.SAM_MCP_TOKEN_NINES;else process.env.SAM_MCP_TOKEN_NINES=oldB;
  if(oldHosts===undefined)delete process.env.SAM_MCP_ALLOWED_HOSTS;else process.env.SAM_MCP_ALLOWED_HOSTS=oldHosts;
  rmSync(root,{recursive:true,force:true});
 }
});

test("connector chat also carries SAM's own tools: a proposal lands pending, stamped with the chat", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-chat-own-"));
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
        const msg = modelCalls === 1
          ? { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "sam_propose_action", arguments: JSON.stringify({ kind: "note", title: "From connector chat", detail: "hands work here too" }) } }] }
          : { role: "assistant", content: "Proposed it for approval." };
        return new Response(JSON.stringify({ choices: [{ message: msg }] }), { headers: { "Content-Type": "application/json" } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18" } : body.method === "tools/list" ? { tools: [{ name: "whoami" }] } : { content: [{ type: "text", text: "identity" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "Content-Type": "application/json" } });
    };
    const provider = new OpenAICompatibleProvider("https://model.example/v1/chat/completions", "model-test-key");
    const result = await connectorChat(root, provider, "test-model", [{ role: "user", content: "Save that as a note" }], undefined, { actor: "sam", chatId: "chat-xyz" });
    assert.equal(result, "Proposed it for approval.");
    const pending = listActions(root).filter(a => a.status === "pending");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].chatId, "chat-xyz");
    assert.equal(pending[0].title, "From connector chat");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SAM_MCP_TOKEN_TEST; else process.env.SAM_MCP_TOKEN_TEST = oldKey;
    if (oldHosts === undefined) delete process.env.SAM_MCP_ALLOWED_HOSTS; else process.env.SAM_MCP_ALLOWED_HOSTS = oldHosts;
    rmSync(root, { recursive: true, force: true });
  }
});

test("connector chat budget exhaustion answers from partial results instead of dying", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-chat-budget-"));
  const oldFetch = globalThis.fetch, oldKey = process.env.SAM_MCP_TOKEN_TEST, oldHosts = process.env.SAM_MCP_ALLOWED_HOSTS;
  try {
    process.env.SAM_MCP_ALLOWED_HOSTS = "mcp.secondshiftos.com";
    process.env.SAM_MCP_TOKEN_TEST = "fake-key";
    addConnector(root, "Second Shift", "https://mcp.secondshiftos.com/mcp/v1", "SAM_MCP_TOKEN_TEST");
    let modelCalls = 0; let toolCalls = 0; let synthesisMessages: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input), body = JSON.parse(String(init?.body));
      if (url.includes("model.example")) {
        modelCalls++;
        if (body.tool_choice === "none") {
          synthesisMessages = body.messages as Array<Record<string, unknown>>;
          return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Partial answer from the first two checks." } }] }), { headers: { "Content-Type": "application/json" } });
        }
        // Distinct arguments on purpose: since duplicate suppression
        // (2026-11-14) an IDENTICAL repeat returns the earlier result
        // instead of executing, so a budget test must vary the calls
        // to keep the call budget itself the binding constraint.
        const calls = [1, 2, 3].map(n => ({ id: "call-" + n, type: "function", function: { name: "mcp_whoami", arguments: JSON.stringify({ query: "check-" + n }) } }));
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: calls } }] }), { headers: { "Content-Type": "application/json" } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call") toolCalls++;
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18" } : body.method === "tools/list" ? { tools: [{ name: "whoami" }] } : { content: [{ type: "text", text: "tenant-scoped identity" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "Content-Type": "application/json" } });
    };
    const provider = new OpenAICompatibleProvider("https://model.example/v1/chat/completions", "model-test-key");
    const result = await connectorChat(root, provider, "test-model", [{ role: "user", content: "Check everything" }], undefined, { actor: "sam", chatId: "chat-budget" }, { rounds: 3, maxCalls: 2 });
    assert.equal(result, "Partial answer from the first two checks.");
    assert.equal(toolCalls, 2, "only the calls inside the budget may execute");
    assert.equal(modelCalls, 2, "one tool round plus the synthesis step");
    const calledIds = synthesisMessages.flatMap(m => Array.isArray(m.tool_calls) ? (m.tool_calls as Array<{ id: string }>).map(c => c.id) : []);
    const toolReplies = synthesisMessages.filter(m => m.role === "tool");
    assert.deepEqual(calledIds.sort(), toolReplies.map(m => String(m.tool_call_id)).sort(), "every tool_call must have a tool reply, executed or stubbed");
    assert.ok(toolReplies.some(m => String(m.content).includes("Tool budget exhausted")), "the unexecuted call must be stubbed with the budget note");
    const logged = readActivity(root, 10, { kind: "tool-budget" });
    assert.equal(logged.length, 1);
    assert.match(logged[0].summary, /2\/2 calls used/);
    assert.match(logged[0].summary, /not executed: mcp_whoami/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SAM_MCP_TOKEN_TEST; else process.env.SAM_MCP_TOKEN_TEST = oldKey;
    if (oldHosts === undefined) delete process.env.SAM_MCP_ALLOWED_HOSTS; else process.env.SAM_MCP_ALLOWED_HOSTS = oldHosts;
    rmSync(root, { recursive: true, force: true });
  }
});

test("connector chat survives a synthesis step that still requests tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-chat-budget2-"));
  const oldFetch = globalThis.fetch, oldKey = process.env.SAM_MCP_TOKEN_TEST, oldHosts = process.env.SAM_MCP_ALLOWED_HOSTS;
  try {
    process.env.SAM_MCP_ALLOWED_HOSTS = "mcp.secondshiftos.com";
    process.env.SAM_MCP_TOKEN_TEST = "fake-key";
    addConnector(root, "Second Shift", "https://mcp.secondshiftos.com/mcp/v1", "SAM_MCP_TOKEN_TEST");
    globalThis.fetch = async (input, init) => {
      const url = String(input), body = JSON.parse(String(init?.body));
      if (url.includes("model.example")) {
        const msg = { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "mcp_whoami", arguments: "{}" } }] };
        return new Response(JSON.stringify({ choices: [{ message: msg }] }), { headers: { "Content-Type": "application/json" } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18" } : body.method === "tools/list" ? { tools: [{ name: "whoami" }] } : { content: [{ type: "text", text: "tenant-scoped identity" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "Content-Type": "application/json" } });
    };
    const provider = new OpenAICompatibleProvider("https://model.example/v1/chat/completions", "model-test-key");
    const result = await connectorChat(root, provider, "test-model", [{ role: "user", content: "Who am I?" }], undefined, { actor: "sam" }, { rounds: 1, maxCalls: 6 });
    assert.match(result, /ran out of steps/i, "a tool-hungry synthesis resolves to a partial answer naming the true ending (steps, not the unspent call budget), not a throw");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SAM_MCP_TOKEN_TEST; else process.env.SAM_MCP_TOKEN_TEST = oldKey;
    if (oldHosts === undefined) delete process.env.SAM_MCP_ALLOWED_HOSTS; else process.env.SAM_MCP_ALLOWED_HOSTS = oldHosts;
    rmSync(root, { recursive: true, force: true });
  }
});
