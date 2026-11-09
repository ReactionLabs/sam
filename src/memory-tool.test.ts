import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./memory.js";
import { containsCredentialMaterial, executeMemoryList, executeMemorySearch, parseMemoryAddArguments, runMemoryToolTurn, validateToolTurn, type ToolMessage, type ToolTurn } from "./memory-tool.js";

test("model-selected memory search uses SQLite evidence and only one tool call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-tool-"));
  const db = join(dir, "memory.db");
  try {
    const store = new MemoryStore(db);
    store.add({ kind: "observation", content: "My development workspace is C:\\Projects", source: "owner-test" });
    store.close();
    let count = 0;
    const audit: string[] = [];
    const request = async (messages: ToolMessage[], enabled: boolean): Promise<ToolTurn> => {
      count++;
      if (messages.length === 1) {
        assert.equal(enabled, true);
        return { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "memory_search", arguments: '{"query":"workspace"}' } }] };
      }
      const tool = messages.at(-1);
      assert.equal(tool?.role, "tool");
      assert.match(tool?.content ?? "", /C:\\\\Projects/);
      return { content: "Workspace confirmed from SQLite" };
    };
    const answer = await runMemoryToolTurn(request, [{ role: "user", content: "Find my workspace" }], db,
      event => audit.push(event.status));
    assert.equal(answer, "Workspace confirmed from SQLite");
    assert.equal(count, 2);
    assert.deepEqual(audit, ["requested", "completed"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tool router rejects unsupported tools, malformed arguments, and repeated calls", async () => {
  assert.throws(() => validateToolTurn({ content: null, tool_calls: [{ id: "a", type: "function", function: { name: "run_command", arguments: "{}" } }] }), /Unsupported/);
  assert.throws(() => executeMemorySearch("/unused/path", '{"query":"x","write":true}'), /Invalid memory search arguments/);
  const request = async (_messages: ToolMessage[], enabled: boolean): Promise<ToolTurn> =>
    ({ content: null, tool_calls: [{ id: enabled ? "first" : "second", type: "function", function: { name: "memory_search", arguments: '{"query":"x"}' } }] });
  const dir = mkdtempSync(join(tmpdir(), "sam-tool-loop-"));
  try { await assert.rejects(runMemoryToolTurn(request, [{ role: "user", content: "x" }], join(dir, "db")), /after the budget/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("empty tool_calls array is a valid text-only provider response", () => {
  assert.deepEqual(validateToolTurn({ content: "No search needed", tool_calls: [] }), { content: "No search needed" });
});

test("bounded parallel memory calls are accepted but over-limit and duplicate calls rejected", () => {
  const call = (id: string) => ({ id, type: "function", function: { name: "memory_search", arguments: '{"query":"workspace"}' } });
  assert.equal(validateToolTurn({ content: null, tool_calls: [call("one"), call("two")] }).tool_calls?.length, 2);
  assert.throws(() => validateToolTurn({ content: null, tool_calls: [call("a"), call("b"), call("c"), call("d")] }), /At most three/);
  assert.throws(() => validateToolTurn({ content: null, tool_calls: [call("a"), call("a")] }), /Unsupported or malformed/);
});

test("model can inspect across multiple bounded tool rounds", async () => {
  const dir = mkdtempSync(join(tmpdir(),"sam-tool-rounds-"));
  try {
    let turns = 0;
    const request = async (_messages: ToolMessage[], enabled: boolean): Promise<ToolTurn> => {
      turns++;
      if (turns <= 2) return { content: null, tool_calls: [{ id: "round_"+turns, type: "function", function: { name:"memory_search", arguments:'{"query":"workspace"}' } }] };
      assert.equal(enabled,true);
      return { content:"Inspected after two searches" };
    };
    assert.equal(await runMemoryToolTurn(request,[{role:"user",content:"Inspect"}],join(dir,"db")),"Inspected after two searches");
    assert.equal(turns,3);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("OpenAI-compatible tool-call response may omit content but not on final answer",()=>{
 const call={id:"call_abc",type:"function",function:{name:"read_file",arguments:'{"path":"package.json"}'}};
 assert.deepEqual(validateToolTurn({tool_calls:[call]},true),{content:null,tool_calls:[call]});
 assert.throws(()=>validateToolTurn({}),/Empty model response/);
 assert.throws(()=>validateToolTurn({content:42,tool_calls:[call]},true),/Invalid tool response content/);
});

test("tool call budget returns a grounded final response without executing excess calls",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"sam-budget-"));
 try{
  let requests=0;
  let finalSeen=false;
  const request=async(messages:ToolMessage[],enabled:boolean):Promise<ToolTurn>=>{
   requests++;
   if(!enabled){
    finalSeen=true;
    assert.ok(messages.some(m=>m.role==="tool"&&m.content.includes("Tool budget exhausted")));
    return {content:"Partial findings; inspection limit reached."};
   }
   return {content:null,tool_calls:[
    {id:"tool_"+requests+"_a",type:"function",function:{name:"read_file",arguments:'{"path":"missing.txt"}'}},
    {id:"tool_"+requests+"_b",type:"function",function:{name:"read_file",arguments:'{"path":"missing2.txt"}'}},
    {id:"tool_"+requests+"_c",type:"function",function:{name:"read_file",arguments:'{"path":"missing3.txt"}'}}
   ]};
  };
  const answer=await runMemoryToolTurn(request,[{role:"user",content:"Inspect"}],join(dir,"memory.db"),undefined,dir);
  assert.equal(answer,"Partial findings; inspection limit reached.");
  assert.equal(finalSeen,true);
  assert.equal(requests,4);
 }finally{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});


test("model memory add requires explicit owner approval and persists after reopening SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-memory-write-"));
  const db = join(dir, "memory.db");
  const audit: string[] = [];
  let requests = 0;
  let approvals = 0;
  try {
    const request = async (messages: ToolMessage[], enabled: boolean, writeEnabled?: boolean): Promise<ToolTurn> => {
      requests++;
      if (requests === 1) {
        assert.equal(enabled, true);
        assert.equal(writeEnabled, true);
        return { content: null, tool_calls: [{ id: "save_1", type: "function", function: {
          name: "memory_add", arguments: JSON.stringify({ kind: "decision", content: "Use a bounded, owner-approved memory write flow." })
        } }] };
      }
      const result = JSON.parse(messages.at(-1)?.content ?? "{}");
      assert.equal(result.ok, true);
      assert.equal(result.record.source, "owner-approved:talk --live --memory-write");
      return { content: "The record was saved and verified." };
    };
    const answer = await runMemoryToolTurn(request, [{ role: "user", content: "Remember this decision." }], db,
      event => audit.push(event.status), undefined, undefined, true, proposal => {
        approvals++;
        assert.equal(proposal.kind, "decision");
        assert.match(proposal.content, /owner-approved/);
        return true;
      });
    assert.equal(answer, "The record was saved and verified.");
    assert.equal(requests, 2);
    assert.equal(approvals, 1);
    assert.deepEqual(audit, ["requested", "completed"]);
    const reopened = new MemoryStore(db);
    try {
      const records = reopened.list();
      assert.equal(records.length, 1);
      assert.equal(records[0].kind, "decision");
      assert.equal(records[0].content, "Use a bounded, owner-approved memory write flow.");
      assert.equal(records[0].source, "owner-approved:talk --live --memory-write");
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("model memory add is denied when the owner rejects the proposal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-memory-denied-"));
  const db = join(dir, "memory.db");
  const audit: string[] = [];
  let requests = 0;
  try {
    const request = async (messages: ToolMessage[]): Promise<ToolTurn> => {
      requests++;
      if (requests === 1) return { content: null, tool_calls: [{ id: "save_2", type: "function", function: {
        name: "memory_add", arguments: JSON.stringify({ kind: "observation", content: "Do not save without consent." })
      } }] };
      const result = JSON.parse(messages.at(-1)?.content ?? "{}");
      assert.deepEqual(result, { ok: false, reason: "owner_denied" });
      return { content: "Nothing was saved." };
    };
    const answer = await runMemoryToolTurn(request, [{ role: "user", content: "Remember this." }], db,
      event => audit.push(event.status), undefined, undefined, true, () => false);
    assert.equal(answer, "Nothing was saved.");
    assert.deepEqual(audit, ["requested", "denied"]);
    const reopened = new MemoryStore(db);
    try { assert.equal(reopened.list().length, 0); } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory add is not accepted unless the write capability is explicitly enabled", () => {
  const call = { id: "save_3", type: "function", function: {
    name: "memory_add", arguments: JSON.stringify({ kind: "observation", content: "x" })
  } };
  assert.throws(() => validateToolTurn({ content: null, tool_calls: [call] }), /Unsupported/);
  assert.equal(validateToolTurn({ content: null, tool_calls: [call] }, false, true).tool_calls?.length, 1);
  assert.throws(() => parseMemoryAddArguments(JSON.stringify({ kind: "credential", content: "x" })), /Invalid/);
  assert.throws(() => parseMemoryAddArguments(JSON.stringify({ kind: "observation", content: "x", source: "model" })), /Invalid/);
});

test("credential-like content is rejected before owner approval and memory listing is untrusted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-memory-secret-"));
  const db = join(dir, "memory.db");
  let approvals = 0;
  try {
    assert.equal(containsCredentialMaterial("api_key=sk_12345678901234567890"), true);
    assert.equal(containsCredentialMaterial("The preferred project name is SAM."), false);
    let requests = 0;
    const request = async (messages: ToolMessage[]): Promise<ToolTurn> => {
      requests++;
      if (requests === 1) return { content: null, tool_calls: [{ id: "save_secret", type: "function", function: {
        name: "memory_add", arguments: JSON.stringify({ kind: "observation", content: "api_key=sk_12345678901234567890" })
      } }] };
      assert.match(messages.at(-1)?.content ?? "", /Potential credential material/);
      return { content: "Credential-like content was rejected." };
    };
    const answer = await runMemoryToolTurn(request, [{ role: "user", content: "Save this." }], db,
      undefined, undefined, undefined, true, () => { approvals++; return true; });
    assert.equal(answer, "Credential-like content was rejected.");
    assert.equal(approvals, 0);
    const listed = JSON.parse(executeMemoryList(db));
    assert.equal(listed.untrusted, true);
    assert.deepEqual(listed.records, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("memory list uses a validated SQLite row limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-memory-list-limit-"));
  const db = join(dir, "memory.db");
  const store = new MemoryStore(db);
  try {
    for (let i = 0; i < 15; i++) store.add({
      kind: "observation", content: "bounded record " + i, source: "test"
    });
    assert.equal(store.list(undefined, 10).length, 10);
    assert.throws(() => store.list(undefined, 0), /Invalid memory list limit/);
    assert.throws(() => store.list(undefined, 1001), /Invalid memory list limit/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});


test("memory add fails closed when no owner approval callback is supplied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-memory-no-approval-"));
  const db = join(dir, "memory.db");
  let requests = 0;
  const audit: string[] = [];
  try {
    const request = async (messages: ToolMessage[]): Promise<ToolTurn> => {
      requests++;
      if (requests === 1) return { content: null, tool_calls: [{ id: "save_no_approval", type: "function", function: {
        name: "memory_add", arguments: JSON.stringify({ kind: "observation", content: "Approval callback is required." })
      } }] };
      assert.deepEqual(JSON.parse(messages.at(-1)?.content ?? "{}"), { ok: false, reason: "owner_approval_required" });
      return { content: "No approval handler, so nothing was saved." };
    };
    const answer = await runMemoryToolTurn(request, [{ role: "user", content: "Remember this." }], db,
      event => audit.push(event.status), undefined, undefined, true);
    assert.equal(answer, "No approval handler, so nothing was saved.");
    assert.deepEqual(audit, ["requested", "denied"]);
    const reopened = new MemoryStore(db);
    try { assert.equal(reopened.list().length, 0); } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
