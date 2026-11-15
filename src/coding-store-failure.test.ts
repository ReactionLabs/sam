import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { ChatStore } from "./chats.js";
import { setCodeRoot } from "./code.js";
import { openDatabase } from "./sqlite.js";
import {
  codingStoreFailureSummary, codingSummary, getCodingTask, isCodingStoreLedgered,
  listCodingTasks, queueCodingTask, updateCodingTask,
} from "./coding.js";
import { classifyDefect } from "./self-work.js";

// Coding store failure visibility (gap found 2026-11-15,
// hourly run 17:04): the coding store (.sam/coding.db) is
// the C3 loop's queue - listCodingTasks / codingSummary
// ride the status payload, the CLI overview, and the
// heartbeat drain; the row writes ride every drain
// transition - and every touch opened it raw: a dead
// coding.db threw into whichever catch wrapped the call,
// none naming the store. Each touch now ledgers ONE
// coding-store-failed line (phase read / write) and
// rethrows exactly, tagged; every caller's handling is
// unchanged and reads still fail closed (never folded as
// no tasks, which would silently empty the queue dressed
// as an idle loop).
function fresh(): { base: string; sam: string; proj: string } {
  const base = mkdtempSync(join(tmpdir(), "sam-coding-store-fail-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  return { base, sam, proj };
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "coding-store-failed" });
}

function scratchChat(root: string): string {
  const db = new ChatStore(root);
  try { return db.create("Desk", "trading").id; } finally { db.close(); }
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "coding.db"), { force: true });
  mkdirSync(join(root, ".sam", "coding.db"), { recursive: true });
}

test("coding-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(codingStoreFailureSummary("read", "unable to open\n  database   file"), "Coding store read failed: unable to open database file");
  assert.equal(codingStoreFailureSummary("write", "disk gone"), "Coding store write failed: disk gone");
  assert.equal(codingStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "coding-store-failed", summary: codingStoreFailureSummary(phase, "boom") }),
      { key: "coding-store-failed:" + phase, label: "coding store failures (" + phase + " step)" },
    );
  }
});

test("coding-store-failed: a healthy queue, read, and update round trip ledgers no failure line", () => {
  const { base, sam, proj } = fresh();
  try {
    setCodeRoot(sam, proj);
    const chatId = scratchChat(sam);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Build the secret zorblax widget" });
    assert.equal(listCodingTasks(sam).length, 1);
    assert.equal(getCodingTask(sam, task.id)?.spec, "Build the secret zorblax widget");
    const updated = updateCodingTask(sam, task.id, { status: "blocked" });
    assert.equal(updated?.status, "blocked");
    assert.equal(codingSummary(sam).blocked, 1);
    assert.equal(failedLines(sam).length, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("coding-store-failed: an absent store reads as no tasks, creates nothing, and ledgers nothing", () => {
  const { base, sam } = fresh();
  try {
    assert.deepEqual(listCodingTasks(sam), []);
    assert.equal(getCodingTask(sam, "nope"), null);
    assert.equal(updateCodingTask(sam, "nope", { status: "blocked" }), null);
    assert.equal(failedLines(sam).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(sam, ".sam")), false, "a pure read creates nothing, not even the .sam directory");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("coding-store-failed: a torn row still parses forgiving and ledgers nothing", () => {
  const { base, sam, proj } = fresh();
  try {
    setCodeRoot(sam, proj);
    const chatId = scratchChat(sam);
    queueCodingTask(sam, { actor: "trading", chatId, spec: "A real task" });
    const db = openDatabase(join(sam, ".sam", "coding.db"));
    try { db.prepare("INSERT INTO coding_tasks (id, data) VALUES (?, ?)").run("torn-1", "{ not json"); } finally { db.close(); }
    assert.equal(listCodingTasks(sam).length, 1, "the torn row is skipped, the real task still reads");
    assert.equal(failedLines(sam).length, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("coding-store-failed: a dead store ledgers exactly one line per touch, tagged, rethrows, and carries no task content", () => {
  const { base, sam, proj } = fresh();
  try {
    setCodeRoot(sam, proj);
    const chatId = scratchChat(sam);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Build the secret zorblax widget" });
    plantDeadStore(sam);

    assert.throws(() => listCodingTasks(sam), (e: unknown) => isCodingStoreLedgered(e));
    let lines = failedLines(sam);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Coding store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "coding-store-failed:read", label: "coding store failures (read step)" });

    assert.throws(() => getCodingTask(sam, task.id), (e: unknown) => isCodingStoreLedgered(e));
    lines = failedLines(sam);
    assert.equal(lines.length, 2, "the lookup touch ledgers exactly one more line");
    assert.ok(lines[1].summary.startsWith("Coding store read failed: "), lines[1].summary);

    assert.throws(() => updateCodingTask(sam, task.id, { status: "blocked" }), (e: unknown) => isCodingStoreLedgered(e));
    lines = failedLines(sam);
    assert.equal(lines.length, 3, "the update door's inner read touch ledgers exactly one line, never two for one touch");
    assert.ok(lines[2].summary.startsWith("Coding store read failed: "), lines[2].summary);

    assert.ok(!JSON.stringify(lines).includes("zorblax"), "no task spec ever enters a failure line");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("coding-store-failed: validation errors are not store failures and ledger nothing", () => {
  const { base, sam, proj } = fresh();
  try {
    assert.throws(() => queueCodingTask(sam, { actor: "Bad Actor", chatId: "c1", spec: "x" }), (e: unknown) => /Invalid actor/.test((e as Error).message) && !isCodingStoreLedgered(e));
    assert.throws(() => queueCodingTask(sam, { actor: "trading", chatId: "c1", spec: "  " }), (e: unknown) => /Invalid coding spec/.test((e as Error).message) && !isCodingStoreLedgered(e));
    assert.throws(() => queueCodingTask(sam, { actor: "trading", chatId: "", spec: "x" }), (e: unknown) => /A chat is required/.test((e as Error).message) && !isCodingStoreLedgered(e));
    assert.throws(() => queueCodingTask(sam, { actor: "trading", chatId: "c1", spec: "x" }), (e: unknown) => /No code root is designated/.test((e as Error).message) && !isCodingStoreLedgered(e));
    assert.equal(failedLines(sam).length, 0);
    assert.equal(existsSync(join(sam, ".sam", "coding.db")), false, "no validation refusal created the store");
    void proj;
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("coding-store-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const { base, sam, proj } = fresh();
  try {
    setCodeRoot(sam, proj);
    const chatId = scratchChat(sam);
    queueCodingTask(sam, { actor: "trading", chatId, spec: "First task" });
    const raw = openDatabase(join(sam, ".sam", "coding.db"));
    try {
      raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON coding_tasks BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => queueCodingTask(sam, { actor: "trading", chatId, spec: "Second task" }), (e: unknown) => isCodingStoreLedgered(e));
    const lines = failedLines(sam);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Coding store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "coding-store-failed:write", label: "coding store failures (write step)" });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("coding-store-failed: a failing update ledgers exactly one write line with the verbatim reason", () => {
  const { base, sam, proj } = fresh();
  try {
    setCodeRoot(sam, proj);
    const chatId = scratchChat(sam);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Build the secret zorblax widget" });
    const raw = openDatabase(join(sam, ".sam", "coding.db"));
    try {
      raw.exec("CREATE TRIGGER planted_update_fail BEFORE UPDATE ON coding_tasks BEGIN SELECT RAISE(ABORT, 'planted update failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => updateCodingTask(sam, task.id, { status: "blocked" }), (e: unknown) => isCodingStoreLedgered(e));
    const lines = failedLines(sam);
    assert.equal(lines.length, 1, "the update touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Coding store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted update failure"), lines[0].summary);
    assert.ok(!lines[0].summary.includes("zorblax"), "no task spec ever enters a failure line");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
