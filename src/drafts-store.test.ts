import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraft, getDraft, listDrafts, removeDraft, updateDraft, type Draft } from "./drafts.js";

// State convergence (UNIFICATION item 4, nineteenth store): the drafts
// store migrated from whole-file drafts.json rewrites to
// one-row-per-draft SQLite. These tests pin the migration contract:
// legacy files import in order with every field intact, are renamed
// (never deleted), a malformed file imports nothing and stays put, a
// pure read creates nothing, single-row mutations cannot lose each
// other, and a discard over a migrated legacy draft persists (the
// resurrection shape). The P12 fence holds throughout: no test here -
// and no code anywhere - sends a draft.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-drafts-store-")); }

function legacyDraft(id: string, to: string): Draft {
  return { id, actor: "sam", to, channel: "email", subject: "Hello " + to, body: "Body for " + to, status: "draft", createdAt: "2026-11-09T13:16:00.000Z", via: "cli" };
}

test("drafts store: a legacy drafts.json imports in order, fields intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const first = legacyDraft("11111111-1111-4111-8111-111111111111", "Rick Ruiz");
    const second = legacyDraft("22222222-2222-4222-8222-222222222222", "Johnny Davis");
    writeFileSync(join(root, ".sam", "drafts.json"), JSON.stringify([first, second], null, 2));
    const items = listDrafts(root);
    assert.deepEqual(items.map(d => d.id), [first.id, second.id]);
    assert.deepEqual(items[0], first);
    assert.deepEqual(items[1], second);
    assert.equal(existsSync(join(root, ".sam", "drafts.db")), true);
    assert.equal(existsSync(join(root, ".sam", "drafts.json")), false);
    assert.equal(existsSync(join(root, ".sam", "drafts.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "drafts.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    const added = createDraft(root, { actor: "sam", to: "Bea New", body: "Fresh draft" });
    assert.deepEqual(listDrafts(root).map(d => d.id), [first.id, second.id, added.id]);
    assert.equal(existsSync(join(root, ".sam", "drafts.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("drafts store: a malformed legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "drafts.json"), "{ not json");
    assert.deepEqual(listDrafts(root), []);
    assert.equal(existsSync(join(root, ".sam", "drafts.json")), true);
    assert.equal(existsSync(join(root, ".sam", "drafts.json.migrated")), false);
    writeFileSync(join(root, ".sam", "drafts.json"), JSON.stringify({ id: "x" }));
    assert.deepEqual(listDrafts(root), []);
    assert.equal(existsSync(join(root, ".sam", "drafts.json.migrated")), false);
    const added = createDraft(root, { actor: "sam", to: "Alex", body: "Over malformed" });
    assert.deepEqual(listDrafts(root).map(d => d.id), [added.id]);
    assert.equal(existsSync(join(root, ".sam", "drafts.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("drafts store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(listDrafts(root), []);
    assert.equal(getDraft(root, "nope"), null);
    assert.equal(updateDraft(root, "nope", { body: "x" }), null);
    assert.equal(removeDraft(root, "nope"), false);
    assert.equal(existsSync(join(root, ".sam", "drafts.db")), false);
    assert.equal(existsSync(join(root, ".sam", "drafts.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("drafts store: interleaved create, update, and remove all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    const a = createDraft(root, { actor: "sam", to: "Alex", body: "First body" });
    const b = createDraft(root, { actor: "sam", to: "Blair", channel: "text", body: "Second body" });
    const patched = updateDraft(root, a.id, { body: "Patched body", status: "draft" });
    assert.equal(patched?.body, "Patched body");
    assert.equal(patched?.id, a.id);
    assert.equal(updateDraft(root, "ghost", { body: "x" }), null);
    assert.equal(getDraft(root, b.id)?.to, "Blair");
    assert.equal(removeDraft(root, b.id), true);
    assert.equal(removeDraft(root, b.id), false);
    assert.deepEqual(listDrafts(root).map(d => d.id), [a.id]);
    assert.equal(listDrafts(root)[0].body, "Patched body");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("drafts store: a discard over a migrated legacy draft persists in the DB (no resurrection)", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacy = legacyDraft("33333333-3333-4333-8333-333333333333", "Legacy Person");
    writeFileSync(join(root, ".sam", "drafts.json"), JSON.stringify([legacy], null, 2));
    assert.deepEqual(listDrafts(root).map(d => d.id), [legacy.id]);
    assert.equal(removeDraft(root, legacy.id), true);
    assert.deepEqual(listDrafts(root), []);
    assert.equal(getDraft(root, legacy.id), null);
    const added = createDraft(root, { actor: "sam", to: "Someone Else", body: "New work" });
    assert.deepEqual(listDrafts(root).map(d => d.id), [added.id]);
    assert.equal(existsSync(join(root, ".sam", "drafts.json")), false);
    assert.equal(existsSync(join(root, ".sam", "drafts.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
