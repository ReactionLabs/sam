import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBoxStores } from "./box-stores.js";

test("two SAM boxes keep missions and memory separate across reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-box-stores-"));
  try {
    const a = openBoxStores(root, "owner-one", "website");
    const b = openBoxStores(root, "owner-one", "trading");
    const c = openBoxStores(root, "owner-two", "website");
    try {
      assert.notEqual(a.storage.database, b.storage.database);
      assert.notEqual(a.storage.database, c.storage.database);
      const mission = a.missions.create("Build a website");
      a.memory.add({ kind: "decision", content: "Use a test tenant", source: "owner-confirmed" });
      b.missions.create("Paper-trade only");
      b.memory.add({ kind: "observation", content: "Paper account", source: "test" });
      assert.equal(a.missions.list().length, 1);
      assert.equal(b.missions.list().length, 1);
      assert.equal(c.missions.list().length, 0);
      assert.equal(b.missions.get(mission.id), undefined);
      assert.equal(c.missions.get(mission.id), undefined);
      assert.equal(a.memory.list().length, 1);
      assert.equal(b.memory.list().length, 1);
      assert.equal(c.memory.list().length, 0);
      assert.equal(b.memory.search("tenant").length, 0);
      assert.equal(c.memory.search("tenant").length, 0);
    } finally {
      a.close(); b.close(); c.close();
    }
    const reopened = openBoxStores(root, "owner-one", "website");
    const other = openBoxStores(root, "owner-one", "trading");
    try {
      assert.equal(reopened.missions.list()[0]?.objective, "Build a website");
      assert.equal(reopened.memory.list()[0]?.content, "Use a test tenant");
      assert.equal(other.missions.list()[0]?.objective, "Paper-trade only");
      assert.equal(other.memory.list()[0]?.content, "Paper account");
      assert.equal(other.memory.search("tenant").length, 0);
    } finally { reopened.close(); other.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid box identifiers cannot open stores or fall back to legacy database", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-box-invalid-"));
  try {
    assert.throws(() => openBoxStores(root, "../owner", "website"), /Invalid owner ID/);
    assert.throws(() => openBoxStores(root, "owner", "../instance"), /Invalid instance ID/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
