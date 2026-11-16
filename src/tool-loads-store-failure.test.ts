import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import {
  isToolLoadsStoreLedgered, loadedTools, recordToolLoad,
  toolLoadsStoreFailureSummary, touchToolLoads,
} from "./tool-tiers.js";
import { classifyDefect } from "./self-work.js";

// Tool-loads store failure visibility (gap found 2026-11-16,
// hourly run 01:04): the tool-loads store (.sam/tool-loads.db)
// is the per-chat loaded set for deferred tool tiering -
// loadedTools rides every tiered turn on both chat loops,
// recordToolLoad persists a fresh load, and touchToolLoads
// rotates a re-load - and every touch opened it raw: a dead
// store threw with the seam unnamed, and a reader folding it
// as no loads would silently unload every tool a chat
// already loaded dressed as a fresh session. Each touch now
// ledgers ONE tool-loads-store-failed line (phase read /
// write) and rethrows exactly, tagged; reads still fail
// closed and an absent store still reads as no loads.
function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-tool-loads-fail-")); }

const VALID = new Set(["sam_handoff_task", "sam_ask_linked", "sam_manage_chats"]);

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "tool-loads-store-failed" });
}

function seed(root: string): void {
  assert.deepEqual(recordToolLoad(root, "chat-a", ["sam_handoff_task", "sam_ask_linked"], VALID).loaded, ["sam_handoff_task", "sam_ask_linked"]);
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "tool-loads.db"), { force: true });
  mkdirSync(join(root, ".sam", "tool-loads.db"), { recursive: true });
}

test("tool-loads-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(toolLoadsStoreFailureSummary("read", "unable to open\n  database   file"), "Tool loads store read failed: unable to open database file");
  assert.equal(toolLoadsStoreFailureSummary("write", "disk gone"), "Tool loads store write failed: disk gone");
  assert.equal(toolLoadsStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "tool-loads-store-failed", summary: toolLoadsStoreFailureSummary(phase, "boom") }),
      { key: "tool-loads-store-failed:" + phase, label: "tool loads store failures (" + phase + " step)" },
    );
  }
});

test("tool-loads-store-failed: healthy record, read-back, and touch ledger no failure line", () => {
  const root = fresh();
  try {
    seed(root);
    assert.deepEqual(loadedTools(root, "chat-a"), ["sam_handoff_task", "sam_ask_linked"]);
    touchToolLoads(root, "chat-a", ["sam_handoff_task"]);
    assert.deepEqual(loadedTools(root, "chat-a"), ["sam_ask_linked", "sam_handoff_task"]);
    assert.deepEqual(recordToolLoad(root, "chat-a", ["sam_manage_chats"], VALID).loaded, ["sam_manage_chats"]);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tool-loads-store-failed: an absent store reads as no loads, creates nothing, and ledgers nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(loadedTools(root, "chat-a"), []);
    assert.deepEqual(recordToolLoad(root, "chat-a", ["sam_nope"], VALID), { loaded: [], unknown: ["sam_nope"] });
    touchToolLoads(root, "chat-a", ["sam_handoff_task"]);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing, not even the .sam directory");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tool-loads-store-failed: a torn row still parses forgiving and ledgers nothing", () => {
  const root = fresh();
  try {
    seed(root);
    const db = openDatabase(join(root, ".sam", "tool-loads.db"));
    try { db.prepare("UPDATE tool_loads SET data = ? WHERE chat_id = ?").run("{ not json", "chat-a"); } finally { db.close(); }
    assert.deepEqual(loadedTools(root, "chat-a"), [], "the torn row reads as no loads, never fatal");
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tool-loads-store-failed: a malformed legacy file imports nothing and ledgers nothing", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "tool-loads.json"), "{ not json");
    assert.deepEqual(loadedTools(root, "chat-a"), []);
    assert.equal(failedLines(root).length, 0, "a forgiving import is not a store failure");
    assert.equal(existsSync(join(root, ".sam", "tool-loads.json")), true, "the malformed file is left in place");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tool-loads-store-failed: a dead store ledgers exactly one line per touch, tagged, rethrows, and carries no session content", () => {
  const root = fresh();
  try {
    seed(root);
    plantDeadStore(root);

    assert.throws(() => loadedTools(root, "chat-a"), (e: unknown) => isToolLoadsStoreLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Tool loads store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "tool-loads-store-failed:read", label: "tool loads store failures (read step)" });

    assert.throws(() => recordToolLoad(root, "chat-a", ["sam_manage_chats"], VALID), (e: unknown) => isToolLoadsStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "record dies at its inner current-set read with exactly one line, never two for one touch");
    assert.ok(lines[1].summary.startsWith("Tool loads store read failed: "), lines[1].summary);

    assert.throws(() => touchToolLoads(root, "chat-a", ["sam_handoff_task"]), (e: unknown) => isToolLoadsStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3, "touch dies at its inner current-set read with exactly one line, never two for one touch");
    assert.ok(lines[2].summary.startsWith("Tool loads store read failed: "), lines[2].summary);

    assert.ok(!JSON.stringify(lines).includes("chat-a"), "no chat id ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("sam_handoff_task"), "no loaded tool name ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tool-loads-store-failed: a failing record write ledgers exactly one write line with the verbatim reason", () => {
  const root = fresh();
  try {
    seed(root);
    const raw = openDatabase(join(root, ".sam", "tool-loads.db"));
    try {
      raw.exec("CREATE TRIGGER planted_tool_load_insert_fail BEFORE INSERT ON tool_loads BEGIN SELECT RAISE(ABORT, 'planted tool load write failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => recordToolLoad(root, "chat-b", ["sam_manage_chats"], VALID), (e: unknown) => isToolLoadsStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the write touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Tool loads store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted tool load write failure"), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "tool-loads-store-failed:write", label: "tool loads store failures (write step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tool-loads-store-failed: a failing touch write ledgers exactly one write line with the verbatim reason", () => {
  const root = fresh();
  try {
    seed(root);
    const raw = openDatabase(join(root, ".sam", "tool-loads.db"));
    try {
      raw.exec("CREATE TRIGGER planted_tool_load_insert_fail BEFORE INSERT ON tool_loads BEGIN SELECT RAISE(ABORT, 'planted tool load write failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => touchToolLoads(root, "chat-a", ["sam_handoff_task"]), (e: unknown) => isToolLoadsStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the touch write ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Tool loads store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted tool load write failure"), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
