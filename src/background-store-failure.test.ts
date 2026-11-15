import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { ChatStore } from "./chats.js";
import { openDatabase } from "./sqlite.js";
import {
  backgroundStoreFailureSummary, getBackgroundTask, isBackgroundStoreLedgered,
  listBackgroundTasks, queueBackgroundTask, updateBackgroundTask,
} from "./background.js";
import { classifyDefect } from "./self-work.js";

// Background store failure visibility (gap found 2026-11-15,
// hourly run 18:04): the background store (.sam/background.db)
// is the P5 legs queue - listBackgroundTasks rides the
// dashboard status payload, the morning brief, and the
// UNIFICATION census; the row writes ride the heartbeat
// drain's transitions and updateBackgroundTask - and every
// touch opened it raw: a dead background.db threw into
// whichever catch wrapped the call, none naming the store.
// Each touch now ledgers ONE background-store-failed line
// (phase read / write) and rethrows exactly, tagged; every
// caller's handling is unchanged and reads still fail closed
// (never folded as no tasks, which would silently empty the
// legs queue dressed as an idle install).
function fresh(): { base: string; sam: string } {
  const base = mkdtempSync(join(tmpdir(), "sam-background-store-fail-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  return { base, sam };
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "background-store-failed" });
}

function scratchChat(root: string): string {
  const db = new ChatStore(root);
  try { return db.create("Desk", "trading").id; } finally { db.close(); }
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "background.db"), { force: true });
  mkdirSync(join(root, ".sam", "background.db"), { recursive: true });
}

test("background-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(backgroundStoreFailureSummary("read", "unable to open\n  database   file"), "Background store read failed: unable to open database file");
  assert.equal(backgroundStoreFailureSummary("write", "disk gone"), "Background store write failed: disk gone");
  assert.equal(backgroundStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "background-store-failed", summary: backgroundStoreFailureSummary(phase, "boom") }),
      { key: "background-store-failed:" + phase, label: "background store failures (" + phase + " step)" },
    );
  }
});

test("background-store-failed: a healthy queue, read, and update round trip ledgers no failure line", () => {
  const { base, sam } = fresh();
  try {
    const chatId = scratchChat(sam);
    const task = queueBackgroundTask(sam, { actor: "trading", chatId, prompt: "Research the secret zorblax market" });
    assert.equal(listBackgroundTasks(sam).length, 1);
    assert.equal(getBackgroundTask(sam, task.id)?.prompt, "Research the secret zorblax market");
    const updated = updateBackgroundTask(sam, task.id, { status: "failed", result: "done checking" });
    assert.equal(updated?.status, "failed");
    assert.equal(failedLines(sam).length, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("background-store-failed: an absent store reads as no tasks, creates nothing, and ledgers nothing", () => {
  const { base, sam } = fresh();
  try {
    assert.deepEqual(listBackgroundTasks(sam), []);
    assert.equal(getBackgroundTask(sam, "nope"), null);
    assert.equal(updateBackgroundTask(sam, "nope", { status: "failed" }), null);
    assert.equal(failedLines(sam).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(sam, ".sam")), false, "a pure read creates nothing, not even the .sam directory");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("background-store-failed: a torn row still parses forgiving and ledgers nothing", () => {
  const { base, sam } = fresh();
  try {
    const chatId = scratchChat(sam);
    queueBackgroundTask(sam, { actor: "trading", chatId, prompt: "A real task" });
    const db = openDatabase(join(sam, ".sam", "background.db"));
    try { db.prepare("INSERT INTO background_tasks (id, data) VALUES (?, ?)").run("torn-1", "{ not json"); } finally { db.close(); }
    assert.equal(listBackgroundTasks(sam).length, 1, "the torn row is skipped, the real task still reads");
    assert.equal(failedLines(sam).length, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("background-store-failed: a dead store ledgers exactly one line per touch, tagged, rethrows, and carries no task content", () => {
  const { base, sam } = fresh();
  try {
    const chatId = scratchChat(sam);
    const task = queueBackgroundTask(sam, { actor: "trading", chatId, prompt: "Research the secret zorblax market" });
    plantDeadStore(sam);

    assert.throws(() => listBackgroundTasks(sam), (e: unknown) => isBackgroundStoreLedgered(e));
    let lines = failedLines(sam);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Background store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "background-store-failed:read", label: "background store failures (read step)" });

    assert.throws(() => getBackgroundTask(sam, task.id), (e: unknown) => isBackgroundStoreLedgered(e));
    lines = failedLines(sam);
    assert.equal(lines.length, 2, "the lookup touch ledgers exactly one more line");
    assert.ok(lines[1].summary.startsWith("Background store read failed: "), lines[1].summary);

    assert.throws(() => updateBackgroundTask(sam, task.id, { status: "failed" }), (e: unknown) => isBackgroundStoreLedgered(e));
    lines = failedLines(sam);
    assert.equal(lines.length, 3, "the update door's inner read touch ledgers exactly one line, never two for one touch");
    assert.ok(lines[2].summary.startsWith("Background store read failed: "), lines[2].summary);

    assert.throws(() => queueBackgroundTask(sam, { actor: "trading", chatId, prompt: "Another task" }), (e: unknown) => isBackgroundStoreLedgered(e));
    lines = failedLines(sam);
    assert.equal(lines.length, 4, "a handoff on a dead store dies at its read touch with exactly one line");
    assert.ok(lines[3].summary.startsWith("Background store read failed: "), lines[3].summary);

    assert.ok(!JSON.stringify(lines).includes("zorblax"), "no task prompt ever enters a failure line");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("background-store-failed: validation errors are not store failures and ledger nothing", () => {
  const { base, sam } = fresh();
  try {
    assert.throws(() => queueBackgroundTask(sam, { actor: "Bad Actor", chatId: "c1", prompt: "x" }), (e: unknown) => /Invalid actor/.test((e as Error).message) && !isBackgroundStoreLedgered(e));
    assert.throws(() => queueBackgroundTask(sam, { actor: "trading", chatId: "c1", prompt: "  " }), (e: unknown) => /Invalid background prompt/.test((e as Error).message) && !isBackgroundStoreLedgered(e));
    assert.throws(() => queueBackgroundTask(sam, { actor: "trading", chatId: "", prompt: "x" }), (e: unknown) => /A chat is required/.test((e as Error).message) && !isBackgroundStoreLedgered(e));
    assert.equal(failedLines(sam).length, 0);
    assert.equal(existsSync(join(sam, ".sam", "background.db")), false, "no validation refusal created the store");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("background-store-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const { base, sam } = fresh();
  try {
    const chatId = scratchChat(sam);
    queueBackgroundTask(sam, { actor: "trading", chatId, prompt: "First task" });
    const raw = openDatabase(join(sam, ".sam", "background.db"));
    try {
      raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON background_tasks BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => queueBackgroundTask(sam, { actor: "trading", chatId, prompt: "Second task" }), (e: unknown) => isBackgroundStoreLedgered(e));
    const lines = failedLines(sam);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Background store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "background-store-failed:write", label: "background store failures (write step)" });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("background-store-failed: a failing update ledgers exactly one write line with the verbatim reason", () => {
  const { base, sam } = fresh();
  try {
    const chatId = scratchChat(sam);
    const task = queueBackgroundTask(sam, { actor: "trading", chatId, prompt: "Research the secret zorblax market" });
    const raw = openDatabase(join(sam, ".sam", "background.db"));
    try {
      raw.exec("CREATE TRIGGER planted_update_fail BEFORE UPDATE ON background_tasks BEGIN SELECT RAISE(ABORT, 'planted update failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => updateBackgroundTask(sam, task.id, { status: "failed" }), (e: unknown) => isBackgroundStoreLedgered(e));
    const lines = failedLines(sam);
    assert.equal(lines.length, 1, "the update touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Background store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted update failure"), lines[0].summary);
    assert.ok(!lines[0].summary.includes("zorblax"), "no task prompt ever enters a failure line");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
