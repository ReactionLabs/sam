import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import { channelForChat, isTelegramStateStoreLedgered, loadBridgeState, saveBridgeState, telegramStateStoreFailureSummary, type BridgeState } from "./telegram.js";
import { classifyDefect } from "./self-work.js";

// Telegram state store failure visibility (gap found
// 2026-11-15, hourly run 14:04): the telegram state store
// (.sam/telegram-state.db - the bridge's one row holding the
// poll offset, the telegram-chat -> SAM-chat map, and the
// pairing candidate) touched its file raw at loadBridgeState
// and saveBridgeState, so a dead store threw with the seam
// unnamed into the bridge's first load, the heartbeat tick's
// channel delivery, and channelForChat, which folds every
// failure to null. Each touch now ledgers ONE
// telegram-state-failed line (read door at phase read, write
// door at phase write) and rethrows exactly, tagged; every
// caller's handling is unchanged and reads still fail closed
// (never folded as the empty bridge state, which would
// silently reset the poll offset and lose the chat map).
function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-telegram-state-fail-")); }

const STATE: BridgeState = {
  offset: 51110615,
  chats: { "6300316150": "5d363679-6e35-4e42-bf77-5e20794205be" },
  pairingCandidate: { id: 999, username: "stranger", first_name: "Stranger", at: "2026-11-11T05:27:00.000Z" },
};

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "telegram-state-failed" });
}

function plantDeadStore(root: string): void {
  mkdirSync(join(root, ".sam", "telegram-state.db"), { recursive: true });
}

test("telegram-state-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(telegramStateStoreFailureSummary("read", "unable to open\n  database   file"), "Telegram state store read failed: unable to open database file");
  assert.equal(telegramStateStoreFailureSummary("write", "disk gone"), "Telegram state store write failed: disk gone");
  assert.equal(telegramStateStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "telegram-state-failed", summary: telegramStateStoreFailureSummary(phase, "boom") }),
      { key: "telegram-state-failed:" + phase, label: "telegram state store failures (" + phase + " step)" },
    );
  }
});

test("telegram-state-failed: a healthy round trip ledgers nothing", () => {
  const root = fresh();
  try {
    saveBridgeState(root, STATE);
    assert.deepEqual(loadBridgeState(root), STATE);
    assert.equal(failedLines(root).length, 0);
    assert.equal(existsSync(join(root, ".sam", "activity.jsonl")), false, "no activity file was created at all");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("telegram-state-failed: an absent store reads as the empty state, creates nothing, and ledgers nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(loadBridgeState(root), { offset: 0, chats: {} });
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("telegram-state-failed: a torn row still parses forgiving to the empty state and ledgers nothing", () => {
  const root = fresh();
  try {
    saveBridgeState(root, STATE);
    const db = openDatabase(join(root, ".sam", "telegram-state.db"));
    try { db.prepare("UPDATE telegram_state SET data = ? WHERE id = 1").run("{ not json"); } finally { db.close(); }
    assert.deepEqual(loadBridgeState(root), { offset: 0, chats: {} });
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("telegram-state-failed: a dead store at read ledgers exactly one read line, tagged, rethrows, and carries no state content", () => {
  const root = fresh();
  try {
    plantDeadStore(root);
    assert.throws(() => loadBridgeState(root), (e: unknown) => isTelegramStateStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Telegram state store read failed: "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("6300316150"), "a chat id is the owner's data, not failure data");
    assert.ok(!lines[0].summary.includes("stranger"), "the pairing candidate's identity is the owner's data, not failure data");
    assert.deepEqual(classifyDefect(lines[0]), { key: "telegram-state-failed:read", label: "telegram state store failures (read step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("telegram-state-failed: channelForChat still folds a dead store to null and gains no second line", () => {
  const root = fresh();
  try {
    plantDeadStore(root);
    assert.equal(channelForChat(root, "5d363679-6e35-4e42-bf77-5e20794205be"), null);
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the load's touch ledgered once; the folding caller added nothing");
    assert.ok(lines[0].summary.startsWith("Telegram state store read failed: "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("telegram-state-failed: a dead store at write ledgers exactly one write line, tagged, rethrows, and carries no state content", () => {
  const root = fresh();
  try {
    plantDeadStore(root);
    assert.throws(() => saveBridgeState(root, STATE), (e: unknown) => isTelegramStateStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Telegram state store write failed: "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("6300316150"), "a chat id is the owner's data, not failure data");
    assert.deepEqual(classifyDefect(lines[0]), { key: "telegram-state-failed:write", label: "telegram state store failures (write step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
