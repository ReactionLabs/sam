import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, MEMORY_RECORD_MAX_WORDS, countWords } from "./memory.js";

// Program H item B (filed requirement 1): hot memory is an
// index with a hard per-write budget, enforced in add() itself -
// a single record larger than the whole budget is refused with
// a named error, whatever door wrote it.
function scratch(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "sam-budget-"));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("countWords counts whitespace-separated words", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("one"), 1);
  assert.equal(countWords("  one   two\nthree\t"), 3);
});

test("a record at the budget lands; one word over is refused and stores nothing", () => scratch(root => {
  const store = new MemoryStore(join(root, "missions.db"));
  try {
    const atCap = store.add({ kind: "observation", content: Array(MEMORY_RECORD_MAX_WORDS).fill("word").join(" "), source: "test", scope: "core" });
    assert.ok(atCap.id);
    assert.throws(
      () => store.add({ kind: "observation", content: Array(MEMORY_RECORD_MAX_WORDS + 1).fill("word").join(" "), source: "test", scope: "core" }),
      /hot-memory budget/,
    );
    assert.equal(store.list(undefined, ["core"]).length, 1);
  } finally { store.close(); }
}));
