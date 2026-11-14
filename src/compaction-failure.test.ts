import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { openDatabase } from "./sqlite.js";
import { MemoryStore } from "./memory.js";
import { readActivity, recordActivity } from "./activity.js";
import { buildChatContext, compactionFailureSummary, getCompaction } from "./compaction.js";
import { classifyDefect, rankDefects } from "./self-work.js";

// Compaction failure visibility (gap found 2026-11-13, hourly run
// 11:04): the fold's three durable steps (read / flush / save) used
// to fail silently under agent-turn's fail-open catch. Each failure
// now writes exactly one compaction-failed activity line and
// rethrows, and the memory flush is retry-safe (a save failure no
// longer duplicates the segment's flush record on the next fold).
function scratch(exchanges: number) {
  const root = mkdtempSync(join(tmpdir(), "sam-compact-fail-"));
  const db = new ChatStore(root);
  let chatId = "";
  try {
    const chat = db.create("Long chat", null, { visitor: false });
    chatId = chat.id;
    for (let i = 1; i <= exchanges; i++) {
      db.add(chat.id, "user", "topic-" + i + " please");
      db.add(chat.id, "assistant", "answer-" + i + " done");
    }
  } finally { db.close(); }
  const store = new ChatStore(root);
  let history;
  try { history = store.messages(chatId); } finally { store.close(); }
  return { root, chatId, history };
}
function flushRecords(root: string) {
  const mem = new MemoryStore(join(root, ".sam", "missions.db"));
  try { return mem.list(undefined, ["core"]).filter(r => r.source.startsWith("compaction:")); }
  finally { mem.close(); }
}
function failedLines(root: string) {
  return readActivity(root, 100, { kind: "compaction-failed" });
}

test("compaction-failed: a dead memory store ledgers one flush line and rethrows, with no message content", () => {
  const { root, chatId, history } = scratch(20);
  try {
    mkdirSync(join(root, ".sam", "missions.db")); // a directory where the DB file belongs: every open throws
    assert.throws(() => buildChatContext(root, { chatId, profile: "sam", visitor: false, history }));
    assert.throws(() => buildChatContext(root, { chatId, profile: "sam", visitor: false, history }),
      "a persistent failure recurs per attempt - that recurrence is the countable signal");
    const lines = failedLines(root);
    assert.equal(lines.length, 2, "exactly one line per failed attempt");
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Compaction flush failed for chat " + chatId.slice(0, 8) + ": "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("topic-1"), "no message content enters the line");
    assert.equal(getCompaction(root, chatId), null, "the flush-first invariant holds: no summary was saved");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compaction-failed: a save failure ledgers once, and the retry folds without duplicating the flush", () => {
  const { root, chatId, history } = scratch(20);
  try {
    const raw = openDatabase(join(root, ".sam", "chats.db"));
    raw.exec("CREATE TRIGGER planted_save_fail BEFORE INSERT ON chat_compactions BEGIN SELECT RAISE(ABORT, 'planted save failure'); END;");
    raw.close();
    assert.throws(() => buildChatContext(root, { chatId, profile: "sam", visitor: false, history }), /planted save failure/);
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Compaction save failed for chat " + chatId.slice(0, 8) + ": "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted save failure"), "the verbatim reason rides the line");
    assert.equal(flushRecords(root).length, 1, "the flush landed before the save died - flush first, as designed");
    assert.equal(getCompaction(root, chatId), null, "no summary was saved");
    const raw2 = openDatabase(join(root, ".sam", "chats.db"));
    raw2.exec("DROP TRIGGER planted_save_fail;");
    raw2.close();
    const ctx = buildChatContext(root, { chatId, profile: "sam", visitor: false, history });
    assert.equal(ctx.compactedNow, true, "the retry folds");
    assert.equal(flushRecords(root).length, 1, "the retry added NO duplicate flush for the same segment");
    assert.ok(getCompaction(root, chatId), "the summary is saved on the retry");
    assert.equal(failedLines(root).length, 1, "a healthy fold writes no failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compaction-failed: a dead chat store ledgers one read line and rethrows", () => {
  const { root, chatId, history } = scratch(20);
  try {
    rmSync(join(root, ".sam", "chats.db"), { force: true });
    rmSync(join(root, ".sam", "chats.db-wal"), { force: true });
    rmSync(join(root, ".sam", "chats.db-shm"), { force: true });
    mkdirSync(join(root, ".sam", "chats.db"));
    assert.throws(() => buildChatContext(root, { chatId, profile: "sam", visitor: false, history }));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Compaction read failed for chat " + chatId.slice(0, 8) + ": "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compaction-failed: a healthy fold writes no failure line, and the summary shape is bounded and content-free", () => {
  const { root, chatId, history } = scratch(20);
  try {
    const ctx = buildChatContext(root, { chatId, profile: "sam", visitor: false, history });
    assert.equal(ctx.compactedNow, true);
    assert.equal(failedLines(root).length, 0);
    assert.equal(readActivity(root, 100, { kind: "compaction" }).length, 1, "the success line still lands");
    const s = compactionFailureSummary("abcdef123456", "flush", "database\n  is   locked");
    assert.equal(s, "Compaction flush failed for chat abcdef12: database is locked");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compaction-failed: the class classifies by phase", () => {
  const line = (summary: string) => ({ at: "2026-11-13T16:00:00.000Z", actor: "sam", kind: "compaction-failed", summary });
  assert.deepEqual(classifyDefect(line("Compaction read failed for chat abcdef12: unable to open")),
    { key: "compaction-failed:read", label: "compaction failures (read step)" });
  assert.deepEqual(classifyDefect(line("Compaction flush failed for chat abcdef12: unable to open")),
    { key: "compaction-failed:flush", label: "compaction failures (flush step)" });
  assert.deepEqual(classifyDefect(line("Compaction save failed for chat abcdef12: planted save failure")),
    { key: "compaction-failed:save", label: "compaction failures (save step)" });
  // The success kind of the same family stays unclassified.
  assert.equal(classifyDefect({ at: "2026-11-13T16:00:00.000Z", actor: "sam", kind: "compaction", summary: "Compacted chat abcdef12" }), null);
});

test("compaction-failed: rankDefects counts the phases from the ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-compact-rank2-"));
  try {
    recordActivity(root, "sam", "compaction-failed", "Compaction flush failed for chat abcdef12: unable to open database file");
    recordActivity(root, "sam", "compaction-failed", "Compaction flush failed for chat abcdef12: unable to open database file");
    recordActivity(root, "sam", "compaction-failed", "Compaction save failed for chat abcdef12: planted save failure");
    const ranked = rankDefects(root).filter(d => d.source === "ledger");
    const byKey = new Map(ranked.map(d => [d.key, d.count]));
    assert.equal(byKey.get("compaction-failed:flush"), 2);
    assert.equal(byKey.get("compaction-failed:save"), 1);
    assert.equal(ranked[0].key, "compaction-failed:flush", "the recurring phase tops the queue");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
