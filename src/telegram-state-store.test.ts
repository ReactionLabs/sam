import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel } from "./channels.js";
import { channelForChat, loadBridgeState, saveBridgeState, type BridgeState } from "./telegram.js";

// State convergence (UNIFICATION item 4, twenty-third store): the
// Telegram bridge state migrated from whole-file
// telegram-state.json rewrites (after every handled update, with a
// loader that threw on a torn file and killed the bridge's next
// start) to a one-row SQLite singleton. These tests pin the
// migration contract: a legacy file imports with every field
// intact, is renamed (never deleted), a malformed file imports
// nothing and stays put while the migrated loader reads it
// forgivingly as the empty state instead of throwing, a pure read
// creates nothing, saves round-trip through the DB with the chat
// map and pairing candidate preserved, and channelForChat (the
// cross-process reader on the action gate / loop revisit) resolves
// through the migrated store.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-telegram-state-store-")); }

const LEGACY: BridgeState = {
  offset: 51110615,
  chats: { "6300316150": "5d363679-6e35-4e42-bf77-5e20794205be" },
  pairingCandidate: { id: 999, username: "stranger", first_name: "Stranger", at: "2026-11-11T05:27:00.000Z" },
};

test("telegram state store: a legacy telegram-state.json imports intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "telegram-state.json"), JSON.stringify(LEGACY, null, 2));
    assert.deepEqual(loadBridgeState(root), LEGACY);
    assert.equal(existsSync(join(root, ".sam", "telegram-state.db")), true);
    assert.equal(existsSync(join(root, ".sam", "telegram-state.json")), false);
    assert.equal(existsSync(join(root, ".sam", "telegram-state.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "telegram-state.json.migrated"), "utf8")) as BridgeState;
    assert.deepEqual(kept, LEGACY);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("telegram state store: a malformed legacy file imports nothing, stays in place, and reads as the empty state instead of throwing", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "telegram-state.json"), "{ not json");
    assert.deepEqual(loadBridgeState(root), { offset: 0, chats: {} });
    assert.equal(existsSync(join(root, ".sam", "telegram-state.json")), true);
    assert.equal(existsSync(join(root, ".sam", "telegram-state.json.migrated")), false);
    writeFileSync(join(root, ".sam", "telegram-state.json"), JSON.stringify(["not", "an", "object"]));
    assert.deepEqual(loadBridgeState(root), { offset: 0, chats: {} });
    assert.equal(existsSync(join(root, ".sam", "telegram-state.json.migrated")), false);
    // A save over the malformed legacy file rides the DB; the file
    // itself is still left in place, exactly as found.
    saveBridgeState(root, { offset: 7, chats: { "555": "sam-chat-1" } });
    assert.deepEqual(loadBridgeState(root), { offset: 7, chats: { "555": "sam-chat-1" } });
    assert.equal(existsSync(join(root, ".sam", "telegram-state.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("telegram state store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(loadBridgeState(root), { offset: 0, chats: {} });
    assert.equal(existsSync(join(root, ".sam", "telegram-state.db")), false);
    assert.equal(existsSync(join(root, ".sam", "telegram-state.json")), false);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("telegram state store: interleaved saves persist offset, chat map, and pairing candidate through the DB", () => {
  const root = fresh();
  try {
    // The bridge's own rhythm: load, advance, save, per update.
    saveBridgeState(root, { offset: 101, chats: { "555": "sam-chat-1" } });
    const advanced = loadBridgeState(root);
    advanced.offset = 102;
    advanced.pairingCandidate = { id: 999, username: "stranger", at: "2026-11-11T05:27:00.000Z" };
    saveBridgeState(root, advanced);
    // A second writer process (an operator-side save, the loop-revisit
    // test shape) merges a routed-profile chat key on its own read.
    const peer = loadBridgeState(root);
    peer.chats["555:trading"] = "sam-chat-2";
    saveBridgeState(root, peer);
    assert.deepEqual(loadBridgeState(root), {
      offset: 102,
      chats: { "555": "sam-chat-1", "555:trading": "sam-chat-2" },
      pairingCandidate: { id: 999, username: "stranger", at: "2026-11-11T05:27:00.000Z" },
    });
    assert.equal(existsSync(join(root, ".sam", "telegram-state.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("telegram state store: channelForChat resolves through the migrated store", () => {
  const root = fresh();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", [111]);
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "telegram-state.json"), JSON.stringify(LEGACY, null, 2));
    assert.equal(channelForChat(root, "5d363679-6e35-4e42-bf77-5e20794205be"), channel.id);
    assert.equal(channelForChat(root, "no-such-chat"), null);
    assert.equal(existsSync(join(root, ".sam", "telegram-state.json.migrated")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
