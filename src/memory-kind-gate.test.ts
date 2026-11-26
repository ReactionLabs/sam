import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_KINDS, MemoryStore, memoryKindBlocker } from "./memory.js";
import { saveNote } from "./notes.js";
import { listActions } from "./actions.js";

// The memory-kind gate: the memory kind is a registry name
// (MEMORY_KINDS in memory.ts: observation, decision,
// failure, procedure) that a person types at two CLI doors
// (`notes save --kind` and `memory add <kind>`) and the
// model names in the chat note tool. The registry was
// enforced at two seams in two improvised texts, neither
// offering a fold correction: MemoryStore.add threw
// "Invalid memory kind. Choose ..." and saveNote threw
// "Invalid note kind. Choose ...". memoryKindBlocker in
// memory.ts is now the ONE source carrying the refusal
// text; MemoryStore.add throws it (the seam every writer
// rides) and saveNote throws it before its tier
// classification (a hard-tier note routes to the gate
// without touching the store). Stored-kind readers stay
// permissive by design (a kind removed after a record
// names it leaves the record readable).

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "sam-memory-kind-gate-"));
}

test("memory kind gate: every exact kind reads no blocker", () => {
  for (const kind of MEMORY_KINDS) assert.equal(memoryKindBlocker(kind), null, kind);
  assert.equal(MEMORY_KINDS.length, 4);
});

test("memory kind gate: an unknown kind names the kinds, no correction", () => {
  assert.equal(
    memoryKindBlocker("law"),
    "Invalid memory kind \"law\". Kinds: observation, decision, failure, procedure",
  );
});

test("memory kind gate: a folded name is refused with the correction", () => {
  assert.match(memoryKindBlocker("Observation")!, /Did you mean "observation"\?$/);
  assert.match(memoryKindBlocker("DECISION")!, /Did you mean "decision"\?$/);
  assert.match(memoryKindBlocker("pro-cedure")!, /Did you mean "procedure"\?$/);
  assert.match(memoryKindBlocker("pro cedure")!, /Did you mean "procedure"\?$/);
});

test("memory kind gate: a non-string value refuses naming the registry, no correction", () => {
  assert.equal(memoryKindBlocker(42), "Invalid memory kind \"42\". Kinds: observation, decision, failure, procedure");
  assert.equal(memoryKindBlocker(""), "Invalid memory kind \"\". Kinds: observation, decision, failure, procedure");
});

test("memory kind gate: both seams throw the ONE source and create nothing; an exact kind still writes", () => {
  const root = fresh();
  try {
    const store = new MemoryStore(join(root, ".sam", "missions.db"));
    try {
      assert.throws(
        () => store.add({ kind: "pro-cedure" as never, content: "x", source: "test" }),
        (e: unknown) => e instanceof Error && e.message === memoryKindBlocker("pro-cedure"),
      );
      assert.equal(store.list().length, 0);
      const ok = store.add({ kind: "procedure", content: "x", source: "test" });
      assert.equal(ok.kind, "procedure");
      assert.equal(store.list().length, 1);
    } finally { store.close(); }
    assert.throws(
      () => saveNote(root, { actor: "sam", content: "fine", kind: "Observation" }),
      (e: unknown) => e instanceof Error && e.message === memoryKindBlocker("Observation"),
    );
    assert.throws(
      () => saveNote(root, { actor: "sam", content: "fine", kind: "law" }),
      (e: unknown) => e instanceof Error && e.message === memoryKindBlocker("law"),
    );
    assert.equal(listActions(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
