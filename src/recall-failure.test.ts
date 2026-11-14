import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { MemoryStore } from "./memory.js";
import {
  buildRecallBlock, recallFailureSummary, recordRecallFailure, searchRecallHits,
} from "./recall.js";
import { classifyDefect } from "./self-work.js";

// Recall failure visibility (gap found 2026-11-14, hourly run
// 04:04): every recall seam was silent - agent-turn wraps the
// whole block in a catch-all and the FTS search folded its
// failure to [] - so a dead scope read, memory store, loop
// read, list read, or search made SAM answer with no memory
// at all, indistinguishable from knowing nothing. Each seam
// now ledgers ONE recall-failed line per call and degrades to
// only its own section; a total failure reads as empty memory.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-recall-fail-"));
}

function seed(root: string): void {
  mkdirSync(join(root, ".sam"), { recursive: true });
  const store = new MemoryStore(join(root, ".sam", "missions.db"));
  try {
    store.add({ kind: "observation", source: "episode:sam:2026-11-09", scope: "core", content: "Episode 2026-11-09 · profile sam · 1 chat · Main chat: owner asked how many coins you see; SAM summed up the harness base." });
    store.add({ kind: "observation", source: "sam-saved", scope: "core", content: "The owner drinks a cortado, not a latte." });
  } finally { store.close(); }
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "recall-failed" });
}

test("recall-failed: summary shape collapses and caps the reason, and self-work classifies by phase", () => {
  const summary = recallFailureSummary("sam", "search", "fts5:  corrupt\n  index   fell over");
  assert.equal(summary, "Recall search failed for sam: fts5: corrupt index fell over");
  const long = recallFailureSummary("sam", "assemble", "x".repeat(500));
  assert.equal(long.length, 200);
  const root = scratch();
  try {
    recordRecallFailure(root, "sam", "loops", new Error("loops store is a directory"));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.deepEqual(classifyDefect(lines[0]), { key: "recall-failed:loops", label: "recall failures (loops step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recall-failed: a dead memory store reads as empty memory with exactly one assemble line", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, ".sam", "missions.db"), { recursive: true });
    const block = buildRecallBlock(root, { actor: "sam", message: "what did we say about the secret marmalade plan?" });
    assert.equal(block, "", "a total recall failure reads exactly as an empty memory does");
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "exactly one line for the failed assembly");
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Recall assemble failed for sam: "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("marmalade"), "the owner's message text never enters the failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recall-failed: a corrupt memory store ledgers exactly one line, never a per-seam spray", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "missions.db"), "this is not a sqlite database at all");
    const block = buildRecallBlock(root, { actor: "sam", message: "anything at all today", sessionStart: true });
    assert.equal(block, "");
    assert.equal(failedLines(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recall-failed: a dead loops store drops only the loops section - episodes still assemble, exactly one loops line", () => {
  const root = scratch();
  try {
    seed(root);
    mkdirSync(join(root, ".sam", "loops.db"), { recursive: true });
    const block = buildRecallBlock(root, { actor: "sam", message: "what did we talk about last time?", sessionStart: true });
    assert.match(block, /how many coins you see/, "the episode section survives the dead loops seam");
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "exactly one line - the loops seam alone");
    assert.ok(lines[0].summary.startsWith("Recall loops failed for sam: "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recall-failed: the guarded search ledgers one search line and reads as no hits", () => {
  const root = scratch();
  try {
    const stub = { search(): never { throw new Error("fts5 index  exploded"); } };
    const hits = searchRecallHits(root, "sam", stub as never, "cortado OR latte", ["core"]);
    assert.deepEqual(hits, []);
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].summary, "Recall search failed for sam: fts5 index exploded");
    assert.ok(!lines[0].summary.includes("cortado, not a latte"), "record content never enters the failure line");
    // With a caller callback (the buildRecallBlock dedupe path)
    // the helper records nothing itself.
    let seen: unknown = null;
    const again = searchRecallHits(root, "sam", stub as never, "cortado", ["core"], e => { seen = e; });
    assert.deepEqual(again, []);
    assert.ok(seen instanceof Error);
    assert.equal(failedLines(root).length, 1, "the callback path adds no second line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recall-failed: a healthy recall ledgers nothing", () => {
  const root = scratch();
  try {
    seed(root);
    const block = buildRecallBlock(root, { actor: "sam", message: "remind me, do I drink a cortado?", sessionStart: true });
    assert.match(block, /cortado, not a latte/);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
