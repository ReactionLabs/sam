import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel, type Channel } from "./channels.js";
import { listBindings, removeBinding, resolveBindingProfile, setBinding, updateBinding, type Binding } from "./bindings.js";

// State convergence (UNIFICATION item 4, seventeenth store): the
// bindings registry migrated from whole-file bindings.json rewrites
// to one-row-per-binding SQLite. These tests pin the migration
// contract: legacy files import in order with every field intact,
// are renamed (never deleted), a malformed / non-array / over-cap
// file imports nothing and stays put, a pure read creates nothing,
// single-row mutations cannot lose each other, and routing over a
// migrated legacy binding persists (the routing shape).

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-bindings-store-")); }

function legacyBinding(id: string, channelId: string, peer: string | null, profile: string): Binding {
  return { id, channelId, peer, profile, createdAt: "2026-11-10T13:16:00.000Z" };
}

test("bindings store: a legacy bindings.json imports in order, fields intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", [111]);
    mkdirSync(join(root, ".sam"), { recursive: true });
    const first = legacyBinding("b-wide", channel.id, null, "researcher");
    const second = legacyBinding("b-peer", channel.id, "111", "second-shift");
    writeFileSync(join(root, ".sam", "bindings.json"), JSON.stringify([first, second], null, 2));
    const items = listBindings(root);
    assert.deepEqual(items.map(b => b.id), ["b-wide", "b-peer"]);
    assert.deepEqual(items[0], first);
    assert.deepEqual(items[1], second);
    assert.equal(existsSync(join(root, ".sam", "bindings.db")), true);
    assert.equal(existsSync(join(root, ".sam", "bindings.json")), false);
    assert.equal(existsSync(join(root, ".sam", "bindings.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "bindings.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    // Routing rides the migrated rows immediately.
    assert.equal(resolveBindingProfile(root, channel, 111).profile, "second-shift");
    assert.equal(resolveBindingProfile(root, channel, 222).profile, "researcher");
    const added = setBinding(root, { channelId: channel.id, peer: "222", profile: "trading" });
    assert.deepEqual(listBindings(root).map(b => b.id), ["b-wide", "b-peer", added.id]);
    assert.equal(existsSync(join(root, ".sam", "bindings.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bindings store: a malformed, non-array, or over-cap legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", []);
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "bindings.json"), "{ not json");
    assert.deepEqual(listBindings(root), []);
    assert.equal(existsSync(join(root, ".sam", "bindings.json")), true);
    assert.equal(existsSync(join(root, ".sam", "bindings.json.migrated")), false);
    writeFileSync(join(root, ".sam", "bindings.json"), JSON.stringify({ id: "x" }));
    assert.deepEqual(listBindings(root), []);
    assert.equal(existsSync(join(root, ".sam", "bindings.json.migrated")), false);
    const overCap = Array.from({ length: 65 }, (_, i) => legacyBinding("b" + i, channel.id, String(i), "trading"));
    writeFileSync(join(root, ".sam", "bindings.json"), JSON.stringify(overCap));
    assert.deepEqual(listBindings(root), []);
    assert.equal(existsSync(join(root, ".sam", "bindings.json.migrated")), false);
    // A fresh set over the unimportable file still lands in the DB.
    const added = setBinding(root, { channelId: channel.id, peer: null, profile: "researcher" });
    assert.deepEqual(listBindings(root).map(b => b.id), [added.id]);
    assert.equal(existsSync(join(root, ".sam", "bindings.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bindings store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    const channel: Channel = { id: "chan-x", kind: "telegram", name: "X", profile: "trading", tokenEnv: "SAM_CHANNEL_TG_X", ownerIds: [], enabled: true };
    assert.deepEqual(listBindings(root), []);
    assert.deepEqual(resolveBindingProfile(root, channel, 111), { profile: "trading", via: "default", binding: null });
    assert.equal(updateBinding(root, "nope", { profile: "researcher" }), null);
    assert.equal(removeBinding(root, "nope"), false);
    assert.equal(existsSync(join(root, ".sam", "bindings.db")), false);
    assert.equal(existsSync(join(root, ".sam", "bindings.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bindings store: interleaved set, move, update, and remove all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", [111, 222]);
    const wide = setBinding(root, { channelId: channel.id, peer: null, profile: "researcher" });
    const peer = setBinding(root, { channelId: channel.id, peer: "111", profile: "second-shift" });
    // Moving the same (channel, peer) pair updates its one row in place.
    const moved = setBinding(root, { channelId: channel.id, peer: "111", profile: "trading" });
    assert.equal(moved.id, peer.id);
    assert.equal(listBindings(root).length, 2);
    assert.equal(resolveBindingProfile(root, channel, 111).profile, "trading");
    const patched = updateBinding(root, wide.id, { profile: "second-shift" });
    assert.equal(patched?.profile, "second-shift");
    assert.equal(patched?.id, wide.id);
    assert.equal(patched?.peer, null);
    assert.equal(updateBinding(root, "ghost", { profile: "trading" }), null);
    assert.throws(() => updateBinding(root, wide.id, { profile: "Trading" }), /Invalid profile/);
    assert.equal(removeBinding(root, wide.id), true);
    assert.equal(removeBinding(root, wide.id), false);
    assert.equal(resolveBindingProfile(root, channel, 222).via, "default");
    assert.deepEqual(listBindings(root).map(b => b.id), [peer.id]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bindings store: the cap is enforced from the row count, and a migrated routing rule survives a remove", () => {
  const root = fresh();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", []);
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "bindings.json"), JSON.stringify([legacyBinding("b-peer", channel.id, "42", "researcher")], null, 2));
    assert.equal(resolveBindingProfile(root, channel, 42).profile, "researcher");
    for (let i = 0; i < 63; i++) setBinding(root, { channelId: channel.id, peer: "p" + i, profile: "trading" });
    assert.equal(listBindings(root).length, 64);
    assert.throws(() => setBinding(root, { channelId: channel.id, peer: "one-too-many", profile: "trading" }), /Binding limit reached \(64\)/);
    // Moving an existing pair at the cap still works - it is not a new row.
    const moved = setBinding(root, { channelId: channel.id, peer: "42", profile: "trading" });
    assert.equal(moved.id, "b-peer");
    assert.equal(listBindings(root).length, 64);
    assert.equal(removeBinding(root, "b-peer"), true);
    assert.equal(resolveBindingProfile(root, channel, 42).via, "default");
    assert.equal(existsSync(join(root, ".sam", "bindings.json")), false);
    assert.equal(existsSync(join(root, ".sam", "bindings.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
