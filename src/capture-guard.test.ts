import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CaptureGuardStore, MemorySuppressedError, addSuppression, captureSuppressionsFromText,
  extractSuppressions, filterUnsuppressed, needleMatches,
} from "./capture-guard.js";
import { MemoryStore } from "./memory.js";
import { writeEpisode, episodeEvidence, listEpisodes } from "./episodes.js";
import { ChatStore } from "./chats.js";
import { forceCompactChat } from "./compaction.js";
import { readActivity } from "./activity.js";

// Program H item A: a standing do-not-store instruction binds
// automatic capture at write time. The incident shape (2026-11-14):
// the owner said keep the secret phrase out of memory, and the
// episode flush stored it verbatim anyway. These tests pin the
// mechanism at every layer: extraction, matching, the store, the
// episode flush across cycles, the compaction flush, and the
// MemoryStore backstop that binds every writer.
const PHRASE = "zorblax quindle forty seven";

function scratch(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "sam-guard-"));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("extraction: the explicit do-not-store forms yield the needle, ordinary talk yields nothing", () => {
  assert.deepEqual(extractSuppressions("Keep the Zorblax launch window out of your memory."), ["Zorblax launch window"]);
  assert.deepEqual(extractSuppressions("Do not store the harbor gate code anywhere."), ["harbor gate code"]);
  assert.deepEqual(extractSuppressions("Never remember the blue kettle song."), ["blue kettle song"]);
  assert.deepEqual(extractSuppressions("Please do not keep the tenant list in memory."), ["tenant list"]);
  assert.deepEqual(extractSuppressions("What did we decide about the harbor gate code?"), []);
  assert.deepEqual(extractSuppressions("Remember to water the plants on Friday."), []);
});

test("extraction: the incident shape - a bare keep-it-out plus a named secret in one message", () => {
  const found = extractSuppressions("The secret phrase is " + PHRASE + ", keep it out of memory.");
  assert.equal(found.length, 1);
  assert.ok(needleMatches(found[0], "the phrase was " + PHRASE));
  // A bare instruction with no named secret anywhere binds nothing.
  assert.deepEqual(extractSuppressions("Keep it out of memory, ok?"), []);
});

test("matching: full phrase, or every distinctive word; a single shared word never trips it", () => {
  assert.equal(needleMatches(PHRASE, "owner said: " + PHRASE + " today"), true);
  assert.equal(needleMatches(PHRASE, "zorblax came up; separately, quindle and forty and seven were listed"), true);
  assert.equal(needleMatches(PHRASE, "zorblax is a nice word"), false);
  assert.equal(needleMatches("harbor gate code", "the harbor gate code is 9"), true);
  assert.equal(needleMatches("harbor gate code", "the harbor is nice"), false);
});

test("store: add dedupes, revoke is a status flip, and creation ledgers the live backlog count", () => scratch(root => {
  const mem = new MemoryStore(join(root, ".sam", "missions.db"));
  try { mem.add({ kind: "observation", content: "Earlier the owner mentioned " + PHRASE + " in passing.", source: "test", scope: "profile:dip" }); } finally { mem.close(); }
  const first = addSuppression(root, { profile: "dip", needle: PHRASE, source: "chat-1" });
  assert.equal(first.created, true);
  const lines = readActivity(root, 100).filter(l => l.kind === "memory-suppression");
  assert.equal(lines.length, 1);
  assert.match(lines[0].summary, /1 live memory record\(s\) already match/);
  assert.ok(!lines[0].summary.includes("zorblax"), "the needle never enters the activity line");
  const again = addSuppression(root, { profile: "dip", needle: PHRASE, source: "chat-2" });
  assert.equal(again.created, false);
  assert.equal(again.record.id, first.record.id);
  const guard = new CaptureGuardStore(root);
  try {
    assert.equal(guard.activeFor("dip").length, 1);
    assert.equal(guard.revoke(first.record.id), true);
    assert.equal(guard.activeFor("dip").length, 0);
    assert.equal(guard.list("dip", true).length, 1, "the revoked record survives as a record");
  } finally { guard.close(); }
}));

test("backstop: MemoryStore.add refuses a suppressed record for its scope, and only while the suppression is active", () => scratch(root => {
  const { record } = addSuppression(root, { profile: "dip", needle: PHRASE, source: "test" });
  const mem = new MemoryStore(join(root, ".sam", "missions.db"));
  try {
    assert.throws(() => mem.add({ kind: "observation", content: "the phrase is " + PHRASE, source: "test", scope: "profile:dip" }), MemorySuppressedError);
    assert.throws(() => mem.add({ kind: "observation", content: "the phrase is " + PHRASE, source: "test", scope: "link:123e4567-e89b-42d3-a456-426614174000" }), MemorySuppressedError, "a shared link scope is bound by any profile's suppression");
    const ok = mem.add({ kind: "observation", content: "an ordinary record about the harbor", source: "test", scope: "profile:dip" });
    assert.ok(ok.id);
    assert.equal(mem.list(undefined, ["profile:dip"]).length, 1, "the refused writes stored nothing");
  } finally { mem.close(); }
  const guard = new CaptureGuardStore(root);
  try { assert.equal(guard.revoke(record.id), true); } finally { guard.close(); }
  const mem2 = new MemoryStore(join(root, ".sam", "missions.db"));
  try {
    const after = mem2.add({ kind: "observation", content: "the phrase is " + PHRASE, source: "test", scope: "profile:dip" });
    assert.ok(after.id, "after revocation the same write lands - the owner's word governs both ways");
  } finally { mem2.close(); }
}));

test("episode flush: a suppressed phrase never lands, across repeated flush cycles, and the evidence cache heals", () => scratch(root => {
  addSuppression(root, { profile: "dip", needle: PHRASE, source: "test" });
  const day = "2026-11-14";
  const first = writeEpisode(root, "dip", day, [{ chatId: "chat-aaaa", title: "Morning chat", messages: [
    { role: "user", content: "the secret phrase is " + PHRASE, created_at: day + "T08:00:00.000Z" },
    { role: "user", content: "the harbor report is ready", created_at: day + "T08:01:00.000Z" },
    { role: "assistant", content: "Noted, the harbor report is on the list.", created_at: day + "T08:02:00.000Z" },
  ] }]);
  assert.ok(first, "the day's ordinary content still consolidates");
  assert.ok(!first!.content.includes("zorblax"), "the episode record carries no suppressed words");
  assert.ok(first!.content.includes("harbor report"));
  const evidence = episodeEvidence(root, "dip", day);
  assert.ok(!JSON.stringify(evidence).includes("zorblax"), "the evidence row never held the phrase");
  // A second cycle restating the phrase cannot resurrect it.
  const second = writeEpisode(root, "dip", day, [{ chatId: "chat-aaaa", title: "Morning chat", messages: [
    { role: "user", content: "again: " + PHRASE, created_at: day + "T09:00:00.000Z" },
    { role: "user", content: "the dock meeting moved to noon", created_at: day + "T09:01:00.000Z" },
  ] }]);
  assert.ok(second && !second!.content.includes("zorblax"));
  const episodes = listEpisodes(root, "dip");
  assert.equal(episodes.length, 1, "one live record per day, regenerated");
  assert.ok(!episodes[0].content.includes("zorblax"));
  const blocks = readActivity(root, 100).filter(l => l.kind === "memory-suppressed");
  assert.ok(blocks.length >= 1, "the blocks are ledgered");
  assert.ok(!blocks[0].summary.includes("zorblax"), "the ledger line names the suppression, never the needle");
}));

test("episode flush: a day written BEFORE the suppression existed stops surfacing once the day is fully suppressed", () => scratch(root => {
  const day = "2026-11-13";
  const before = writeEpisode(root, "dip", day, [{ chatId: "chat-bbbb", title: "Old chat", messages: [
    { role: "user", content: "the secret phrase is " + PHRASE, created_at: day + "T08:00:00.000Z" },
  ] }]);
  assert.ok(before && before!.content.includes("zorblax"), "the pre-suppression record is the defect shape itself");
  addSuppression(root, { profile: "dip", needle: PHRASE, source: "test" });
  const after = writeEpisode(root, "dip", day, [{ chatId: "chat-bbbb", title: "Old chat", messages: [
    { role: "user", content: "repeating it: " + PHRASE, created_at: day + "T10:00:00.000Z" },
  ] }]);
  assert.equal(after, null, "a fully suppressed day writes no new record");
  const mem = new MemoryStore(join(root, ".sam", "missions.db"));
  try {
    const old = mem.get(before!.id);
    assert.ok(old?.archived_at, "the stale derived record is archived (not deleted) so recall stops surfacing it");
  } finally { mem.close(); }
  assert.equal(listEpisodes(root, "dip").length, 0);
}));

test("compaction flush: suppressed messages are dropped from the memory flush; the fold itself still lands", () => scratch(root => {
  addSuppression(root, { profile: "dip", needle: PHRASE, source: "test" });
  const chats = new ChatStore(root);
  let chatId = "";
  try {
    const chat = chats.create("Long chat", "dip");
    chatId = chat.id;
    for (let i = 0; i < 26; i++) {
      const content = i === 2 ? "the secret phrase is " + PHRASE : "Turn " + String(i + 1) + " about the harbor plan and its next steps.";
      chats.add(chatId, i % 2 === 0 ? "user" : "assistant", content, "test");
    }
  } finally { chats.close(); }
  const result = forceCompactChat(root, chatId);
  assert.equal(result.compactedNow, true);
  const mem = new MemoryStore(join(root, ".sam", "missions.db"));
  try {
    const flush = mem.list(undefined, ["profile:dip"]).find(r => r.source.startsWith("compaction:"));
    assert.ok(flush, "the flush record exists");
    assert.ok(!flush!.content.includes("zorblax"), "the flush carries no suppressed words");
    assert.ok(flush!.content.includes("harbor plan"), "the rest of the segment still flushed");
  } finally { mem.close(); }
  assert.ok(readActivity(root, 100).some(l => l.kind === "memory-suppressed" && l.summary.includes("via compaction")));
}));

test("preference seam: suppressed finds are filtered before they can reach the preference store", () => scratch(root => {
  addSuppression(root, { profile: "dip", needle: PHRASE, source: "test" });
  const found = [
    { statement: "the phrase " + PHRASE, kind: "like" as const },
    { statement: "concise answers", kind: "like" as const },
  ];
  const kept = filterUnsuppressed(root, "dip", found);
  assert.deepEqual(kept.map(f => f.statement), ["concise answers"]);
}));

test("capture seam: the owner's own words create the suppression that then binds", () => scratch(root => {
  const created = captureSuppressionsFromText(root, "dip", "The secret phrase is " + PHRASE + ", keep it out of memory.", "chat-9");
  assert.equal(created.length, 1);
  const mem = new MemoryStore(join(root, ".sam", "missions.db"));
  try {
    assert.throws(() => mem.add({ kind: "observation", content: "saving " + PHRASE, source: "test", scope: "profile:dip" }), MemorySuppressedError);
  } finally { mem.close(); }
}));
