import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel, channels } from "./channels.js";
import { issuePairingCode, pairingStatus, readPairingStore, redeemPairingCode } from "./pairing.js";

// State convergence (UNIFICATION item 4, eleventh store): the pairing
// store migrated from whole-file pairing.json rewrites to SQLite -
// one row per code plus one keyed row per channel guard. These tests
// pin the migration contract: legacy files import with codes in
// order and guards intact and are renamed (never deleted), a
// malformed file imports nothing and stays put, a pure read creates
// nothing, single-row mutations cannot lose each other (a failure
// count and a consumed code both survive an interleaved issue), and
// the lockout holds over a migrated legacy store.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-pairing-store-")); }
const T0 = Date.parse("2026-11-09T00:00:00.000Z");

function legacyStore(channelId: string) {
  return {
    codes: [
      { id: "code-1", channelId, codeHash: "a".repeat(64), createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 3_600_000).toISOString() },
      { id: "code-0", channelId, codeHash: "b".repeat(64), createdAt: new Date(T0 - 7_200_000).toISOString(), expiresAt: new Date(T0 - 3_600_000).toISOString(), usedBy: 111, usedAt: new Date(T0 - 7_000_000).toISOString() },
    ],
    guards: { [channelId]: { failures: [T0 - 1000, T0 - 2000], lockedUntil: null } },
  };
}

test("pairing store: a legacy pairing.json imports codes in order and guards intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    const c = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN");
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "pairing.json"), JSON.stringify(legacyStore(c.id), null, 2));
    const store = readPairingStore(root);
    assert.deepEqual(store.codes.map(r => r.id), ["code-1", "code-0"]);
    assert.equal(store.codes[1].usedBy, 111);
    assert.deepEqual(store.guards[c.id], { failures: [T0 - 1000, T0 - 2000], lockedUntil: null });
    assert.equal(existsSync(join(root, ".sam", "pairing.db")), true);
    assert.equal(existsSync(join(root, ".sam", "pairing.json")), false);
    assert.equal(existsSync(join(root, ".sam", "pairing.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "pairing.json.migrated"), "utf8")) as { codes: unknown[] };
    assert.equal(kept.codes.length, 2);
    // Status rides the migrated guard: the two legacy failures count.
    const status = pairingStatus(root, T0);
    assert.equal(status[0].recentFailures, 2);
    assert.equal(status[0].liveCode, true);
    // New writes ride the DB and never recreate the JSON file.
    const issued = issuePairingCode(root, c.id, T0 + 3000);
    assert.equal(issued.channel, "Dip Telegram");
    assert.equal(existsSync(join(root, ".sam", "pairing.json")), false);
    // The issue retired the migrated live code and kept the used one.
    const after = readPairingStore(root);
    assert.equal(after.codes.find(r => r.id === "code-1")?.retired, true);
    assert.equal(after.codes.find(r => r.id === "code-0")?.usedBy, 111);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pairing store: a malformed legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    const c = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN");
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "pairing.json"), "{ not json");
    assert.deepEqual(readPairingStore(root), { codes: [], guards: {} });
    assert.equal(pairingStatus(root, T0)[0].liveCode, false);
    assert.equal(existsSync(join(root, ".sam", "pairing.json")), true);
    assert.equal(existsSync(join(root, ".sam", "pairing.json.migrated")), false);
    // A fresh issue over the malformed file lands in the DB only.
    const issued = issuePairingCode(root, c.id, T0);
    assert.equal(redeemPairingCode(root, c.id, issued.code, 4242, T0 + 1000).ok, true);
    assert.deepEqual(channels(root)[0].ownerIds, [4242]);
    assert.equal(existsSync(join(root, ".sam", "pairing.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pairing store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(readPairingStore(root), { codes: [], guards: {} });
    assert.deepEqual(pairingStatus(root, T0), []);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pairing store: interleaved issue, failed attempts, and a redeem all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    const a = addChannel(root, "telegram", "Chan A", "trading", "SAM_CHANNEL_TG_A");
    const b = addChannel(root, "telegram", "Chan B", "trading", "SAM_CHANNEL_TG_B");
    const issuedA = issuePairingCode(root, a.id, T0);
    // Two failed attempts on A record their counts on A's guard row.
    assert.deepEqual(redeemPairingCode(root, a.id, "ZZZZ-ZZZZ", 999, T0 + 1000), { ok: false, reason: "invalid" });
    assert.deepEqual(redeemPairingCode(root, a.id, "ZZZZ-ZZZZ", 999, T0 + 2000), { ok: false, reason: "invalid" });
    // An interleaved issue on B must not revert A's failure counts.
    const issuedB = issuePairingCode(root, b.id, T0 + 3000);
    assert.equal(pairingStatus(root, T0 + 4000).find(s => s.channelId === a.id)?.recentFailures, 2);
    // B's redeem must not revert A's counts either, and A's code still redeems.
    assert.equal(redeemPairingCode(root, b.id, issuedB.code, 888, T0 + 5000).ok, true);
    assert.equal(pairingStatus(root, T0 + 6000).find(s => s.channelId === a.id)?.recentFailures, 2);
    assert.equal(redeemPairingCode(root, a.id, issuedA.code, 999, T0 + 7000).ok, true);
    // The consumed code cannot replay, and the successful redeem cleared A's guard.
    assert.deepEqual(redeemPairingCode(root, a.id, issuedA.code, 777, T0 + 8000), { ok: false, reason: "used" });
    assert.deepEqual(readPairingStore(root).guards[a.id], { failures: [T0 + 8000], lockedUntil: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pairing store: the lockout trips and holds over a migrated legacy guard", () => {
  const root = fresh();
  try {
    const c = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN");
    mkdirSync(join(root, ".sam"), { recursive: true });
    // Legacy guard already carries four failures inside the window:
    // one more failed attempt must trip the lock, not restart the count.
    const legacy = legacyStore(c.id);
    legacy.guards[c.id] = { failures: [T0 - 1000, T0 - 2000, T0 - 3000, T0 - 4000], lockedUntil: null };
    writeFileSync(join(root, ".sam", "pairing.json"), JSON.stringify(legacy, null, 2));
    const issued = issuePairingCode(root, c.id, T0);
    assert.deepEqual(redeemPairingCode(root, c.id, "ZZZZ-ZZZZ", 999, T0 + 1000), { ok: false, reason: "locked" });
    assert.deepEqual(redeemPairingCode(root, c.id, issued.code, 999, T0 + 2000), { ok: false, reason: "locked" });
    const status = pairingStatus(root, T0 + 2000)[0];
    assert.ok(status.lockedUntil);
    assert.equal(status.recentFailures, 0);
    assert.deepEqual(channels(root)[0].ownerIds, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
