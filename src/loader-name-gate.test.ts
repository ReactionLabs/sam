import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alreadyLoadedAck, loaderNameCorrections, loaderUnknownNote, LOADER_TOOL_NAME } from "./tool-tiers.js";
import { ownToolsChat } from "./own-tools.js";
import { chatTurnBudget } from "./budgets.js";
import type { OpenAICompatibleProvider } from "./openai-compatible.js";

// The loader name gate: sam_load_tools takes tool names the
// model types, and both chat loops plus the repeat-load
// acknowledgement reported a name that is not a tool in the
// chat as a bare entry in the "unknown" array - no fold
// correction, no guidance - so a folded name loaded nothing
// and taught nothing, and the model guessed again at the
// seam the loader-loop guard watches trip.
// loaderNameCorrections / loaderUnknownNote in tool-tiers.ts
// are now the ONE source the three reports read: exactly
// one fold match names the correction, no match is reported
// as not a tool in this chat, never an invented name.
// recordToolLoad and the stored loaded-names readers stay
// permissive by design.

const VALID = ["sam_memory_search", "sam_handoff_task", "sam_load_tools", "sam_brief"];

test("loader name gate: a folded name corrects to exactly one valid tool name", () => {
  assert.deepEqual(loaderNameCorrections(["Sam-Memory-Search"], VALID), { "Sam-Memory-Search": "sam_memory_search" });
  assert.deepEqual(loaderNameCorrections(["SAM_MEMORY_SEARCH"], VALID), { SAM_MEMORY_SEARCH: "sam_memory_search" });
  assert.deepEqual(loaderNameCorrections(["sam memory search"], VALID), { "sam memory search": "sam_memory_search" });
  assert.deepEqual(loaderNameCorrections(["Sam Handoff Task"], VALID), { "Sam Handoff Task": "sam_handoff_task" });
});

test("loader name gate: a name with no fold match gets no correction, and an ambiguous fold gets none", () => {
  assert.deepEqual(loaderNameCorrections(["sam_teleport"], VALID), {});
  assert.deepEqual(loaderNameCorrections([""], VALID), {});
  assert.deepEqual(loaderNameCorrections(["Foo Bar"], ["foo_bar", "foo-bar"]), {}, "two valid names folding the same way correct nothing");
  assert.deepEqual(loaderNameCorrections([], VALID), {});
});

test("loader name gate: the unknown note corrects the folded, names the rest as not tools, and states the rule once", () => {
  assert.equal(loaderUnknownNote([], {}), null);
  const note = loaderUnknownNote(["Sam-Memory-Search", "sam_teleport"], { "Sam-Memory-Search": "sam_memory_search" })!;
  assert.match(note, /"Sam-Memory-Search" is not a tool name - did you mean "sam_memory_search"\? Load it by its exact name\./);
  assert.match(note, /"sam_teleport" is not a tool in this chat\./);
  assert.match(note, /Tool names are exact: use the names from the deferred tools list in your instructions\.$/);
});

test("loader name gate: the repeat-load acknowledgement carries the correction for a folded unknown name", () => {
  const ack = alreadyLoadedAck(["sam_brief"], ["Sam-Brief"], VALID);
  assert.deepEqual(ack.corrections, { "Sam-Brief": "sam_brief" });
  assert.match(String(ack.note), /did you mean "sam_brief"/);
  const plain = alreadyLoadedAck(["sam_brief"], ["sam_teleport"], VALID);
  assert.equal(plain.corrections, undefined);
  assert.match(String(plain.note), /"sam_teleport" is not a tool in this chat\./);
});

type Turn = { content: string | null; calls: Array<{ id: string; name: string; args: Record<string, unknown> }> };
let seq = 0;
function call(name: string, args: Record<string, unknown>): Turn["calls"][number] {
  return { id: "c" + (++seq), name, args };
}

test("loader name gate: a turn loading a folded name gets the correction in the loader reply and loads nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "loader-name-gate-"));
  try {
    let invocations = 0;
    const seen: Array<Array<Record<string, unknown>>> = [];
    const provider = {
      async completeConnectorTurn(_model: string, messages: Array<Record<string, unknown>>) {
        invocations++;
        seen.push(messages.map(m => ({ ...m })));
        if (invocations === 1) return { content: null, calls: [call(LOADER_TOOL_NAME, { names: ["sam_handoff_task", "Sam-Brief", "sam_teleport"] })] };
        return { content: "answered without the tool", calls: [] };
      },
    } as unknown as OpenAICompatibleProvider;
    const { budget } = chatTurnBudget({ route: "chat", surface: "scoped" });
    const answer = await ownToolsChat(root, "sam", provider, "m", [{ role: "user", content: "hi" }], undefined, "chat-loader-name-gate", budget);
    assert.equal(answer, "answered without the tool");
    const results = seen[seen.length - 1].filter(m => m.role === "tool").map(m => String(m.content));
    const loaderReply = results.find(c => c.includes("\"status\":\"loaded\""))!;
    assert.ok(loaderReply, "the loader reply reached the model");
    assert.match(loaderReply, /"corrections":\{"Sam-Brief":"sam_brief"\}/);
    assert.match(loaderReply, /did you mean \\"sam_brief\\"/);
    assert.match(loaderReply, /\\"sam_teleport\\" is not a tool in this chat\./);
    assert.match(loaderReply, /"loaded":\["sam_handoff_task"\]/, "only the exact name loaded; the folded name loaded nothing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
