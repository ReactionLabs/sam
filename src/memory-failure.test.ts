import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import { MemoryStore, memoryStoreFailureSummary, memoryStoreLedgerRoot, isMemoryStoreLedgered } from "./memory.js";
import { classifyDefect } from "./self-work.js";

// Memory store failure visibility (gap found 2026-11-15,
// hourly run 11:04): the MemoryStore riding missions.db
// touched its file raw - the constructor's schema exec and
// migrations plus add / setAliases / list / search / get /
// archive threw into whichever catch wrapped the call with
// the seam unnamed. Each touch now ledgers ONE
// memory-store-failed line (constructor open at phase
// write, reads at phase read, mutations at phase write) and
// rethrows exactly, tagged, when the store path names an
// install (<root>/.sam/...); every caller's handling is
// unchanged and reads still fail closed (never folded as no
// memory, which would silently empty SAM's curated memory
// dressed as an install that remembers nothing). A
// bare-path construction has no install ledger and rethrows
// bare.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-memory-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "memory-store-failed" });
}

function dbPath(root: string): string {
  return join(root, ".sam", "missions.db");
}

test("memory-store-failed: summary shapes collapse and cap the reason, ledger root derives only from a .sam path, and self-work classifies by phase", () => {
  assert.equal(memoryStoreFailureSummary("read", "unable to open\n  database   file"), "Memory store read failed: unable to open database file");
  assert.equal(memoryStoreFailureSummary("write", "disk gone"), "Memory store write failed: disk gone");
  assert.equal(memoryStoreFailureSummary("write", "x".repeat(500)).length, 200);
  assert.equal(memoryStoreLedgerRoot(join("/home", "sam", ".sam", "missions.db")), join("/home", "sam"));
  assert.equal(memoryStoreLedgerRoot(join("/home", "sam", "missions.db")), null);
  assert.equal(memoryStoreLedgerRoot(join("/home", "sam", ".sam")), null);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "memory-store-failed", summary: memoryStoreFailureSummary(phase, "boom") }),
      { key: "memory-store-failed:" + phase, label: "memory store failures (" + phase + " step)" },
    );
  }
});

test("memory-store-failed: a healthy round trip ledgers nothing", () => {
  const root = scratch();
  try {
    const store = new MemoryStore(dbPath(root));
    try {
      const rec = store.add({ kind: "observation", content: "Dip prefers a cortado.", source: "test", scope: "core", aliases: ["morning drink order"] });
      assert.equal(store.list(undefined, ["core"]).length, 1);
      assert.equal(store.get(rec.id)?.content, "Dip prefers a cortado.");
      assert.equal(store.search("cortado").length, 1);
      const updated = store.setAliases(rec.id, ["coffee order"]);
      assert.deepEqual(updated?.aliases, ["coffee order"]);
      assert.equal(store.archive(rec.id), true);
      assert.equal(store.list(undefined, ["core"]).length, 0);
    } finally { store.close(); }
    assert.equal(failedLines(root).length, 0);
    assert.equal(existsSync(join(root, ".sam", "activity.jsonl")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("memory-store-failed: a dead store at construction ledgers exactly one write line, tagged, and rethrows; a bare path rethrows bare", () => {
  const root = scratch();
  try {
    mkdirSync(dbPath(root), { recursive: true });
    assert.throws(() => new MemoryStore(dbPath(root)), (e: unknown) => isMemoryStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Memory store write failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "memory-store-failed:write", label: "memory store failures (write step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }

  const bare = scratch();
  try {
    const barePath = join(bare, "missions.db");
    mkdirSync(barePath, { recursive: true });
    assert.throws(() => new MemoryStore(barePath), (e: unknown) => !isMemoryStoreLedgered(e));
    assert.equal(existsSync(join(bare, ".sam", "activity.jsonl")), false);
  } finally { rmSync(bare, { recursive: true, force: true }); }
});

test("memory-store-failed: a dead read ledgers one read line per touch, a dead write one write line, and no record content enters any line", () => {
  const root = scratch();
  try {
    const store = new MemoryStore(dbPath(root));
    const rec = store.add({ kind: "observation", content: "A Secret That Must Not Leak", source: "test", scope: "core" });
    const raw = openDatabase(dbPath(root));
    try { raw.exec("ALTER TABLE memory_records RENAME TO memory_records_gone"); } finally { raw.close(); }

    assert.throws(() => store.list(), (e: unknown) => isMemoryStoreLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Memory store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "memory-store-failed:read", label: "memory store failures (read step)" });

    assert.throws(() => store.add({ kind: "observation", content: "another record", source: "test", scope: "core" }), (e: unknown) => isMemoryStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "one line per failed touch");
    assert.ok(lines[1].summary.startsWith("Memory store write failed: "), lines[1].summary);

    // setAliases rides an inner get: the inner read touch
    // ledgers once and the outer write touch adds no second
    // line for the same failure.
    assert.throws(() => store.setAliases(rec.id, ["coffee order"]), (e: unknown) => isMemoryStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3, "the nested touch ledgers exactly one line");
    assert.ok(lines[2].summary.startsWith("Memory store read failed: "), lines[2].summary);

    store.close();
    assert.ok(!JSON.stringify(lines).includes("A Secret That Must Not Leak"), "no memory content ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("memory-store-failed: validation errors ledger nothing", () => {
  const root = scratch();
  try {
    const store = new MemoryStore(dbPath(root));
    try {
      assert.throws(() => store.add({ kind: "bogus" as never, content: "x", source: "test" }), /Invalid memory kind/);
      assert.throws(() => store.add({ kind: "observation", content: "   ", source: "test" }), /Memory requires content and provenance/);
      assert.throws(() => store.add({ kind: "observation", content: "x", source: "test", scope: "nowhere" }), /Invalid memory scope/);
      assert.throws(() => store.add({ kind: "observation", content: "x", source: "test", aliases: ["!!"] }), /Invalid memory alias/);
      assert.throws(() => store.search("cortado", 0), /Invalid result limit/);
      const rec = store.add({ kind: "observation", content: "a real record", source: "test", scope: "core" });
      assert.throws(() => store.setAliases(rec.id, ["!!"]), /Invalid memory alias/);
    } finally { store.close(); }
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
