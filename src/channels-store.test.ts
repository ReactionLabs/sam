import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel, channels, getChannel, removeChannel, setChannelOwners, updateChannel, type Channel } from "./channels.js";

// State convergence (UNIFICATION item 4, tenth store): the channel
// registry migrated from whole-file channels.json rewrites to
// one-row-per-channel SQLite. These tests pin the migration
// contract: legacy files import in order with every field intact,
// are renamed (never deleted), a malformed file imports nothing
// and stays put, a pure read creates nothing, single-row mutations
// cannot lose each other, and an owner set over a migrated legacy
// channel persists through the row update alone.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-channels-store-")); }

function legacyChannel(id: string, name: string, extra: Partial<Channel> = {}): Channel {
  return { id, kind: "telegram", name, profile: "trading", tokenEnv: "SAM_CHANNEL_TG_MAIN", ownerIds: [123], enabled: true, ...extra };
}

test("channels store: a legacy channels.json imports in order, fields intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const first = legacyChannel("chan-1", "Dip Telegram", { ownerIds: [6300316150] });
    const second = legacyChannel("chan-2", "Hook", { kind: "webhook", profile: "dip", tokenEnv: "SAM_CHANNEL_HOOK", ownerIds: [], enabled: false });
    writeFileSync(join(root, ".sam", "channels.json"), JSON.stringify([first, second], null, 2));
    const items = channels(root);
    assert.deepEqual(items.map(c => c.id), ["chan-1", "chan-2"]);
    assert.deepEqual(items[0], first);
    assert.deepEqual(items[1], second);
    assert.equal(existsSync(join(root, ".sam", "channels.db")), true);
    assert.equal(existsSync(join(root, ".sam", "channels.json")), false);
    assert.equal(existsSync(join(root, ".sam", "channels.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "channels.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    // New writes ride the DB and never recreate the JSON file.
    const added = addChannel(root, "discord", "Discord Main", "trading", "SAM_CHANNEL_DISCORD");
    assert.deepEqual(channels(root).map(c => c.id), ["chan-1", "chan-2", added.id]);
    assert.equal(existsSync(join(root, ".sam", "channels.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channels store: a malformed legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "channels.json"), "{ not json");
    assert.deepEqual(channels(root), []);
    assert.equal(existsSync(join(root, ".sam", "channels.json")), true);
    assert.equal(existsSync(join(root, ".sam", "channels.json.migrated")), false);
    // A fresh add over the malformed file lands in the DB only.
    const added = addChannel(root, "telegram", "Fresh TG", "trading", "SAM_CHANNEL_TG_MAIN");
    assert.deepEqual(channels(root).map(c => c.id), [added.id]);
    assert.equal(existsSync(join(root, ".sam", "channels.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channels store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(channels(root), []);
    assert.equal(getChannel(root, "nope"), null);
    assert.equal(updateChannel(root, "nope", { enabled: false }), null);
    assert.equal(removeChannel(root, "nope"), false);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channels store: interleaved adds, an owner set, and a remove all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    const a = addChannel(root, "telegram", "Alpha TG", "trading", "SAM_CHANNEL_TG_MAIN", [111]);
    const b = addChannel(root, "webhook", "Beta Hook", "dip", "SAM_CHANNEL_HOOK", []);
    const owned = setChannelOwners(root, a.id, [222, 222, 333]);
    assert.deepEqual(owned.ownerIds, [222, 333]);
    const patched = updateChannel(root, b.id, { enabled: false });
    assert.equal(patched?.enabled, false);
    assert.equal(updateChannel(root, "ghost", { enabled: false }), null);
    assert.equal(removeChannel(root, b.id), true);
    assert.equal(removeChannel(root, b.id), false);
    const items = channels(root);
    assert.deepEqual(items.map(c => c.id), [a.id]);
    assert.deepEqual(items[0].ownerIds, [222, 333]);
    assert.equal(getChannel(root, a.id)?.name, "Alpha TG");
    assert.equal(getChannel(root, b.id), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("channels store: an owner set over a migrated legacy channel persists in the DB (the pairing shape)", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "channels.json"), JSON.stringify([legacyChannel("chan-9", "Legacy TG", { ownerIds: [] })], null, 2));
    // The pairing redemption shape: read the channel, append the
    // sender, write the owner list back - now a single-row update.
    const before = channels(root)[0];
    const updated = setChannelOwners(root, before.id, [...before.ownerIds, 999]);
    assert.deepEqual(updated.ownerIds, [999]);
    assert.deepEqual(channels(root)[0].ownerIds, [999]);
    assert.deepEqual(getChannel(root, "chan-9")?.ownerIds, [999]);
    assert.equal(existsSync(join(root, ".sam", "channels.json")), false);
    assert.equal(existsSync(join(root, ".sam", "channels.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
