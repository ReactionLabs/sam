import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel, channels } from "./channels.js";
import {
  PAIRING_TTL_MS, formatPairingCode, issuePairingCode, normalizePairingCode,
  pairingAttemptCode, pairingStatus, readPairingStore, redeemPairingCode,
} from "./pairing.js";

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-pairing-")); }
const T0 = Date.parse("2026-11-09T00:00:00.000Z");

test("pairing codes: shape, normalization, and attempt extraction", () => {
  assert.equal(normalizePairingCode("abcd-2345"), "ABCD2345");
  assert.equal(normalizePairingCode(" ABCD 2345 "), "ABCD2345");
  assert.equal(normalizePairingCode("ABCD234"), null); // too short
  assert.equal(normalizePairingCode("ABCD23456"), null); // too long
  assert.equal(normalizePairingCode("ABCDO015"), null); // O, 0, 1, 5 is fine but O/0/1 are excluded letters - O and 0 and 1 kill it
  assert.equal(normalizePairingCode("hello there friend"), null);
  assert.equal(formatPairingCode("ABCD2345"), "ABCD-2345");
  assert.equal(pairingAttemptCode("ABCD-2345"), "ABCD2345");
  assert.equal(pairingAttemptCode("pair ABCD2345"), "ABCD2345");
  assert.equal(pairingAttemptCode("/pair abcd-2345"), "ABCD2345");
  assert.equal(pairingAttemptCode("what is the stack status?"), null);
  assert.equal(pairingAttemptCode("pair"), null);
});

test("issue: code shown once, only its hash stored, 1-hour expiry, re-issue retires", () => {
  const root = scratch();
  try {
    const c = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN");
    const first = issuePairingCode(root, "Dip Telegram", T0);
    assert.match(first.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(Date.parse(first.expiresAt) - T0, PAIRING_TTL_MS);
    const stored = JSON.stringify(readPairingStore(root));
    assert.equal(stored.includes(first.code.replace("-", "")), false, "plaintext code must never be stored");
    assert.equal(stored.includes(first.code), false);
    assert.match(readPairingStore(root).codes[0].codeHash, /^[0-9a-f]{64}$/);
    const status = pairingStatus(root, T0 + 1000);
    assert.equal(status.length, 1);
    assert.equal(status[0].liveCode, true);
    assert.equal(status[0].codeExpiresAt, first.expiresAt);
    // Re-issue retires the first code: it now redeems as retired, the new one works.
    const second = issuePairingCode(root, c.id, T0 + 2000);
    assert.notEqual(second.code, first.code);
    assert.deepEqual(redeemPairingCode(root, c.id, first.code, 777, T0 + 3000), { ok: false, reason: "retired" });
    const ok = redeemPairingCode(root, c.id, second.code, 777, T0 + 4000);
    assert.equal(ok.ok, true);
    assert.deepEqual(channels(root)[0].ownerIds, [777]);
    // Refusals: unknown channel, non-telegram channel.
    assert.throws(() => issuePairingCode(root, "nope", T0), /Channel not found/);
    addChannel(root, "discord", "Ops Discord", "trading", "SAM_CHANNEL_DC_MAIN");
    assert.throws(() => issuePairingCode(root, "Ops Discord", T0), /telegram/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("redeem: single use, expiry, and wrong codes all refuse without adding owners", () => {
  const root = scratch();
  try {
    const c = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN");
    const issued = issuePairingCode(root, c.id, T0);
    // Expired: one ms past the TTL.
    assert.deepEqual(redeemPairingCode(root, c.id, issued.code, 555, T0 + PAIRING_TTL_MS), { ok: false, reason: "expired" });
    // Wrong code (flip the first char to a different alphabet char).
    const wrong = (issued.code[0] === "A" ? "B" : "A") + issued.code.slice(1);
    assert.deepEqual(redeemPairingCode(root, c.id, wrong, 555, T0 + 1000), { ok: false, reason: "invalid" });
    assert.deepEqual(channels(root)[0].ownerIds, []);
    // The real code still works after those failures, exactly once.
    assert.equal(redeemPairingCode(root, c.id, issued.code.toLowerCase(), 555, T0 + 2000).ok, true);
    assert.deepEqual(redeemPairingCode(root, c.id, issued.code, 556, T0 + 3000), { ok: false, reason: "used" });
    assert.deepEqual(channels(root)[0].ownerIds, [555]);
    // Ledger carries the pairing, never the code.
    const ledger = readFileSync(join(root, ".sam", "activity.jsonl"), "utf8");
    assert.match(ledger, /pairing-issued/);
    assert.match(ledger, /pairing-redeemed/);
    assert.equal(ledger.includes(issued.code.replace("-", "")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("redeem: five failures lock the channel, the correct code waits out the lock, locks are per-channel", () => {
  const root = scratch();
  try {
    const a = addChannel(root, "telegram", "Chan A", "trading", "SAM_CHANNEL_TG_A");
    const b = addChannel(root, "telegram", "Chan B", "trading", "SAM_CHANNEL_TG_B");
    const issuedA = issuePairingCode(root, a.id, T0);
    const issuedB = issuePairingCode(root, b.id, T0);
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(redeemPairingCode(root, a.id, "ZZZZ-ZZZZ", 999, T0 + i * 1000), { ok: false, reason: "invalid" });
    }
    // Fifth failure trips the lock and reports locked.
    assert.deepEqual(redeemPairingCode(root, a.id, "ZZZZ-ZZZZ", 999, T0 + 5000), { ok: false, reason: "locked" });
    // Even the correct code is refused during the lock.
    assert.deepEqual(redeemPairingCode(root, a.id, issuedA.code, 999, T0 + 6000), { ok: false, reason: "locked" });
    const statusA = pairingStatus(root, T0 + 6000).find(s => s.channelId === a.id)!;
    assert.ok(statusA.lockedUntil);
    assert.equal(statusA.recentFailures, 0); // the count cleared into the lock
    // Channel B is untouched by A's lock.
    assert.equal(redeemPairingCode(root, b.id, issuedB.code, 888, T0 + 6000).ok, true);
    // After the 15-minute lock (tripped at T0+5s, so open again at
    // T0+905s; the code's 1-hour TTL still has room), it redeems.
    assert.equal(redeemPairingCode(root, a.id, issuedA.code, 999, T0 + 906_000).ok, true);
    assert.deepEqual(channels(root).find(c => c.id === a.id)!.ownerIds, [999]);
    const ledger = readFileSync(join(root, ".sam", "activity.jsonl"), "utf8");
    assert.match(ledger, /pairing-lockout/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
