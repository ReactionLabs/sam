import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { addLinkMember, createLink, deleteLink, links, removeLinkMember, updateLinkGroup, visibleScopes, type LinkGroup } from "./links.js";

// State convergence (UNIFICATION item 4, fourteenth store): the
// link registry migrated from whole-file links.json rewrites to
// one-row-per-group SQLite. These tests pin the migration
// contract: legacy files import in order with every field intact,
// are renamed (never deleted), a malformed file imports nothing
// and stays put, a pure read creates nothing, single-row
// mutations cannot lose each other, and a member removal over a
// migrated legacy group persists (the scope-authorization shape).

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-links-store-")); }

function seedProfiles(root: string, names: string[]): void {
  const db = new ChatStore(root);
  try { for (const name of names) db.createAgent(name, "Help " + name + ".", {}); } finally { db.close(); }
}

function legacyGroup(id: string, name: string, members: string[]): LinkGroup {
  return { id, name, members, created_at: "2026-11-09T03:26:53.252Z" };
}

test("links store: a legacy links.json imports in order, fields intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    seedProfiles(root, ["alex", "blair"]);
    mkdirSync(join(root, ".sam"), { recursive: true });
    const first = legacyGroup("link-1", "alex + blair", ["alex", "blair"]);
    const second = legacyGroup("link-2", "core + alex", ["sam", "alex"]);
    writeFileSync(join(root, ".sam", "links.json"), JSON.stringify([first, second], null, 2));
    const items = links(root);
    assert.deepEqual(items.map(g => g.id), ["link-1", "link-2"]);
    assert.deepEqual(items[0], first);
    assert.deepEqual(items[1], second);
    assert.equal(existsSync(join(root, ".sam", "links.db")), true);
    assert.equal(existsSync(join(root, ".sam", "links.json")), false);
    assert.equal(existsSync(join(root, ".sam", "links.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "links.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    assert.deepEqual(visibleScopes(root, "alex"), ["profile:alex", "link:link-1", "link:link-2"]);
    assert.deepEqual(visibleScopes(root, "sam"), ["core", "link:link-2"]);
    const added = createLink(root, "blair + sam", ["blair", "sam"]);
    assert.deepEqual(links(root).map(g => g.id), ["link-1", "link-2", added.id]);
    assert.equal(existsSync(join(root, ".sam", "links.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("links store: a malformed legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    seedProfiles(root, ["alex", "blair"]);
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "links.json"), "{ not json");
    assert.deepEqual(links(root), []);
    // A torn file yields own-scope-only, never wider access, and does not throw.
    assert.deepEqual(visibleScopes(root, "alex"), ["profile:alex"]);
    assert.equal(existsSync(join(root, ".sam", "links.json")), true);
    assert.equal(existsSync(join(root, ".sam", "links.json.migrated")), false);
    writeFileSync(join(root, ".sam", "links.json"), JSON.stringify({ id: "link-x" }));
    assert.deepEqual(links(root), []);
    assert.equal(existsSync(join(root, ".sam", "links.json.migrated")), false);
    const added = createLink(root, "fresh", ["alex", "blair"]);
    assert.deepEqual(links(root).map(g => g.id), [added.id]);
    assert.equal(existsSync(join(root, ".sam", "links.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("links store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(links(root), []);
    assert.deepEqual(visibleScopes(root, "alex"), ["profile:alex"]);
    assert.equal(updateLinkGroup(root, "nope", { name: "x" }), null);
    assert.equal(deleteLink(root, "nope"), false);
    assert.throws(() => removeLinkMember(root, "nope", "alex"), /Link not found/);
    assert.equal(existsSync(join(root, ".sam", "links.db")), false);
    // visibleScopes / links alone must not create the .sam dir's links store;
    // ChatStore was never opened here, so .sam may not exist at all.
    assert.equal(existsSync(join(root, ".sam", "links.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("links store: interleaved create, member add/remove, update, and delete all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    seedProfiles(root, ["alex", "blair", "casey"]);
    const a = createLink(root, "ab", ["alex", "blair"]);
    const b = createLink(root, "core pair", ["sam", "alex"]);
    const grown = addLinkMember(root, a.id, "casey");
    assert.deepEqual(grown.members, ["alex", "blair", "casey"]);
    // Adding an existing member is a no-op that keeps the group intact.
    assert.deepEqual(addLinkMember(root, a.id, "casey").members, ["alex", "blair", "casey"]);
    const shrunk = removeLinkMember(root, a.id, "blair");
    assert.deepEqual(shrunk.members, ["alex", "casey"]);
    assert.deepEqual(visibleScopes(root, "blair"), ["profile:blair"]);
    const patched = updateLinkGroup(root, b.id, { name: "renamed pair" });
    assert.equal(patched?.name, "renamed pair");
    assert.equal(updateLinkGroup(root, "ghost", { name: "x" }), null);
    assert.equal(deleteLink(root, b.id), true);
    assert.equal(deleteLink(root, b.id), false);
    assert.deepEqual(links(root).map(g => g.id), [a.id]);
    assert.throws(() => addLinkMember(root, a.id, "ghost-profile"), /Unknown profile/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("links store: a member removal over a migrated legacy group persists in the DB (the authorization shape)", () => {
  const root = fresh();
  try {
    seedProfiles(root, ["alex", "blair"]);
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "links.json"), JSON.stringify([legacyGroup("link-9", "legacy pair", ["alex", "blair"])], null, 2));
    assert.deepEqual(visibleScopes(root, "blair"), ["profile:blair", "link:link-9"]);
    const after = removeLinkMember(root, "link-9", "blair");
    assert.deepEqual(after.members, ["alex"]);
    assert.deepEqual(visibleScopes(root, "blair"), ["profile:blair"]);
    assert.deepEqual(links(root)[0].members, ["alex"]);
    assert.equal(existsSync(join(root, ".sam", "links.json")), false);
    assert.equal(existsSync(join(root, ".sam", "links.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
