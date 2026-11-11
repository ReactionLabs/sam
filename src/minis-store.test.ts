import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minis, removeMini, spawnMini, updateMini, type Mini } from "./minis.js";

// State convergence (UNIFICATION item 4, fifteenth store): the
// minis registry migrated from whole-file minis.json rewrites to
// one-row-per-mini SQLite. These tests pin the migration contract:
// legacy files import in order with every field intact, are
// renamed (never deleted), a malformed file imports nothing and
// stays put, a pure read creates nothing, single-row mutations
// cannot lose each other, and a removal over a migrated legacy
// mini persists.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-minis-store-")); }

function legacyMini(id: string, name: string, person: string): Mini {
  return { id, name, person, created_at: "2026-11-09T03:06:19.558Z" };
}

test("minis store: a legacy minis.json imports in order, fields intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const first = legacyMini("mini-1", "dip", "Dip");
    const second = legacyMini("mini-2", "alex", "Alex");
    writeFileSync(join(root, ".sam", "minis.json"), JSON.stringify([first, second], null, 2));
    const items = minis(root);
    assert.deepEqual(items.map(m => m.id), ["mini-1", "mini-2"]);
    assert.deepEqual(items[0], first);
    assert.deepEqual(items[1], second);
    assert.equal(existsSync(join(root, ".sam", "minis.db")), true);
    assert.equal(existsSync(join(root, ".sam", "minis.json")), false);
    assert.equal(existsSync(join(root, ".sam", "minis.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "minis.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    const spawned = spawnMini(root, { name: "bea", person: "Bea", instructions: "Help Bea." });
    assert.deepEqual(minis(root).map(m => m.id), ["mini-1", "mini-2", spawned.id]);
    assert.equal(existsSync(join(root, ".sam", "minis.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("minis store: a malformed legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "minis.json"), "{ not json");
    assert.deepEqual(minis(root), []);
    assert.equal(existsSync(join(root, ".sam", "minis.json")), true);
    assert.equal(existsSync(join(root, ".sam", "minis.json.migrated")), false);
    writeFileSync(join(root, ".sam", "minis.json"), JSON.stringify({ id: "mini-x" }));
    assert.deepEqual(minis(root), []);
    assert.equal(existsSync(join(root, ".sam", "minis.json.migrated")), false);
    const spawned = spawnMini(root, { name: "alex", person: "Alex", instructions: "Help Alex." });
    assert.deepEqual(minis(root).map(m => m.id), [spawned.id]);
    assert.equal(existsSync(join(root, ".sam", "minis.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("minis store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(minis(root), []);
    assert.equal(updateMini(root, "nope", { person: "x" }), null);
    assert.equal(removeMini(root, "nope"), false);
    assert.equal(existsSync(join(root, ".sam", "minis.db")), false);
    assert.equal(existsSync(join(root, ".sam", "minis.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("minis store: interleaved spawn, update, and remove all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    const a = spawnMini(root, { name: "alex", person: "Alex", instructions: "Help Alex." });
    const b = spawnMini(root, { name: "blair", person: "Blair", instructions: "Help Blair." });
    const patched = updateMini(root, a.id, { person: "Alexandra" });
    assert.equal(patched?.person, "Alexandra");
    assert.equal(patched?.name, "alex");
    assert.equal(updateMini(root, "ghost", { person: "x" }), null);
    assert.equal(removeMini(root, "blair"), true);
    assert.equal(removeMini(root, "blair"), false);
    assert.deepEqual(minis(root).map(m => m.id), [a.id]);
    assert.equal(minis(root)[0].person, "Alexandra");
    assert.throws(() => spawnMini(root, { name: "alex", person: "Alex", instructions: "Again" }), /already exists/);
    void b;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("minis store: a removal over a migrated legacy mini persists in the DB", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "minis.json"), JSON.stringify([legacyMini("mini-9", "legacy", "Legacy Person")], null, 2));
    assert.deepEqual(minis(root).map(m => m.name), ["legacy"]);
    assert.equal(removeMini(root, "legacy"), true);
    assert.deepEqual(minis(root), []);
    assert.equal(existsSync(join(root, ".sam", "minis.json")), false);
    assert.equal(existsSync(join(root, ".sam", "minis.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
