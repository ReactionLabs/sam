import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { executeOwnTool } from "./own-tools.js";
import { readActivity } from "./activity.js";
import {
  annotateToolResult, attachReplySources, consumeRunSources, describeToolSources,
  peekRunSources, processReplySources, recordRunSource, sourcesForMessage,
  sourceViewsForChat, stripModelSourcesList, type RunSource,
} from "./source-citations.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-source-citations-"));
}

test("source descriptions: each source-bearing tool kind names what was actually read or run", () => {
  // File read: the workspace-relative path.
  assert.deepEqual(
    describeToolSources("sam_workspace_read", { path: "notes/plan.md" }, { path: "notes/plan.md", content: "x" }),
    [{ kind: "file", descriptor: "notes/plan.md" }]);
  // Code-root read is a file too; a code run is the command.
  assert.deepEqual(
    describeToolSources("sam_code", { action: "read", path: "src/app.ts" }, { path: "src/app.ts", content: "x" }),
    [{ kind: "file", descriptor: "src/app.ts" }]);
  assert.deepEqual(
    describeToolSources("sam_code", { action: "run", command: "test" }, "42 passing"),
    [{ kind: "command", descriptor: "command: test" }]);
  assert.deepEqual(
    describeToolSources("sam_code", { action: "python", path: "tools/check.py" }, "done"),
    [{ kind: "command", descriptor: "command: python tools/check.py" }]);
  // Skill read: the skill's name.
  assert.deepEqual(
    describeToolSources("sam_read_skill", { name: "git-commit" }, { name: "git-commit", instructions: "..." }),
    [{ kind: "skill", descriptor: "skill: git-commit" }]);
  // Web read of a URL: the URL itself, with the page title when carried.
  assert.deepEqual(
    describeToolSources("sam_reach", { channel: "web", action: "read", query: "https://example.com/a" },
      { ok: true, channel: "web", action: "read", items: [{ title: "The A Page", url: "https://example.com/a" }] }),
    [{ kind: "web", descriptor: "https://example.com/a - The A Page" }]);
  // Web search: the search itself is the source.
  assert.deepEqual(
    describeToolSources("sam_reach", { channel: "web", action: "search", query: "tampa permits" },
      { ok: true, channel: "web", action: "search", items: [{ title: "x" }] }),
    [{ kind: "web", descriptor: "agent-reach web search: tampa permits" }]);
  assert.deepEqual(
    describeToolSources("sam_search_skills", { query: "calendar" }, { untrusted: true, results: [{ name: "cal" }] }),
    [{ kind: "web", descriptor: "skills.sh search: calendar" }]);
  // Senses: the doc that was read.
  assert.deepEqual(
    describeToolSources("sam_senses", { action: "mail", query: "invoice" }, { ok: true, sense: "mail", output: "..." }),
    [{ kind: "doc", descriptor: "Gmail (senses): search invoice" }]);
  assert.deepEqual(
    describeToolSources("sam_senses", { action: "agenda", days: 3 }, { ok: true, sense: "agenda", output: "..." }),
    [{ kind: "doc", descriptor: "Calendar (senses): next 3 days" }]);
});

test("source descriptions: errors, refusals, actions, and the #92 search ground nothing", () => {
  assert.deepEqual(describeToolSources("sam_workspace_read", { path: "x" }, { error: "Path not available" }), []);
  assert.deepEqual(describeToolSources("sam_reach", { channel: "web", action: "search", query: "q" }, { ok: false, error: { code: "NEED_SETUP" } }), []);
  assert.deepEqual(describeToolSources("sam_senses", { action: "mail" }, { ok: false, error: "not installed" }), []);
  assert.deepEqual(describeToolSources("sam_code", { action: "write", path: "a.ts" }, { ok: true }), []);
  assert.deepEqual(describeToolSources("sam_code", { action: "list", path: "." }, { entries: [] }), []);
  assert.deepEqual(describeToolSources("sam_search_chats", { query: "q" }, { hits: [] }), []);
  assert.deepEqual(describeToolSources("sam_propose_action", { kind: "note" }, { status: "pending_owner_approval", id: "x" }), []);
  assert.deepEqual(describeToolSources("sam_save_note", {}, { status: "saved", id: "x" }), []);
});

test("source descriptions: a memory read grounds one source per record returned", () => {
  const out = describeToolSources("sam_memory_list", {}, {
    untrusted: true,
    records: [
      { id: "aaaaaaaa-1111-4111-8111-111111111111", kind: "decision", content: "x" },
      { id: "bbbbbbbb-2222-4222-8222-222222222222", kind: "observation", content: "y" },
    ],
  });
  assert.deepEqual(out, [
    { kind: "memory", descriptor: "memory: decision record aaaaaaaa" },
    { kind: "memory", descriptor: "memory: observation record bbbbbbbb" },
  ]);
});

test("source registry: sequential numbering, same source read twice keeps its number, consume clears", () => {
  const chat = "chat-1", msg = "msg-1";
  assert.equal(recordRunSource(chat, msg, { kind: "file", descriptor: "a.md" }), 1);
  assert.equal(recordRunSource(chat, msg, { kind: "command", descriptor: "command: test" }), 2);
  assert.equal(recordRunSource(chat, msg, { kind: "file", descriptor: "a.md" }), 1);
  assert.deepEqual(peekRunSources(chat, msg).map(s => s.n), [1, 2]);
  // Another turn's registry is separate.
  assert.deepEqual(peekRunSources(chat, "msg-2"), []);
  const consumed = consumeRunSources(chat, msg);
  assert.deepEqual(consumed.map(s => s.descriptor), ["a.md", "command: test"]);
  assert.deepEqual(consumeRunSources(chat, msg), []);
});

test("annotation: the model sees the source number on object and string results alike", () => {
  const root = scratch();
  try {
    const obj = annotateToolResult(root, {
      chatId: "c1", userMessageId: "m1", actor: "sam",
      name: "sam_workspace_read", args: { path: "docs/spec.md" },
      result: { path: "docs/spec.md", content: "the spec" },
    }) as { citeSources: string[]; citeGuidance: string; content: string };
    assert.deepEqual(obj.citeSources, ["[Source 1: docs/spec.md]"]);
    assert.ok(obj.citeGuidance.includes("Cite facts"));
    assert.equal(obj.content, "the spec");
    const str = annotateToolResult(root, {
      chatId: "c1", userMessageId: "m1", actor: "sam",
      name: "sam_code", args: { action: "run", command: "build" },
      result: "build ok",
    }) as string;
    assert.equal(str, "[Source 2: command: build]\nbuild ok");
    // Idempotent: re-annotating an annotated result renumbers nothing.
    const again = annotateToolResult(root, {
      chatId: "c1", userMessageId: "m1", actor: "sam",
      name: "sam_workspace_read", args: { path: "docs/spec.md" }, result: obj,
    }) as { citeSources: string[] };
    assert.deepEqual(again.citeSources, ["[Source 1: docs/spec.md]"]);
    assert.deepEqual(peekRunSources("c1", "m1").map(s => s.n), [1, 2]);
    // No live turn key: untouched and unregistered.
    const bare = annotateToolResult(root, {
      actor: "sam", name: "sam_workspace_read", args: { path: "x.md" }, result: { path: "x.md", content: "y" },
    }) as Record<string, unknown>;
    assert.equal(bare.citeSources, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("end to end: a real workspace read is numbered at dispatch and the cited reply renders the canonical list", () => {
  const root = scratch();
  try {
    writeFileSync(join(root, "rates.md"), "The quarterly rate is 360 dollars.\n");
    const store = new ChatStore(root);
    const chat = store.create("Asking");
    const ask = store.add(chat.id, "user", "what is the quarterly rate?");
    store.close();
    const result = executeOwnTool(root, "sam", "sam_workspace_read", { path: "rates.md" }, chat.id, ask.id) as { citeSources: string[] };
    assert.deepEqual(result.citeSources, ["[Source 1: rates.md]"]);
    const processed = processReplySources(root, {
      chatId: chat.id, userMessageId: ask.id, actor: "sam",
      text: "The quarterly rate is 360 dollars [1].",
    });
    assert.equal(processed.rejectedCount, 0);
    assert.deepEqual(processed.sources, [{ n: 1, kind: "file", descriptor: "rates.md" }]);
    assert.equal(processed.text, "The quarterly rate is 360 dollars [1].\n\nSources:\n[1] rates.md");
    // The audit record persists and reads back.
    const store2 = new ChatStore(root);
    const replyRow = store2.add(chat.id, "assistant", processed.text);
    store2.close();
    assert.equal(attachReplySources(root, { messageId: replyRow.id, chatId: chat.id, actor: "sam", registered: processed.registered, cited: processed.sources }), true);
    const stored = sourcesForMessage(root, replyRow.id);
    assert.deepEqual(stored?.cited, [{ n: 1, kind: "file", descriptor: "rates.md" }]);
    assert.deepEqual(sourceViewsForChat(root, chat.id)[replyRow.id], [{ n: 1, kind: "file", descriptor: "rates.md" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fabricated citations: a number outside the run's registry is stripped, ledgered, and never listed", () => {
  const root = scratch();
  try {
    recordRunSource("c9", "m9", { kind: "file", descriptor: "real.md" });
    const processed = processReplySources(root, {
      chatId: "c9", userMessageId: "m9", actor: "sam",
      text: "The rate is 360 [1] and the moon is cheese [9].",
    });
    assert.equal(processed.rejectedCount, 1);
    assert.ok(!processed.text.includes("[9]"));
    assert.equal(processed.text, "The rate is 360 [1] and the moon is cheese.\n\nSources:\n[1] real.md");
    const lines = readActivity(root, 50).filter(l => l.kind === "source-citation-rejected");
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.includes("1 source number(s)"));
    // A reply whose only citations are fabricated gets no list at all.
    recordRunSource("c9", "m10", { kind: "file", descriptor: "real.md" });
    const only = processReplySources(root, {
      chatId: "c9", userMessageId: "m10", actor: "sam", text: "Trust me [4].",
    });
    assert.equal(only.text, "Trust me.");
    assert.deepEqual(only.sources, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an uncited conversational reply gets no sources list, and non-citation brackets pass through", () => {
  const root = scratch();
  try {
    recordRunSource("c5", "m5", { kind: "file", descriptor: "real.md" });
    const processed = processReplySources(root, {
      chatId: "c5", userMessageId: "m5", actor: "sam",
      text: "Sounds good, let us do it tomorrow. (The array starts at arr[0], and the [2026] plan is separate.)",
    });
    assert.equal(processed.rejectedCount, 0);
    assert.deepEqual(processed.sources, []);
    assert.ok(!processed.text.includes("Sources:"));
    assert.ok(processed.text.includes("arr[0]"));
    assert.ok(processed.text.includes("[2026]"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the model's own sources list never doubles up: the canonical descriptors win", () => {
  const root = scratch();
  try {
    recordRunSource("c7", "m7", { kind: "file", descriptor: "rates.md" });
    const processed = processReplySources(root, {
      chatId: "c7", userMessageId: "m7", actor: "sam",
      text: "The quarterly rate is 360 dollars [1].\n\nSources:\n[1] A Made-Up Document I Never Read",
    });
    const occurrences = processed.text.split("Sources:").length - 1;
    assert.equal(occurrences, 1);
    assert.ok(processed.text.endsWith("Sources:\n[1] rates.md"));
    assert.ok(!processed.text.includes("Made-Up"));
    // A model list with nothing valid behind it disappears entirely.
    recordRunSource("c7", "m8", { kind: "file", descriptor: "rates.md" });
    const padded = processReplySources(root, {
      chatId: "c7", userMessageId: "m8", actor: "sam",
      text: "The rate is probably 360.\n\nSources:\n[1] rates.md",
    });
    assert.ok(!padded.text.includes("Sources:"));
    assert.deepEqual(padded.sources, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stripModelSourcesList: only a trailing list-shaped block under a Sources header is stripped", () => {
  assert.equal(stripModelSourcesList("Body text.\n\nSources:\n- [1] a.md\n- [2] b.md").text, "Body text.");
  assert.equal(stripModelSourcesList("Body text.\n\nSources:\n1. a.md").stripped, true);
  // A Sources header followed by prose is not a list - left alone.
  const prose = stripModelSourcesList("Body.\n\nSources: the owner told me himself over coffee.");
  assert.equal(prose.stripped, false);
  // No header at all: untouched.
  assert.equal(stripModelSourcesList("Just an answer [1].").stripped, false);
});

test("registry isolation: one turn's sources are never citable by another turn", () => {
  const root = scratch();
  try {
    recordRunSource("chatA", "mA", { kind: "file", descriptor: "a.md" });
    // Turn B never read anything; its [1] has no registry behind it.
    const processed = processReplySources(root, {
      chatId: "chatA", userMessageId: "mB", actor: "sam", text: "As shown earlier [1].",
    });
    assert.equal(processed.rejectedCount, 1);
    assert.deepEqual(processed.sources, []);
    assert.equal(processed.text, "As shown earlier.");
    // And turn A's registry was not consumed by turn B's pass.
    const stillThere: RunSource[] = peekRunSources("chatA", "mA");
    assert.equal(stillThere.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
