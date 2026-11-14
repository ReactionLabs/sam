import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSubagent, listSubagents, spawnSubagent, updateSubagent, type Subagent, type SubagentCompleter } from "./subagents.js";

// State convergence (UNIFICATION item 4, thirty-third store): the
// sub-agent registry migrated from whole-file subagents.json
// rewrites to one-row-per-record SQLite (.sam/subagent-registry.db
// - a separate file from the AgentLoopJournal's subagents.db).
// These tests pin the migration contract: legacy files import in
// order with every field intact (legacy role/quiet defaults
// applied), are renamed (never deleted), a malformed file imports
// nothing and stays put, a pure read creates nothing, single-row
// mutations cannot lose each other, and the orphan sweep over a
// migrated legacy record persists its interruption in the DB.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-subagents-store-")); }
const text = (content: string): SubagentCompleter => async () => ({ content, calls: [] });

function legacySub(id: string, prompt: string, extra: Partial<Subagent> = {}): Subagent {
  return {
    id, profile: "sam", parentId: null, depth: 1, prompt, tools: ["sam_memory_list"],
    budget: { rounds: 1, maxCalls: 1 }, status: "done", result: "finished", loopId: null,
    createdAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:01:00.000Z", chatId: null,
    role: "research", quiet: false, ...extra,
  };
}

test("subagents store: a legacy subagents.json imports in order, fields intact, file renamed not deleted", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const done = legacySub("sub-1", "first helper");
    const bare = legacySub("sub-2", "second helper", { status: "failed", result: "boom" });
    delete (bare as Partial<Subagent>).role;
    delete (bare as Partial<Subagent>).quiet;
    writeFileSync(join(root, ".sam", "subagents.json"), JSON.stringify([done, bare], null, 2));
    const items = listSubagents(root);
    assert.deepEqual(items.map(s => s.id), ["sub-1", "sub-2"]);
    assert.deepEqual(items[0], done);
    // The legacy defaults read() always applied ride the import:
    // a missing role reads "task", quiet is true only when true.
    assert.equal(items[1].role, "task");
    assert.equal(items[1].quiet, false);
    assert.equal(existsSync(join(root, ".sam", "subagent-registry.db")), true);
    assert.equal(existsSync(join(root, ".sam", "subagents.json")), false);
    assert.equal(existsSync(join(root, ".sam", "subagents.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "subagents.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    // The journal's own database is a different file and is not
    // the registry: it appears only when a loop is created.
    // New spawns ride the DB and never recreate the JSON file.
    const added = await spawnSubagent(root, { profile: "sam", prompt: "third helper", tools: ["sam_memory_list"], rounds: 1, maxCalls: 1 }, { complete: text("third done") });
    assert.deepEqual(listSubagents(root).map(s => s.id), ["sub-1", "sub-2", added.id]);
    assert.equal(getSubagent(root, added.id)?.result, "third done");
    assert.equal(existsSync(join(root, ".sam", "subagents.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subagents store: a malformed or non-array legacy file imports nothing and is left in place", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "subagents.json"), "{ not json");
    assert.deepEqual(listSubagents(root), []);
    assert.equal(existsSync(join(root, ".sam", "subagents.json")), true);
    assert.equal(existsSync(join(root, ".sam", "subagents.json.migrated")), false);
    writeFileSync(join(root, ".sam", "subagents.json"), JSON.stringify({ nope: true }));
    assert.deepEqual(listSubagents(root), []);
    assert.equal(existsSync(join(root, ".sam", "subagents.json.migrated")), false);
    // A spawn over the unimportable file rides the DB only.
    const added = await spawnSubagent(root, { profile: "sam", prompt: "over malformed", tools: ["sam_memory_list"], rounds: 1, maxCalls: 1 }, { complete: text("ok") });
    assert.equal(getSubagent(root, added.id)?.status, "done");
    assert.equal(existsSync(join(root, ".sam", "subagents.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subagents store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(listSubagents(root), []);
    assert.equal(getSubagent(root, "nope"), null);
    assert.equal(updateSubagent(root, "nope", { status: "done" }), null);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subagents store: interleaved spawns and a single-row update all survive (no whole-file lost update)", async () => {
  const root = fresh();
  try {
    const a = await spawnSubagent(root, { profile: "sam", prompt: "alpha", tools: ["sam_memory_list"], rounds: 1, maxCalls: 1 }, { complete: text("alpha done") });
    const b = await spawnSubagent(root, { profile: "sam", prompt: "beta", tools: ["sam_memory_list"], rounds: 1, maxCalls: 1 }, { complete: text("beta done") });
    const patched = updateSubagent(root, a.id, { result: "alpha corrected" });
    assert.equal(patched?.result, "alpha corrected");
    assert.equal(patched?.id, a.id);
    assert.equal(updateSubagent(root, "ghost", { result: "x" }), null);
    const items = listSubagents(root);
    assert.deepEqual(items.map(s => s.id), [a.id, b.id]);
    assert.equal(items[0].result, "alpha corrected");
    assert.equal(items[1].result, "beta done");
    assert.equal(getSubagent(root, b.id)?.prompt, "beta");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subagents store: the orphan sweep over a migrated legacy record persists interrupted in the DB", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const orphan = legacySub("sub-orphan", "left running", { status: "running", result: null, finishedAt: null, loopId: null });
    writeFileSync(join(root, ".sam", "subagents.json"), JSON.stringify([orphan], null, 2));
    const listed = listSubagents(root);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, "interrupted");
    assert.match(listed[0].result ?? "", /inspect evidence before resuming/);
    // The interruption is the DB row's state, not a re-sweep: a
    // second list reads the same terminal record back.
    assert.equal(getSubagent(root, "sub-orphan")?.status, "interrupted");
    assert.equal(existsSync(join(root, ".sam", "subagents.json")), false);
    assert.equal(existsSync(join(root, ".sam", "subagent-registry.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
