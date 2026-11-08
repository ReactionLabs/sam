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
      if (enabled) {
        assert.equal(messages.length, 1);
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
  try { await assert.rejects(runMemoryToolTurn(request, [{ role: "user", content: "x" }], join(dir, "db")), /additional tool call/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
