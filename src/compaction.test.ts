import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { MemoryStore } from "./memory.js";
import {
  COMPACT_KEEP_MESSAGES, COMPACT_SUMMARY_MAX_CHARS, buildChatContext,
  digestSegment, foldBoundary, forceCompactChat, getCompaction, mergeSummary,
} from "./compaction.js";

// Plan Phase A item 2: context compression with a memory flush.
function scratch(chats: Array<{ profile?: string; visitor?: boolean; exchanges: number; pad?: number }>) {
  const root = mkdtempSync(join(tmpdir(), "sam-compact-"));
  const db = new ChatStore(root);
  const ids: string[] = [];
  try {
    db.createAgent("biz", "A business profile.");
    for (const spec of chats) {
      const chat = db.create("Long chat", spec.profile ?? null, { visitor: !!spec.visitor });
      for (let i = 1; i <= spec.exchanges; i++) {
        db.add(chat.id, "user", "topic-" + i + " please" + (spec.pad ? " " + "x".repeat(spec.pad) : ""));
        db.add(chat.id, "assistant", "answer-" + i + " done" + (spec.pad ? " " + "y".repeat(spec.pad) : ""));
      }
      ids.push(chat.id);
    }
  } finally { db.close(); }
  return { root, ids };
}
function historyOf(root: string, chatId: string) {
  const db = new ChatStore(root);
  try { return db.messages(chatId); } finally { db.close(); }
}
function flushRecords(root: string, scope: string) {
  const mem = new MemoryStore(join(root, ".sam", "missions.db"));
  try { return mem.list(undefined, [scope]).filter(r => r.source.startsWith("compaction:")); }
  finally { mem.close(); }
}

test("compaction: a short chat is untouched - no summary, no record, no flush", () => {
  const { root, ids } = scratch([{ exchanges: 5 }]);
  try {
    const ctx = buildChatContext(root, { chatId: ids[0], profile: "sam", visitor: false, history: historyOf(root, ids[0]) });
    assert.equal(ctx.summary, null);
    assert.equal(ctx.compactedNow, false);
    assert.equal(ctx.kept.length, 10);
    assert.equal(getCompaction(root, ids[0]), null);
    assert.equal(flushRecords(root, "core").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compaction: crossing the trigger folds older turns, keeps the newest exchanges verbatim", () => {
  const { root, ids } = scratch([{ exchanges: 20 }]); // 40 messages
  try {
    const history = historyOf(root, ids[0]);
    const ctx = buildChatContext(root, { chatId: ids[0], profile: "sam", visitor: false, history });
    assert.equal(ctx.compactedNow, true);
    assert.ok(ctx.summary && ctx.summary.includes("topic-1"), "summary carries the folded head");
    assert.ok(ctx.summary!.includes("messages from this chat were folded"), "summary says what it is");
    assert.ok(ctx.kept.length <= COMPACT_KEEP_MESSAGES, "kept tail is bounded: " + ctx.kept.length);
    assert.equal(ctx.kept[0].role, "user", "kept tail opens on a user message");
    assert.ok(ctx.kept[0].content.includes("topic-"), "kept turns are verbatim");
    assert.ok(!ctx.kept.some(m => m.content.includes("topic-1 ")), "the oldest exchange is folded, not kept");
    const record = getCompaction(root, ids[0]);
    assert.ok(record && record.covered === ctx.covered && record.covered + ctx.kept.length === history.length);
    // Raw turns are never deleted: the store still holds all 40.
    assert.equal(historyOf(root, ids[0]).length, 40);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compaction: the fold boundary never splits an exchange", () => {
  // A history that does not alternate cleanly: an extra assistant
  // message makes the naive cut land mid-exchange.
  const msgs = [
    { role: "user" as const, content: "a" }, { role: "assistant" as const, content: "b" },
    { role: "assistant" as const, content: "b2" }, { role: "user" as const, content: "c" },
    { role: "assistant" as const, content: "d" }, { role: "user" as const, content: "e" },
  ];
  assert.equal(foldBoundary(msgs, 0, 3), 3, "boundary steps back to the user message that opens the next exchange");
  assert.equal(foldBoundary(msgs, 0, 2), -1, "no safe boundary inside one exchange");
  assert.equal(digestSegment(msgs.slice(0, 2)), '- owner: "a"\n- SAM: "b"');
});

test("compaction: the memory flush is written for the acting profile, before the summary exists", () => {
  const { root, ids } = scratch([{ profile: "biz", exchanges: 20 }]);
  try {
    buildChatContext(root, { chatId: ids[0], profile: "biz", visitor: false, history: historyOf(root, ids[0]) });
    const flush = flushRecords(root, "profile:biz");
    assert.equal(flush.length, 1);
    assert.match(flush[0].source, new RegExp("^compaction:" + ids[0] + ":\\d+$"));
    assert.ok(flush[0].content.includes("topic-1"), "the flush holds the folded segment's digest");
    assert.equal(flush[0].kind, "observation", "the flush is the soft tier: an observation, never law");
    // Profile scoping: the core scope sees none of biz's flush.
    assert.equal(flushRecords(root, "core").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compaction: visitor chats compact for context but flush NOTHING to memory", () => {
  const { root, ids } = scratch([{ profile: "biz", visitor: true, exchanges: 20 }]);
  try {
    const ctx = buildChatContext(root, { chatId: ids[0], profile: "biz", visitor: true, history: historyOf(root, ids[0]) });
    assert.equal(ctx.compactedNow, true, "the visitor prompt still compacts");
    assert.ok(ctx.summary, "a summary exists for the prompt");
    assert.equal(flushRecords(root, "profile:biz").length, 0, "a customer's words never become memory");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compaction: long messages trigger on chars even below the message count", () => {
  const { root, ids } = scratch([{ exchanges: 8, pad: 1500 }]); // 16 messages, ~24k chars
  try {
    const history = historyOf(root, ids[0]);
    assert.ok(history.length <= 24 && history.reduce((n, m) => n + m.content.length, 0) > 16000, "fixture is char-hot, count-cold");
    const ctx = buildChatContext(root, { chatId: ids[0], profile: "sam", visitor: false, history });
    assert.equal(ctx.compactedNow, true);
    assert.ok(ctx.covered >= 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compaction: a second fold is incremental - it folds only the new segment and merges summaries", () => {
  const { root, ids } = scratch([{ exchanges: 20 }]);
  try {
    const first = buildChatContext(root, { chatId: ids[0], profile: "sam", visitor: false, history: historyOf(root, ids[0]) });
    const db = new ChatStore(root);
    try { for (let i = 21; i <= 40; i++) { db.add(ids[0], "user", "topic-" + i + " please"); db.add(ids[0], "assistant", "answer-" + i + " done"); } }
    finally { db.close(); }
    const second = buildChatContext(root, { chatId: ids[0], profile: "sam", visitor: false, history: historyOf(root, ids[0]) });
    assert.equal(second.compactedNow, true);
    assert.ok(second.covered > first.covered, "coverage advanced");
    assert.ok(second.summary!.includes("topic-1") && second.summary!.includes("topic-25"), "the merged summary spans both segments");
    assert.equal(flushRecords(root, "core").length, 2, "one flush per fold");
    // A third call with no growth folds nothing and replays summary + tail.
    const third = buildChatContext(root, { chatId: ids[0], profile: "sam", visitor: false, history: historyOf(root, ids[0]) });
    assert.equal(third.compactedNow, false);
    assert.equal(third.covered, second.covered);
    assert.equal(third.summary, second.summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compaction: the summary stays bounded no matter how much folds into it", () => {
  const big = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "exchange " + i + " " + "z".repeat(400) }));
  let summary: string | null = null;
  for (let at = 0; at < big.length; at += 20) summary = mergeSummary(summary, digestSegment(big.slice(at, at + 20)), at + 20);
  assert.ok(summary!.length <= COMPACT_SUMMARY_MAX_CHARS, "bounded at " + summary!.length);
  assert.ok(summary!.includes("omitted from this summary"), "overflow is marked, never silent");
});

test("compaction: forceCompactChat folds a below-trigger chat on the CLI's word", () => {
  const { root, ids } = scratch([{ exchanges: 10 }]); // 20 messages, below the 24 trigger
  try {
    const result = forceCompactChat(root, ids[0]);
    assert.equal(result.compactedNow, true);
    assert.equal(result.kept.length, COMPACT_KEEP_MESSAGES);
    assert.throws(() => forceCompactChat(root, "no-such-chat"), /Chat not found/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compaction: a chat past the old 100-message death line folds instead of throwing", () => {
  const { root, ids } = scratch([{ exchanges: 60 }]); // 120 messages
  try {
    const ctx = buildChatContext(root, { chatId: ids[0], profile: "sam", visitor: false, history: historyOf(root, ids[0]) });
    assert.equal(ctx.compactedNow, true);
    assert.ok(ctx.kept.length <= COMPACT_KEEP_MESSAGES);
    assert.equal(ctx.covered + ctx.kept.length, 120);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agent-turn rides compaction and no longer carries the history-limit throw", () => {
  const src = readFileSync(new URL("../src/agent-turn.ts", import.meta.url), "utf8");
  assert.ok(src.includes("buildChatContext"), "agent-turn builds its context through compaction");
  assert.ok(!src.includes('throw Error("Chat history limit reached")'), "the 100-message death is gone");
  assert.ok(src.includes("Compacted summary of earlier turns"), "the summary is labelled in the prompt");
});
