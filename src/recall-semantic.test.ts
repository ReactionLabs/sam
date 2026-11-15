import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, validateMemoryAliases } from "./memory.js";
import { buildRecallBlock, semanticRecallHits, semanticScore, expandedQueryStems } from "./recall.js";

function scratch(fn: (root: string, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sam-q1-"));
  try { fn(dir, join(dir, ".sam", "missions.db")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("aliases validate, dedupe, and refuse bad shapes", () => {
  assert.deepEqual(validateMemoryAliases(["Morning Drink", " morning  drink ", "car care"]), ["Morning Drink", "car care"]);
  assert.deepEqual(validateMemoryAliases(undefined), []);
  assert.throws(() => validateMemoryAliases(["ab"]), /Invalid memory alias/);
  assert.throws(() => validateMemoryAliases("morning drink"), /expected a list/);
  assert.throws(() => validateMemoryAliases(Array.from({ length: 9 }, (_, i) => "alias " + i)), /at most 8/);
});

test("aliases round-trip through add, get, list, search, and setAliases", () => {
  scratch((_root, path) => {
    const store = new MemoryStore(path);
    try {
      const rec = store.add({ kind: "observation", content: "Dip prefers a cortado, made with two shots.", source: "test", aliases: ["morning drink order"] });
      assert.deepEqual(rec.aliases, ["morning drink order"]);
      assert.deepEqual(store.get(rec.id)?.aliases, ["morning drink order"]);
      assert.deepEqual(store.list()[0].aliases, ["morning drink order"]);
      assert.deepEqual(store.search("cortado")[0].aliases, ["morning drink order"]);
      const updated = store.setAliases(rec.id, ["coffee order", "morning drink order"]);
      assert.deepEqual(updated?.aliases, ["coffee order", "morning drink order"]);
      assert.deepEqual(store.get(rec.id)?.aliases, ["coffee order", "morning drink order"]);
      assert.equal(store.setAliases("no-such-id", ["valid phrase"]), null);
      assert.throws(() => store.setAliases(rec.id, ["x"]), /Invalid memory alias/);
    } finally { store.close(); }
    const reopened = new MemoryStore(path);
    try { assert.deepEqual(reopened.list()[0].aliases, ["coffee order", "morning drink order"]); }
    finally { reopened.close(); }
  });
});

test("a record with no aliases reads back an empty list on a legacy-shaped store", () => {
  scratch((_root, path) => {
    const store = new MemoryStore(path);
    try {
      const rec = store.add({ kind: "observation", content: "A plain record with no aliases.", source: "test" });
      assert.deepEqual(rec.aliases, []);
      assert.deepEqual(store.get(rec.id)?.aliases, []);
    } finally { store.close(); }
  });
});

test("semantic recall surfaces a reworded topic through its alias, keyword words absent", () => {
  scratch((root, path) => {
    const store = new MemoryStore(path);
    try {
      store.add({ kind: "observation", content: "Dip prefers a cortado, made with two shots.", source: "test", scope: "core", aliases: ["morning drink order"] });
      const hits = semanticRecallHits(store, "what is my morning drink order?", ["core"]);
      assert.equal(hits.length, 1);
      assert.match(hits[0].content, /cortado/);
    } finally { store.close(); }
    const block = buildRecallBlock(root, { actor: "sam", message: "what is my morning drink order?" });
    assert.match(block, /cortado/);
  });
});

test("semantic recall matches synonyms and stems with no alias at all", () => {
  scratch((_root, path) => {
    const store = new MemoryStore(path);
    try {
      const rec = store.add({ kind: "observation", content: "The automobile needs servicing before the long trip.", source: "test", scope: "core" });
      const hits = semanticRecallHits(store, "when does the car need maintenance?", ["core"]);
      assert.deepEqual(hits.map(h => h.id), [rec.id]);
    } finally { store.close(); }
  });
});

test("a single shared content word is too weak for the semantic path", () => {
  scratch((_root, path) => {
    const store = new MemoryStore(path);
    try {
      store.add({ kind: "observation", content: "The trip begins on Friday at dawn.", source: "test", scope: "core" });
      assert.deepEqual(semanticRecallHits(store, "what time is the trip?", ["core"]), []);
      assert.ok(semanticScore({ id: "x", mission_id: null, kind: "observation", content: "The trip begins Friday.", source: "t", source_hash: "h", created_at: "", archived_at: null, scope: "core", aliases: [] }, "trip", expandedQueryStems("trip")) < 3);
    } finally { store.close(); }
  });
});

test("semantic recall keeps the scope fence: another profile's alias record never surfaces", () => {
  scratch((root, path) => {
    const store = new MemoryStore(path);
    try {
      store.add({ kind: "observation", content: "The zorblax harvest runs on Thursdays.", source: "test", scope: "profile:other", aliases: ["harvest day"] });
    } finally { store.close(); }
    const block = buildRecallBlock(root, { actor: "dip", message: "when is harvest day, the zorblax harvest?" });
    assert.doesNotMatch(block, /zorblax/);
  });
});

test("keyword hits keep priority and semantic hits merge without duplicates", () => {
  scratch((root, path) => {
    const store = new MemoryStore(path);
    try {
      store.add({ kind: "observation", content: "The paper trading briefing format is counts first.", source: "test", scope: "core", aliases: ["paper trading briefing"] });
      store.add({ kind: "observation", content: "Dip prefers a cortado, made with two shots.", source: "test", scope: "core", aliases: ["paper trading briefing notes"] });
    } finally { store.close(); }
    const block = buildRecallBlock(root, { actor: "sam", message: "what did we settle for the paper trading briefing?" });
    const lines = block.split("\n").filter(l => l.startsWith("- ["));
    assert.equal(new Set(lines).size, lines.length);
    assert.match(lines[0], /paper trading briefing format/);
  });
});
