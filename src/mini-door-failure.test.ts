import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import {
  doorEnabled, doorFailureSummary, doorForKey, doorHomeLink, doorModeForKey,
  isDoorLedgered, issueDoorKey, listDoors, peekSessionChat, readDoorStore,
  rotateSessionChat,
} from "./mini-door.js";
import { classifyDefect } from "./self-work.js";

// Mini-door store failure visibility (gap found 2026-11-14,
// hourly run 09:04): every door surface rides ONE internal
// read, load(), and it threw raw on a dead mini-doors.db -
// the dashboard door handler's key resolution died with no
// line, the owner/visitor scoping read died with it, and
// the status payload / CLI doors audit threw raw on the
// same touch. Each touch now ledgers ONE door-failed line
// and rethrows exactly, tagged; resolution still fails
// closed (never an invalid key, never a valid one).
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-door-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "door-failed" });
}

function plantDeadStore(root: string): void {
  mkdirSync(join(root, ".sam", "mini-doors.db"), { recursive: true });
}

const KEY = "a".repeat(64);
const SESSION = "session-1234567890";

test("door-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(doorFailureSummary("read", "unable to open\n  database   file"), "Door read failed: unable to open database file");
  assert.equal(doorFailureSummary("resolve", "disk gone"), "Door resolve failed: disk gone");
  assert.equal(doorFailureSummary("read", "x".repeat(500)).length, 200);
  for (const [phase, summary] of [["read", doorFailureSummary("read", "boom")], ["resolve", doorFailureSummary("resolve", "boom")]] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "door-failed", summary }),
      { key: "door-failed:" + phase, label: "mini-door store failures (" + phase + " step)" },
    );
  }
});

test("door-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows - never resolving as an invalid key", () => {
  const root = scratch();
  try {
    plantDeadStore(root);
    assert.throws(() => doorForKey(root, KEY), (e: unknown) => isDoorLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Door resolve failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "door-failed:resolve", label: "mini-door store failures (resolve step)" });

    assert.throws(() => doorModeForKey(root, KEY), (e: unknown) => isDoorLedgered(e));
    assert.throws(() => doorHomeLink(root, KEY), (e: unknown) => isDoorLedgered(e));
    assert.throws(() => peekSessionChat(root, "sam", SESSION), (e: unknown) => isDoorLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 4, "each resolver touch ledgers exactly one more line, never two for one touch");
    assert.ok(lines.every(l => l.summary.startsWith("Door resolve failed: ")));

    assert.throws(() => listDoors(root));
    assert.throws(() => doorEnabled(root, "sam"));
    assert.throws(() => readDoorStore(root));
    lines = failedLines(root);
    assert.equal(lines.length, 7);
    assert.ok(lines.slice(4).every(l => l.summary.startsWith("Door read failed: ")), "direct readers ledger the read shape");
    assert.deepEqual(classifyDefect(lines[4]), { key: "door-failed:read", label: "mini-door store failures (read step)" });

    let created = false;
    assert.throws(() => rotateSessionChat(root, "sam", SESSION, () => { created = true; return "chat-x"; }), (e: unknown) => isDoorLedgered(e));
    assert.equal(created, false, "a failed resolve never creates the replacement chat");
    lines = failedLines(root);
    assert.equal(lines.length, 8);
    assert.ok(lines[7].summary.startsWith("Door resolve failed: "), lines[7].summary);

    assert.ok(!lines.some(l => l.summary.includes(KEY)), "no door key ever enters a failure line");
    assert.ok(!lines.some(l => l.summary.includes(SESSION)), "no session id ever enters a failure line");
    assert.ok(!lines.some(l => l.summary.includes("keyHash")), "no door record ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("door-failed: an absent store reads empty, resolves null, and creates nothing", () => {
  const root = scratch();
  try {
    assert.equal(doorForKey(root, KEY), null);
    assert.equal(doorModeForKey(root, KEY), null);
    assert.equal(doorHomeLink(root, KEY), false);
    assert.equal(peekSessionChat(root, "sam", SESSION), null);
    assert.deepEqual(listDoors(root), []);
    assert.equal(doorEnabled(root, "sam"), false);
    assert.deepEqual(readDoorStore(root), { doors: [], sessions: [] });
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam", "mini-doors.db")), false, "a pure read creates no store");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("door-failed: a healthy door resolves, lists, and reads back with zero failure lines", () => {
  const root = scratch();
  try {
    const key = issueDoorKey(root, "sam");
    assert.equal(doorForKey(root, key), "sam");
    assert.equal(doorModeForKey(root, key), "owner");
    assert.equal(doorHomeLink(root, key), false);
    assert.equal(doorEnabled(root, "sam"), true);
    const audit = listDoors(root);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].mini, "sam");
    assert.equal(readDoorStore(root).doors.length, 1);
    assert.equal(peekSessionChat(root, "sam", SESSION), null);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
