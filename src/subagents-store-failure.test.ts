import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import {
  cancelSubagent, getSubagent, isSubagentsStoreLedgered, listSubagents,
  spawnSubagent, subagentsStoreFailureSummary, updateSubagent,
  type Subagent, type SubagentCompleter,
} from "./subagents.js";
import { classifyDefect } from "./self-work.js";

// Subagents store failure visibility (gap found 2026-11-16,
// hourly run 02:04): the subagents store
// (.sam/subagent-registry.db) is the sub-agent registry -
// listSubagents rides every status surface and the orphan
// sweep, readOne rides get/cancel/update, and put persists
// every spawn, finish, and fencing - and every touch opened
// it raw: a dead store threw with the seam unnamed, and a
// reader folding it as no helpers would silently empty the
// registry dressed as an idle install, freeing spawn-pool
// budget already carved. Each touch now ledgers ONE
// subagents-store-failed line (phase read / write) and
// rethrows exactly, tagged; reads still fail closed and an
// absent store still reads as no helpers.
function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-subagents-fail-")); }
const text = (content: string): SubagentCompleter => async () => ({ content, calls: [] });

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "subagents-store-failed" });
}

function record(id: string, extra: Partial<Subagent> = {}): Subagent {
  return {
    id, profile: "sam", parentId: null, depth: 1, prompt: "secret helper prompt", tools: ["sam_memory_list"],
    budget: { rounds: 1, maxCalls: 1 }, status: "done", result: "secret helper result", loopId: null,
    createdAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:01:00.000Z", chatId: null,
    role: "research", quiet: false, ...extra,
  };
}

function seedRow(root: string, item: Subagent): void {
  mkdirSync(join(root, ".sam"), { recursive: true });
  const db = openDatabase(join(root, ".sam", "subagent-registry.db"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS subagents (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO subagents (id, data) VALUES (?, ?)").run(item.id, JSON.stringify(item));
  } finally { db.close(); }
}

async function seedSpawned(root: string): Promise<Subagent> {
  return spawnSubagent(root, { profile: "sam", prompt: "seed helper", tools: ["sam_memory_list"], rounds: 1, maxCalls: 1 }, { complete: text("seed done") });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "subagent-registry.db"), { force: true });
  rmSync(join(root, ".sam", "subagent-registry.db-wal"), { force: true });
  rmSync(join(root, ".sam", "subagent-registry.db-shm"), { force: true });
  mkdirSync(join(root, ".sam", "subagent-registry.db"), { recursive: true });
}

test("subagents-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(subagentsStoreFailureSummary("read", "unable to open\n  database   file"), "Subagents store read failed: unable to open database file");
  assert.equal(subagentsStoreFailureSummary("write", "disk gone"), "Subagents store write failed: disk gone");
  assert.equal(subagentsStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "subagents-store-failed", summary: subagentsStoreFailureSummary(phase, "boom") }),
      { key: "subagents-store-failed:" + phase, label: "subagents store failures (" + phase + " step)" },
    );
  }
});

test("subagents-store-failed: healthy spawn, read-back, update, and cancel ledger no failure line", async () => {
  const root = fresh();
  try {
    const spawned = await seedSpawned(root);
    assert.equal(getSubagent(root, spawned.id)?.result, "seed done");
    const patched = updateSubagent(root, spawned.id, { result: "corrected" });
    assert.equal(patched?.result, "corrected");
    seedRow(root, record("sub-running", { status: "running", result: null, finishedAt: null }));
    const cancelled = cancelSubagent(root, "sub-running");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(listSubagents(root).length, 2);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subagents-store-failed: an absent store reads as no helpers, creates nothing, and ledgers nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(listSubagents(root), []);
    assert.equal(getSubagent(root, "nope"), null);
    assert.equal(updateSubagent(root, "nope", { status: "done" }), null);
    assert.throws(() => cancelSubagent(root, "nope"), /Unknown sub-agent/, "a validation refusal is not a store failure");
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing, not even the .sam directory");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subagents-store-failed: a torn row still parses forgiving and ledgers nothing", () => {
  const root = fresh();
  try {
    seedRow(root, record("sub-a"));
    const db = openDatabase(join(root, ".sam", "subagent-registry.db"));
    try { db.prepare("UPDATE subagents SET data = ? WHERE id = ?").run("{ not json", "sub-a"); } finally { db.close(); }
    assert.deepEqual(listSubagents(root), [], "the torn row reads as no helpers, never fatal");
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subagents-store-failed: a malformed legacy file imports nothing and ledgers nothing", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "subagents.json"), "{ not json");
    assert.deepEqual(listSubagents(root), []);
    assert.equal(failedLines(root).length, 0, "a forgiving import is not a store failure");
    assert.equal(existsSync(join(root, ".sam", "subagents.json")), true, "the malformed file is left in place");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subagents-store-failed: a dead store ledgers exactly one line per touch, tagged, rethrows, and carries no helper content", async () => {
  const root = fresh();
  try {
    const spawned = await seedSpawned(root);
    plantDeadStore(root);

    assert.throws(() => listSubagents(root), (e: unknown) => isSubagentsStoreLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Subagents store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "subagents-store-failed:read", label: "subagents store failures (read step)" });

    assert.throws(() => updateSubagent(root, spawned.id, { result: "x" }), (e: unknown) => isSubagentsStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "update dies at its inner readOne read with exactly one line, never two for one touch");
    assert.ok(lines[1].summary.startsWith("Subagents store read failed: "), lines[1].summary);

    assert.throws(() => cancelSubagent(root, spawned.id), (e: unknown) => isSubagentsStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3, "cancel dies at its inner readOne read with exactly one line, never two for one touch");
    assert.ok(lines[2].summary.startsWith("Subagents store read failed: "), lines[2].summary);

    assert.ok(!JSON.stringify(lines).includes("seed helper"), "no helper prompt ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("seed done"), "no helper result ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes(spawned.id), "no helper id ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subagents-store-failed: a failing update write ledgers exactly one write line with the verbatim reason", () => {
  const root = fresh();
  try {
    seedRow(root, record("sub-a"));
    const raw = openDatabase(join(root, ".sam", "subagent-registry.db"));
    try {
      raw.exec("CREATE TRIGGER planted_subagent_insert_fail BEFORE INSERT ON subagents BEGIN SELECT RAISE(ABORT, 'planted subagent write failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => updateSubagent(root, "sub-a", { result: "corrected" }), (e: unknown) => isSubagentsStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the write touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Subagents store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted subagent write failure"), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "subagents-store-failed:write", label: "subagents store failures (write step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subagents-store-failed: a failing cancel write ledgers exactly one write line with the verbatim reason", () => {
  const root = fresh();
  try {
    seedRow(root, record("sub-running", { status: "running", result: null, finishedAt: null }));
    const raw = openDatabase(join(root, ".sam", "subagent-registry.db"));
    try {
      raw.exec("CREATE TRIGGER planted_subagent_insert_fail BEFORE INSERT ON subagents BEGIN SELECT RAISE(ABORT, 'planted subagent write failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => cancelSubagent(root, "sub-running"), (e: unknown) => isSubagentsStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the cancel write ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Subagents store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted subagent write failure"), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
