import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLoop, dueLoops, getOpenLoop, listLoops, openLoop, rescheduleLoop, updateLoopAnswer, updateOpenLoop, type OpenLoop } from "./loops.js";

// State convergence (UNIFICATION item 4, eighth store): the
// open-loop store migrated from whole-file loops.json rewrites
// to one-row-per-loop SQLite. These tests pin the migration
// contract: legacy files import in order with every field
// intact, are renamed (never deleted), a malformed file imports
// nothing and stays put, a pure read creates nothing (not even
// the .sam directory the old read path created), single-row
// mutations cannot lose each other, and the revisit mutations
// over a migrated legacy loop persist through row updates alone.

function fresh(): { base: string; sam: string } {
  const base = mkdtempSync(join(tmpdir(), "sam-loops-store-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  return { base, sam };
}

function legacyLoop(id: string, question: string, extra: Partial<OpenLoop> = {}): OpenLoop {
  return {
    id, profile: "sam", chatId: "chat-1", question, answer: "Not yet.",
    watchFor: "anything moving", dueAt: "2026-11-02T00:00:00.000Z",
    status: "open", createdAt: "2026-11-01T00:00:00.000Z", ...extra,
  };
}

test("loops store: a legacy loops.json imports in order, fields intact, file renamed not deleted", () => {
  const { base, sam } = fresh();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    const closed = legacyLoop("loop-1", "Did the key land?", {
      status: "closed", closedAt: "2026-11-01T12:00:00.000Z", resolution: "It landed.",
      everyHours: 6, checks: 3, lastCheckedAt: "2026-11-01T11:00:00.000Z",
    });
    const open = legacyLoop("loop-2", "Is the stack restarted?");
    writeFileSync(join(sam, ".sam", "loops.json"), JSON.stringify({ version: 1, loops: [closed, open] }, null, 2));
    const items = listLoops(sam);
    assert.deepEqual(items.map(l => l.id), ["loop-1", "loop-2"]);
    assert.deepEqual(items[0], closed);
    assert.deepEqual(items[1], open);
    assert.equal(existsSync(join(sam, ".sam", "loops.db")), true);
    assert.equal(existsSync(join(sam, ".sam", "loops.json")), false);
    assert.equal(existsSync(join(sam, ".sam", "loops.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(sam, ".sam", "loops.json.migrated"), "utf8")) as { loops: unknown[] };
    assert.equal(kept.loops.length, 2);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("loops store: a malformed legacy file imports nothing and is left in place", () => {
  const { base, sam } = fresh();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    writeFileSync(join(sam, ".sam", "loops.json"), "{ not json");
    assert.deepEqual(listLoops(sam), []);
    assert.equal(existsSync(join(sam, ".sam", "loops.json")), true);
    assert.equal(existsSync(join(sam, ".sam", "loops.json.migrated")), false);
    // A fresh open over the malformed file still works (the old
    // reader read malformed as empty) and lands in the DB only.
    const loop = openLoop(sam, { profile: "sam", question: "Fresh?", watchFor: "movement" });
    assert.equal(getOpenLoop(sam, loop.id)?.question, "Fresh?");
    assert.equal(existsSync(join(sam, ".sam", "loops.json")), true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("loops store: a pure read on an empty install creates nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-loops-store-empty-"));
  try {
    assert.deepEqual(listLoops(root), []);
    assert.deepEqual(dueLoops(root), []);
    assert.equal(getOpenLoop(root, "nope"), null);
    assert.equal(updateOpenLoop(root, "nope", { status: "closed" }), null);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loops store: interleaved opens and a single-row update all survive (no whole-file lost update)", () => {
  const { base, sam } = fresh();
  try {
    const a = openLoop(sam, { profile: "sam", question: "Alpha?", answer: "Pending.", watchFor: "alpha moving" });
    const b = openLoop(sam, { profile: "trading", question: "Beta?", answer: "Pending.", watchFor: "beta moving" });
    const patched = updateOpenLoop(sam, a.id, { dueAt: "2026-11-01T00:00:00.000Z" });
    assert.equal(patched?.dueAt, "2026-11-01T00:00:00.000Z");
    assert.equal(updateOpenLoop(sam, "ghost", { status: "closed" }), null);
    const items = listLoops(sam);
    assert.deepEqual(items.map(l => l.id), [a.id, b.id]);
    assert.equal(items[0].question, "Alpha?");
    assert.equal(items[1].question, "Beta?");
    assert.equal(getOpenLoop(sam, b.id)?.profile, "trading");
    assert.equal(existsSync(join(sam, ".sam", "loops.json")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("loops store: revisit mutations over a migrated legacy loop persist through row updates", () => {
  const { base, sam } = fresh();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    const legacy = legacyLoop("loop-9", "Is the stack restarted?", { everyHours: 2, checks: 0 });
    writeFileSync(join(sam, ".sam", "loops.json"), JSON.stringify({ version: 1, loops: [legacy] }, null, 2));
    assert.equal(dueLoops(sam, new Date("2026-11-03T00:00:00.000Z")).map(l => l.id).join(","), "loop-9");
    const rescheduled = rescheduleLoop(sam, "loop-9", new Date("2026-11-03T00:00:00.000Z"));
    assert.equal(rescheduled?.checks, 1);
    assert.equal(rescheduled?.dueAt, "2026-11-03T02:00:00.000Z");
    const updated = updateLoopAnswer(sam, "loop-9", "It restarted.", new Date("2026-11-03T02:00:00.000Z"));
    assert.equal(updated?.answer, "It restarted.");
    assert.equal(updated?.checks, 2);
    const closed = closeLoop(sam, "loop-9", "Settled.");
    assert.equal(closed?.status, "closed");
    assert.equal(closeLoop(sam, "loop-9"), null);
    const items = listLoops(sam);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "closed");
    assert.equal(items[0].resolution, "Settled.");
    assert.equal(existsSync(join(sam, ".sam", "loops.json")), false);
    assert.equal(existsSync(join(sam, ".sam", "loops.db")), true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
