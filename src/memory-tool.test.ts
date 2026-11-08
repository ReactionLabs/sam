import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./memory.js";
import { executeMemorySearch, runMemoryToolTurn, validateToolTurn, type ToolMessage, type ToolTurn } from "./memory-tool.js";

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
