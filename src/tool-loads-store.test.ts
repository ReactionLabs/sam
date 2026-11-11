import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadedTools, recordToolLoad } from "./tool-tiers.js";

// State convergence (UNIFICATION item 4, ninth store): the
// per-chat tool-load store migrated from whole-file
// tool-loads.json rewrites to one-row-per-chat SQLite. These
// tests pin the migration contract: legacy files import entry
// by entry with every chat's loaded set intact, are renamed
// (never deleted), a malformed file imports nothing and stays
// put, a pure read creates nothing (not even the .sam
// directory the old read path created), a record that loads
// nothing new writes nothing, and single-row upserts for
// different chats cannot lose each other.

function fresh(): { base: string; sam: string } {
  const base = mkdtempSync(join(tmpdir(), "sam-tool-loads-store-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  return { base, sam };
}

const VALID = new Set(["sam_handoff_task", "sam_ask_linked", "sam_manage_chats", "mcp_stack_health", "mcp_paper_setups"]);

test("tool-loads store: a legacy tool-loads.json imports every chat, names intact, file renamed not deleted", () => {
  const { base, sam } = fresh();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    const legacy = { version: 1, chats: { "chat-a": ["mcp_stack_health", "mcp_paper_setups"], "chat-b": ["sam_manage_chats"] } };
    writeFileSync(join(sam, ".sam", "tool-loads.json"), JSON.stringify(legacy, null, 2));
    assert.deepEqual(loadedTools(sam, "chat-a"), ["mcp_stack_health", "mcp_paper_setups"]);
    assert.deepEqual(loadedTools(sam, "chat-b"), ["sam_manage_chats"]);
    assert.deepEqual(loadedTools(sam, "chat-c"), []);
    assert.equal(existsSync(join(sam, ".sam", "tool-loads.db")), true);
    assert.equal(existsSync(join(sam, ".sam", "tool-loads.json")), false);
    assert.equal(existsSync(join(sam, ".sam", "tool-loads.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(sam, ".sam", "tool-loads.json.migrated"), "utf8")) as { chats: Record<string, string[]> };
    assert.deepEqual(Object.keys(kept.chats), ["chat-a", "chat-b"]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("tool-loads store: a malformed legacy file imports nothing and is left in place", () => {
  const { base, sam } = fresh();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    writeFileSync(join(sam, ".sam", "tool-loads.json"), "{ not json");
    assert.deepEqual(loadedTools(sam, "chat-a"), []);
    assert.equal(existsSync(join(sam, ".sam", "tool-loads.json")), true);
    assert.equal(existsSync(join(sam, ".sam", "tool-loads.json.migrated")), false);
    // A fresh record over the malformed file still works (the
    // old reader read corrupt as empty) and lands in the DB only.
    const rec = recordToolLoad(sam, "chat-a", ["sam_handoff_task"], VALID);
    assert.deepEqual(rec.loaded, ["sam_handoff_task"]);
    assert.deepEqual(loadedTools(sam, "chat-a"), ["sam_handoff_task"]);
    assert.equal(existsSync(join(sam, ".sam", "tool-loads.json")), true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("tool-loads store: a pure read on an empty install creates nothing, and neither does a no-op record", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-tool-loads-store-empty-"));
  try {
    assert.deepEqual(loadedTools(root, "chat-a"), []);
    assert.equal(existsSync(join(root, ".sam")), false);
    const unknownOnly = recordToolLoad(root, "chat-a", ["sam_nope"], VALID);
    assert.deepEqual(unknownOnly, { loaded: [], unknown: ["sam_nope"] });
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tool-loads store: interleaved records for different chats and the same chat all survive", () => {
  const { base, sam } = fresh();
  try {
    const a1 = recordToolLoad(sam, "chat-a", ["sam_handoff_task"], VALID);
    assert.deepEqual(a1.loaded, ["sam_handoff_task"]);
    const b1 = recordToolLoad(sam, "chat-b", ["mcp_stack_health"], VALID);
    assert.deepEqual(b1.loaded, ["mcp_stack_health"]);
    const a2 = recordToolLoad(sam, "chat-a", ["sam_ask_linked", "sam_handoff_task"], VALID);
    assert.deepEqual(a2.loaded, ["sam_ask_linked"]);
    assert.deepEqual(loadedTools(sam, "chat-a"), ["sam_handoff_task", "sam_ask_linked"]);
    assert.deepEqual(loadedTools(sam, "chat-b"), ["mcp_stack_health"]);
    assert.equal(existsSync(join(sam, ".sam", "tool-loads.json")), false);
    assert.equal(existsSync(join(sam, ".sam", "tool-loads.db")), true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("tool-loads store: a record over a migrated legacy file grows only that chat in the DB", () => {
  const { base, sam } = fresh();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    const legacy = { version: 1, chats: { "chat-a": ["sam_manage_chats"], "chat-b": ["mcp_stack_health"] } };
    writeFileSync(join(sam, ".sam", "tool-loads.json"), JSON.stringify(legacy, null, 2));
    const rec = recordToolLoad(sam, "chat-a", ["mcp_paper_setups"], VALID);
    assert.deepEqual(rec.loaded, ["mcp_paper_setups"]);
    assert.deepEqual(loadedTools(sam, "chat-a"), ["sam_manage_chats", "mcp_paper_setups"]);
    assert.deepEqual(loadedTools(sam, "chat-b"), ["mcp_stack_health"]);
    const again = recordToolLoad(sam, "chat-a", ["mcp_paper_setups"], VALID);
    assert.deepEqual(again.loaded, []);
    assert.deepEqual(loadedTools(sam, "chat-a"), ["sam_manage_chats", "mcp_paper_setups"]);
    assert.equal(existsSync(join(sam, ".sam", "tool-loads.json")), false);
    assert.equal(existsSync(join(sam, ".sam", "tool-loads.json.migrated")), true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
