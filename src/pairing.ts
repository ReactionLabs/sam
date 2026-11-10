import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { channels, setChannelOwners, type Channel } from "./channels.js";
import { recordActivity } from "./activity.js";

// Pairing-code channel auth (Plan Phase A item 3): how a person proves they
// belong on a channel's owner list without the operator hand-copying numeric
// IDs out of a candidate file. The operator issues a code on the CLI (shown
// once, only its sha256 is stored); the person sends it to the bot within the
// hour; redemption adds their sender id to the channel's ownerIds through the
// same setChannelOwners door the CLI has always used. Default-deny ordering
// is unchanged: owners are checked first, a pairing attempt second, and
// everyone else is still silently ignored (no oracle for strangers - the
// door-guard precedent). Failed attempts are counted per channel and trip a
// lockout, ledgered once per lockout like the door probes.
export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0, 1 - nothing confusable
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 3_600_000; // 1 hour (plan doc)
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 600_000; // 10 minutes
const LOCK_MS = 900_000; // 15 minutes
const MAX_CODE_RECORDS = 64;

interface PairingCodeRecord { id: string; channelId: string; codeHash: string; createdAt: string; expiresAt: string; usedBy?: number; usedAt?: string; retired?: boolean }
interface PairingGuard { failures: number[]; lockedUntil: string | null }
interface PairingStore { codes: PairingCodeRecord[]; guards: Record<string, PairingGuard> }

function storePath(root: string): string { return join(resolve(root), ".sam", "pairing.json"); }
function loadStore(root: string): PairingStore {
  if (!existsSync(storePath(root))) return { codes: [], guards: {} };
  const value: unknown = JSON.parse(readFileSync(storePath(root), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid pairing store");
  const store = value as PairingStore;
  if (!Array.isArray(store.codes) || typeof store.guards !== "object" || store.guards === null) throw Error("Invalid pairing store");
  return store;
}
function saveStore(root: string, store: PairingStore): void {
  mkdirSync(join(resolve(root), ".sam"), { recursive: true });
  writeFileSync(storePath(root), JSON.stringify(store, null, 2), { mode: 0o600 });
}
function hashCode(normalized: string): string { return createHash("sha256").update("sam-pairing:" + normalized).digest("hex"); }
function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Normalize a typed code: case-insensitive, dashes/spaces ignored. Returns
// null when the text is not code-shaped at all (an ordinary message).
export function normalizePairingCode(input: string): string | null {
  const flat = input.toUpperCase().replace(/[\s-]+/g, "");
  if (flat.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of flat) if (!PAIRING_ALPHABET.includes(ch)) return null;
  return flat;
}
// Extract a pairing attempt from an incoming message: the whole message is
// the code, or an explicit "pair <code>" / "/pair <code>" command. Anything
// else is conversation, not an attempt, and must not burn the failure budget.
export function pairingAttemptCode(text: string): string | null {
  const trimmed = text.trim();
  const whole = normalizePairingCode(trimmed);
  if (whole) return whole;
  const m = /^\/?pair[:\s]+(\S+)$/i.exec(trimmed);
  return m ? normalizePairingCode(m[1]) : null;
}
export function formatPairingCode(normalized: string): string { return normalized.slice(0, 4) + "-" + normalized.slice(4); }

export function findChannel(root: string, idOrName: string): Channel {
  const found = channels(root).find(c => c.id === idOrName) ?? channels(root).find(c => c.name === idOrName);
  if (!found) throw Error("Channel not found: " + idOrName);
  return found;
}

// Issue a fresh code for a telegram channel. One live code per channel:
// issuing retires the previous unused code, so a re-issue is also the
// revoke. The plaintext is returned exactly once; only its hash is stored.
export function issuePairingCode(root: string, idOrName: string, now = Date.now()): { channel: string; profile: string; code: string; expiresAt: string } {
  const channel = findChannel(root, idOrName);
  if (channel.kind !== "telegram") throw Error("Pairing codes are for telegram channels (owner ids are telegram user ids)");
  if (!channel.enabled) throw Error("Channel is disabled: " + channel.name);
  const store = loadStore(root);
  for (const rec of store.codes) if (rec.channelId === channel.id && !rec.usedAt && !rec.retired) rec.retired = true;
  let normalized = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) normalized += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  const rec: PairingCodeRecord = {
    id: randomUUID(), channelId: channel.id, codeHash: hashCode(normalized),
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
  };
  store.codes = [...store.codes, rec].slice(-MAX_CODE_RECORDS);
  saveStore(root, store);
  recordActivity(root, channel.profile, "pairing-issued", "Pairing code issued for channel " + channel.name + " (expires " + rec.expiresAt + ")");
  return { channel: channel.name, profile: channel.profile, code: formatPairingCode(normalized), expiresAt: rec.expiresAt };
}

export type RedeemResult =
  | { ok: true; channel: Channel }
  | { ok: false; reason: "locked" | "invalid" | "expired" | "used" | "retired" };

// Redeem a code for a sender id. Every non-locked failure (wrong, expired,
// used, retired) counts toward the channel's lockout; the lock check runs
// first and refuses even the correct code while it stands. On success the
// sender joins ownerIds, the code is consumed, and the failure count clears.
export function redeemPairingCode(root: string, channelId: string, rawCode: string, userId: number, now = Date.now()): RedeemResult {
  const channel = channels(root).find(c => c.id === channelId);
  if (!channel) throw Error("Channel not found: " + channelId);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw Error("Invalid owner id");
  const store = loadStore(root);
  const guard: PairingGuard = store.guards[channelId] ?? { failures: [], lockedUntil: null };
  store.guards[channelId] = guard;
  if (guard.lockedUntil && now < Date.parse(guard.lockedUntil)) return { ok: false, reason: "locked" };
  if (guard.lockedUntil) { guard.lockedUntil = null; guard.failures = []; }
  const fail = (reason: "invalid" | "expired" | "used" | "retired"): RedeemResult => {
    guard.failures = [...guard.failures.filter(t => now - t < FAILURE_WINDOW_MS), now];
    if (guard.failures.length >= MAX_FAILURES) {
      guard.lockedUntil = new Date(now + LOCK_MS).toISOString();
      guard.failures = [];
      saveStore(root, store);
      recordActivity(root, channel.profile, "pairing-lockout", "Pairing locked for channel " + channel.name + " until " + guard.lockedUntil + " after repeated failed attempts");
      return { ok: false, reason: "locked" };
    }
    saveStore(root, store);
    return { ok: false, reason };
  };
  const normalized = normalizePairingCode(rawCode);
  if (!normalized) return fail("invalid");
  const digest = hashCode(normalized);
  const rec = store.codes.find(r => r.channelId === channelId && hashEquals(r.codeHash, digest));
  if (!rec) return fail("invalid");
  if (rec.retired) return fail("retired");
  if (rec.usedAt) return fail("used");
  if (now >= Date.parse(rec.expiresAt)) return fail("expired");
  rec.usedBy = userId;
  rec.usedAt = new Date(now).toISOString();
  guard.failures = [];
  guard.lockedUntil = null;
  saveStore(root, store);
  const updated = setChannelOwners(root, channelId, [...channel.ownerIds, userId]);
  recordActivity(root, channel.profile, "pairing-redeemed", "Paired telegram user " + userId + " as an owner of channel " + channel.name);
  return { ok: true, channel: updated };
}

export interface PairingChannelStatus { channel: string; channelId: string; profile: string; owners: number; liveCode: boolean; codeExpiresAt: string | null; recentFailures: number; lockedUntil: string | null }
export function pairingStatus(root: string, now = Date.now()): PairingChannelStatus[] {
  const store = existsSync(storePath(root)) ? loadStore(root) : { codes: [], guards: {} } as PairingStore;
  return channels(root).filter(c => c.kind === "telegram").map(c => {
    const live = store.codes.find(r => r.channelId === c.id && !r.usedAt && !r.retired && now < Date.parse(r.expiresAt));
    const guard = store.guards[c.id];
    const lockedUntil = guard?.lockedUntil && now < Date.parse(guard.lockedUntil) ? guard.lockedUntil : null;
    return {
      channel: c.name, channelId: c.id, profile: c.profile, owners: c.ownerIds.length,
      liveCode: !!live, codeExpiresAt: live ? live.expiresAt : null,
      recentFailures: guard ? guard.failures.filter(t => now - t < FAILURE_WINDOW_MS).length : 0,
      lockedUntil,
    };
  });
}
