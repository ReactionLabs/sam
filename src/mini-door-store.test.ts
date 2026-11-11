import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnMini } from "./minis.js";
import { disableDoor, doorEnabled, doorForKey, issueDoorKey, listDoors, peekSessionChat, readDoorStore, rotateSessionChat, sessionChat } from "./mini-door.js";

// State convergence (UNIFICATION item 4, thirteenth store): the
// web-door store migrated from whole-file mini-doors.json rewrites
// (on every door message's session touch, no less) to
// one-row-per-door / one-row-per-session SQLite. These tests pin
// the migration contract: legacy files import in order with every
// field intact, are renamed (never deleted), a malformed file
// imports nothing and stays put, a pure read creates nothing,
// single-row mutations cannot lose each other (a disable cannot
// revert under a session save), and the session cap still prunes.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-mini-door-store-")); }
function hashOf(key: string): string { return createHash("sha256").update(key).digest("hex"); }

test("mini-doors store: a legacy mini-doors.json imports in order, fields intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const keyA = "a".repeat(64), keyB = "b".repeat(64);
    const legacy = {
      doors: [
        { mini: "alex", keyHash: hashOf(keyA), enabled: true, created_at: "2026-11-01T00:00:00.000Z", expires_at: "2026-12-01T00:00:00.000Z", keyVersion: 2, homeLink: false, mode: "owner" },
        { mini: "dip", keyHash: hashOf(keyB), enabled: true, created_at: "2026-11-02T00:00:00.000Z", expires_at: "2026-12-02T00:00:00.000Z", keyVersion: 2, mode: "visitor" },
      ],
      sessions: [
        { mini: "alex", session: "session-1234567890", chatId: "chat-1", updated_at: "2026-11-03T00:00:00.000Z" },
        { mini: "dip", session: "session-abcdefghij", chatId: "chat-2", updated_at: "2026-11-04T00:00:00.000Z" },
      ],
    };
    writeFileSync(join(root, ".sam", "mini-doors.json"), JSON.stringify(legacy, null, 2));
    const audit = listDoors(root, Date.parse("2026-11-10T00:00:00.000Z"));
    assert.deepEqual(audit.map(d => d.mini), ["alex", "dip"]);
    assert.equal(audit[0].sessions, 1);
    assert.equal(audit[1].mode, "visitor");
    assert.equal(doorForKey(root, keyA), "alex");
    assert.equal(peekSessionChat(root, "dip", "session-abcdefghij"), "chat-2");
    assert.deepEqual(readDoorStore(root), legacy);
    assert.equal(existsSync(join(root, ".sam", "mini-doors.db")), true);
    assert.equal(existsSync(join(root, ".sam", "mini-doors.json")), false);
    assert.equal(existsSync(join(root, ".sam", "mini-doors.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "mini-doors.json.migrated"), "utf8")) as typeof legacy;
    assert.equal(kept.doors.length, 2);
    assert.equal(kept.sessions.length, 2);
    // New writes ride the DB and never recreate the JSON file.
    spawnMini(root, { name: "alex", person: "Alex", instructions: "Help Alex." });
    const issued = issueDoorKey(root, "alex");
    assert.equal(doorForKey(root, issued), "alex");
    assert.equal(doorForKey(root, keyA), null);
    assert.equal(existsSync(join(root, ".sam", "mini-doors.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-doors store: a malformed legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "mini-doors.json"), "{ not json");
    assert.deepEqual(listDoors(root), []);
    assert.equal(doorForKey(root, "a".repeat(64)), null);
    assert.equal(existsSync(join(root, ".sam", "mini-doors.json")), true);
    assert.equal(existsSync(join(root, ".sam", "mini-doors.json.migrated")), false);
    // A fresh issue over the malformed file lands in the DB only.
    spawnMini(root, { name: "alex", person: "Alex", instructions: "Help Alex." });
    const key = issueDoorKey(root, "alex");
    assert.equal(doorForKey(root, key), "alex");
    assert.equal(existsSync(join(root, ".sam", "mini-doors.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-doors store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(listDoors(root), []);
    assert.deepEqual(readDoorStore(root), { doors: [], sessions: [] });
    assert.equal(doorForKey(root, "a".repeat(64)), null);
    assert.equal(doorEnabled(root, "alex"), false);
    assert.equal(peekSessionChat(root, "alex", "session-1234567890"), null);
    assert.equal(disableDoor(root, "alex"), false);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-doors store: interleaved issue, session, rotate, and disable all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    spawnMini(root, { name: "alex", person: "Alex", instructions: "Help Alex." });
    spawnMini(root, { name: "bea", person: "Bea", instructions: "Help Bea." });
    const alexKey = issueDoorKey(root, "alex");
    const beaKey = issueDoorKey(root, "bea");
    let created = 0; const make = () => "chat-" + (++created);
    assert.equal(sessionChat(root, "alex", "session-1234567890", make), "chat-1");
    assert.equal(sessionChat(root, "bea", "session-1234567890", make), "chat-2");
    // The resurrection shape: the operator disables alex's door, then
    // door traffic touches bea's session - the disable must stand.
    assert.equal(disableDoor(root, "alex"), true);
    assert.equal(sessionChat(root, "bea", "session-1234567890", make), "chat-2");
    assert.equal(rotateSessionChat(root, "bea", "session-1234567890", make), "chat-3");
    assert.equal(doorForKey(root, alexKey), null);
    assert.equal(doorEnabled(root, "alex"), false);
    assert.equal(doorForKey(root, beaKey), "bea");
    assert.equal(peekSessionChat(root, "bea", "session-1234567890"), "chat-3");
    assert.equal(peekSessionChat(root, "alex", "session-1234567890"), "chat-1");
    assert.equal(disableDoor(root, "alex"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mini-doors store: session work over a migrated legacy file persists, and the 1000-session cap prunes oldest", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const key = "c".repeat(64);
    const sessions = Array.from({ length: 1000 }, (_, i) => ({
      mini: "alex", session: "session-" + String(i).padStart(10, "0"), chatId: "chat-" + i, updated_at: "2026-11-01T00:00:00.000Z",
    }));
    writeFileSync(join(root, ".sam", "mini-doors.json"), JSON.stringify({
      doors: [{ mini: "alex", keyHash: hashOf(key), enabled: true, created_at: "2026-11-01T00:00:00.000Z", expires_at: "2027-11-01T00:00:00.000Z", keyVersion: 2 }],
      sessions,
    }));
    // A touch over the migrated store returns the same chat and
    // persists through its own row alone.
    assert.equal(sessionChat(root, "alex", "session-0000000500", () => "chat-new"), "chat-500");
    // One new session at the cap prunes exactly the oldest.
    assert.equal(sessionChat(root, "alex", "session-zzzzzzzzzz", () => "chat-1000"), "chat-1000");
    const store = readDoorStore(root);
    assert.equal(store.sessions.length, 1000);
    assert.equal(peekSessionChat(root, "alex", "session-0000000000"), null);
    assert.equal(peekSessionChat(root, "alex", "session-zzzzzzzzzz"), "chat-1000");
    assert.equal(doorForKey(root, key), "alex");
    assert.equal(existsSync(join(root, ".sam", "mini-doors.json")), false);
    assert.equal(existsSync(join(root, ".sam", "mini-doors.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
