import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./memory.js";
import { recallMemory } from "./memory-recall.js";

test("opt-in recall survives SQLite reopen and labels records as untrusted", () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-recall-"));
  const path = join(dir, "memory.db");
  try {
    const store = new MemoryStore(path);
    store.add({ kind: "observation", content: "Workspace uses TypeScript", source: "owner-test" });
    store.close();
    const context = recallMemory(path);
    assert.equal(context?.role, "system");
    assert.match(context?.content ?? "", /UNTRUSTED DATA/);
    assert.match(context?.content ?? "", /Workspace uses TypeScript/);
    assert.match(context?.content ?? "", /owner-test/);
    assert.throws(() => recallMemory(path, 21), /Invalid memory recall limit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recall returns no message for an empty workspace memory database", () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-recall-empty-"));
  try { assert.equal(recallMemory(join(dir, "memory.db")), undefined); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
