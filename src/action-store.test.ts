import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAction, listActions, proposeAction } from "./actions.js";

// State convergence (UNIFICATION item 4): the ONE gate's store migrated
// from whole-file actions.json rewrites to one-row-per-proposal SQLite.
// These tests pin the migration contract: legacy files import in order
// with their defaults, are renamed (never deleted), a malformed file
// imports nothing and stays put, a pure read creates nothing, and
// interleaved writers cannot lose each other's records.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-action-store-")); }

function legacyRecord(id: string, title: string): Record<string, unknown> {
  return { id, actor: "sam", kind: "note", title, detail: "detail " + title, status: "pending", createdAt: "2026-11-09T00:00:00.000Z", decidedAt: null, result: null, chatId: null };
}

test("action store: a legacy actions.json imports in order, defaults applied, file renamed not deleted", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "actions.json"), JSON.stringify([legacyRecord("a-1", "first"), legacyRecord("a-2", "second")], null, 2));
    const items = listActions(root);
    assert.deepEqual(items.map(x => x.id), ["a-1", "a-2"]);
    assert.equal(items[0].supersedes, null);
    assert.equal(items[0].risk, null);
    assert.equal(items[0].decidedBy, null);
    assert.equal(existsSync(join(root, ".sam", "actions.db")), true);
    assert.equal(existsSync(join(root, ".sam", "actions.json")), false);
    assert.equal(existsSync(join(root, ".sam", "actions.json.migrated")), true);
    // The migrated copy still holds the original records.
    const kept = JSON.parse(readFileSync(join(root, ".sam", "actions.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    // New writes ride the DB and never recreate the JSON file.
    const added = proposeAction(root, { actor: "sam", kind: "note", title: "third", detail: "a fresh note" });
    assert.deepEqual(listActions(root).map(x => x.id), ["a-1", "a-2", added.id]);
    assert.equal(existsSync(join(root, ".sam", "actions.json")), false);
    const done = await decideAction(root, "a-1", false);
    assert.equal(done.status, "rejected");
    assert.equal(listActions(root).find(x => x.id === "a-1")?.status, "rejected");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("action store: a malformed legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "actions.json"), "{ not json");
    assert.deepEqual(listActions(root), []);
    assert.equal(existsSync(join(root, ".sam", "actions.json")), true);
    assert.equal(existsSync(join(root, ".sam", "actions.json.migrated")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("action store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(listActions(root), []);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("action store: interleaved proposes and a decision all survive (no whole-file lost update)", async () => {
  const root = fresh();
  try {
    const a = proposeAction(root, { actor: "sam", kind: "note", title: "one", detail: "first note" });
    const b = proposeAction(root, { actor: "sam", kind: "note", title: "two", detail: "second note" });
    await decideAction(root, a.id, true);
    const items = listActions(root);
    assert.equal(items.length, 2);
    assert.equal(items.find(x => x.id === a.id)?.status, "done");
    assert.equal(items.find(x => x.id === b.id)?.status, "pending");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
