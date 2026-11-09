import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { consolidatePreferences } from "./heartbeat.js";
import { episodeScope, listEpisodes, summarizeEpisode, writeEpisode } from "./episodes.js";
import { MemoryStore } from "./memory.js";
import { visibleScopes } from "./links.js";

const today = new Date().toISOString().slice(0, 10);
function chats(root: string) { return join(root, ".sam", "missions.db"); }

test("summarizeEpisode is deterministic and counts both roles", () => {
  const input = [{ chatId: "12345678-abcd", title: "Desk", messages: [
    { role: "user", content: "Check the stack please", created_at: today + "T01:00:00.000Z" },
    { role: "assistant", content: "Stack is frozen.", created_at: today + "T01:01:00.000Z" },
  ] }];
  const a = summarizeEpisode("trading", today, input);
  assert.equal(a, summarizeEpisode("trading", today, input));
  assert.match(a, /1 chat · 2 messages \(owner 1, SAM 1\)/);
  assert.match(a, /owner: "Check the stack please"/);
  assert.match(a, /SAM replied 1 time, last: "Stack is frozen\."/);
});

test("writeEpisode lands profile-scoped in missions.db, visible only to its own profile", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-ep-"));
  try {
    const rec = writeEpisode(root, "trading", today, [{ chatId: "c1", title: "Desk", messages: [{ role: "user", content: "hello day", created_at: today + "T02:00:00.000Z" }] }]);
    assert.ok(rec);
    assert.equal(rec.scope, "profile:trading");
    assert.equal(rec.source, "episode:trading:" + today);
    assert.equal(episodeScope("sam"), "core");
    const store = new MemoryStore(chats(root));
    try {
      assert.equal(store.list(undefined, visibleScopes(root, "trading")).filter(r => r.id === rec.id).length, 1);
      assert.equal(store.list(undefined, visibleScopes(root, "dip")).filter(r => r.id === rec.id).length, 0);
      assert.equal(store.search("hello", 10, visibleScopes(root, "trading")).length, 1);
    } finally { store.close(); }
    assert.equal(listEpisodes(root, "trading").length, 1);
    assert.equal(listEpisodes(root, "dip").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a day consolidates into ONE live episode that grows, never fragments", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-ep2-"));
  try {
    writeEpisode(root, "trading", today, [{ chatId: "c1", title: "Morning", messages: [{ role: "user", content: "morning topic", created_at: today + "T08:00:00.000Z" }] }]);
    const grown = writeEpisode(root, "trading", today, [{ chatId: "c2", title: "Evening", messages: [{ role: "user", content: "evening topic", created_at: today + "T20:00:00.000Z" }] }]);
    const live = listEpisodes(root, "trading");
    assert.equal(live.length, 1);
    assert.equal(live[0].id, grown?.id);
    assert.match(live[0].content, /morning topic/);
    assert.match(live[0].content, /evening topic/);
    assert.match(live[0].content, /2 chats · 2 messages/);
    // Rewriting identical evidence is a no-op in substance: same summary text.
    const again = writeEpisode(root, "trading", today, [{ chatId: "c2", title: "Evening", messages: [{ role: "user", content: "evening topic", created_at: today + "T20:00:00.000Z" }] }]);
    assert.equal(again?.content, live[0].content);
    assert.equal(listEpisodes(root, "trading").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("consolidation writes episodes per profile from the same watermark scan, once per new message", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-ep3-"));
  try {
    const db = new ChatStore(root);
    const a = db.create("Trading desk", "trading");
    db.add(a.id, "user", "Watch the frozen stack");
    db.add(a.id, "assistant", "Watching it.");
    const b = db.create("Personal", "dip");
    db.add(b.id, "user", "Plan the weekend");
    db.close();
    const first = consolidatePreferences(root);
    assert.deepEqual([...first.episodes].sort(), ["dip:" + today, "trading:" + today]);
    const trading = listEpisodes(root, "trading");
    assert.equal(trading.length, 1);
    assert.match(trading[0].content, /Watch the frozen stack/);
    assert.doesNotMatch(trading[0].content, /Plan the weekend/);
    assert.equal(listEpisodes(root, "dip").length, 1);
    // No new messages: no new episodes, the live records are untouched.
    const second = consolidatePreferences(root);
    assert.deepEqual(second.episodes, []);
    assert.equal(listEpisodes(root, "trading")[0].id, trading[0].id);
    // A later message the same day grows that day's single episode.
    const db2 = new ChatStore(root);
    db2.add(a.id, "user", "Any movement yet");
    db2.close();
    const third = consolidatePreferences(root);
    assert.deepEqual(third.episodes, ["trading:" + today]);
    const grown = listEpisodes(root, "trading");
    assert.equal(grown.length, 1);
    assert.match(grown[0].content, /Watch the frozen stack/);
    assert.match(grown[0].content, /Any movement yet/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("writeEpisode refuses bad profile and date, and ignores empty days", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-ep4-"));
  try {
    assert.throws(() => writeEpisode(root, "Bad Profile", today, [{ chatId: "c", title: "t", messages: [{ role: "user", content: "x", created_at: today }] }]), /Invalid profile/);
    assert.throws(() => writeEpisode(root, "trading", "2026-13-99x", [{ chatId: "c", title: "t", messages: [{ role: "user", content: "x", created_at: today }] }]), /Invalid episode date/);
    assert.equal(writeEpisode(root, "trading", today, [{ chatId: "c", title: "t", messages: [] }]), null);
    assert.equal(listEpisodes(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
