import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftBlockedFor, getContact, listContacts, removeContact, updateContact, upsertContact, type Contact } from "./contacts.js";

// State convergence (UNIFICATION item 4, sixteenth store): the
// contacts registry migrated from whole-file contacts.json rewrites
// to one-row-per-contact SQLite. These tests pin the migration
// contract: legacy files import in order with every field intact,
// are renamed (never deleted), a malformed file imports nothing and
// stays put, a pure read creates nothing, single-row mutations
// cannot lose each other, and a noDraft removal over a migrated
// legacy contact persists (the permission shape).

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-contacts-store-")); }

function legacyContact(name: string, display: string, noDraft: boolean): Contact {
  return { name, display, note: "Owner note for " + display, noDraft, createdAt: "2026-11-09T13:16:00.000Z", updatedAt: "2026-11-09T13:16:00.000Z" };
}

test("contacts store: a legacy contacts.json imports in order, fields intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const first = legacyContact("johnny-davis", "Johnny Davis", false);
    const second = legacyContact("closed-person", "Closed Person", true);
    writeFileSync(join(root, ".sam", "contacts.json"), JSON.stringify([first, second], null, 2));
    const items = listContacts(root);
    assert.deepEqual(items.map(c => c.name), ["johnny-davis", "closed-person"]);
    assert.deepEqual(items[0], first);
    assert.deepEqual(items[1], second);
    assert.equal(existsSync(join(root, ".sam", "contacts.db")), true);
    assert.equal(existsSync(join(root, ".sam", "contacts.json")), false);
    assert.equal(existsSync(join(root, ".sam", "contacts.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "contacts.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    const added = upsertContact(root, { name: "Bea New", note: "Texts fine" });
    assert.deepEqual(listContacts(root).map(c => c.name), ["johnny-davis", "closed-person", added.name]);
    assert.equal(existsSync(join(root, ".sam", "contacts.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contacts store: a malformed legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "contacts.json"), "{ not json");
    assert.deepEqual(listContacts(root), []);
    assert.equal(existsSync(join(root, ".sam", "contacts.json")), true);
    assert.equal(existsSync(join(root, ".sam", "contacts.json.migrated")), false);
    writeFileSync(join(root, ".sam", "contacts.json"), JSON.stringify({ name: "x" }));
    assert.deepEqual(listContacts(root), []);
    assert.equal(existsSync(join(root, ".sam", "contacts.json.migrated")), false);
    const added = upsertContact(root, { name: "Alex", note: "Ok" });
    assert.deepEqual(listContacts(root).map(c => c.name), [added.name]);
    assert.equal(existsSync(join(root, ".sam", "contacts.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contacts store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(listContacts(root), []);
    assert.equal(getContact(root, "Anyone"), null);
    assert.equal(draftBlockedFor(root, "Anyone"), null);
    assert.equal(updateContact(root, "nope", { note: "x" }), null);
    assert.equal(removeContact(root, "nope"), false);
    assert.equal(existsSync(join(root, ".sam", "contacts.db")), false);
    assert.equal(existsSync(join(root, ".sam", "contacts.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contacts store: interleaved upsert, update, and remove all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    const a = upsertContact(root, { name: "Alex", note: "Draft freely" });
    upsertContact(root, { name: "Blair", note: "Careful", noDraft: true });
    const flagged = upsertContact(root, { name: "Alex", noDraft: true });
    assert.equal(flagged.note, "Draft freely");
    assert.equal(flagged.noDraft, true);
    const patched = updateContact(root, "blair", { note: "Patched note" });
    assert.equal(patched?.note, "Patched note");
    assert.equal(patched?.noDraft, true);
    assert.equal(patched?.name, "blair");
    assert.equal(updateContact(root, "ghost", { note: "x" }), null);
    assert.equal(draftBlockedFor(root, "Blair")?.display, "Blair");
    assert.equal(removeContact(root, "Blair"), true);
    assert.equal(removeContact(root, "Blair"), false);
    assert.equal(draftBlockedFor(root, "Blair"), null);
    assert.deepEqual(listContacts(root).map(c => c.name), [a.name]);
    assert.equal(listContacts(root)[0].noDraft, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contacts store: a noDraft mark over a migrated legacy contact persists in the DB", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "contacts.json"), JSON.stringify([legacyContact("legacy-person", "Legacy Person", false)], null, 2));
    assert.deepEqual(listContacts(root).map(c => c.name), ["legacy-person"]);
    assert.equal(draftBlockedFor(root, "Legacy Person"), null);
    upsertContact(root, { name: "Legacy Person", noDraft: true });
    assert.equal(draftBlockedFor(root, "Legacy Person")?.name, "legacy-person");
    assert.equal(getContact(root, "legacy person")?.note, "Owner note for Legacy Person");
    assert.equal(existsSync(join(root, ".sam", "contacts.json")), false);
    assert.equal(existsSync(join(root, ".sam", "contacts.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
