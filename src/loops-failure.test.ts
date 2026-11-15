import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import {
  adoptLoopChat, closeLoop, dueLoops, getOpenLoop, isLoopStoreLedgered,
  listLoops, loopStoreFailureSummary, openLoop, openLoopCount,
  rescheduleLoop, updateLoopAnswer, updateOpenLoop,
} from "./loops.js";
import { classifyDefect } from "./self-work.js";

// Loop store failure visibility (gap found 2026-11-14,
// hourly run 22:04): the loop store (.sam/loops.db) is the
// SECOND ANSWERS record - listLoops rides recall into every
// new session's prompt, the status payload, loop-revisit,
// and the CLI; the mutation doors ride sam_open_loop, the
// revisit's writes, and the CLI - and every touch opened it
// raw: a dead loops.db threw into whichever catch wrapped
// the call, none naming the store. Each touch now ledgers
// ONE loop-store-failed line (phase read / write) and
// rethrows exactly, tagged; every caller's handling is
// unchanged and reads still fail closed (never folded as
// no loops, which would silently drop every open loop).
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-loops-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "loop-store-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "loops.db"), { force: true });
  mkdirSync(join(root, ".sam", "loops.db"), { recursive: true });
}

test("loop-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(loopStoreFailureSummary("read", "unable to open\n  database   file"), "Loop store read failed: unable to open database file");
  assert.equal(loopStoreFailureSummary("write", "disk gone"), "Loop store write failed: disk gone");
  assert.equal(loopStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "loop-store-failed", summary: loopStoreFailureSummary(phase, "boom") }),
      { key: "loop-store-failed:" + phase, label: "loop store failures (" + phase + " step)" },
    );
  }
});

test("loop-store-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", () => {
  const root = scratch();
  try {
    const healthy = openLoop(root, { profile: "sam", question: "Did the secret stack restart?", answer: "Not yet.", watchFor: "the stack moving" });
    plantDeadStore(root);

    assert.throws(() => listLoops(root), (e: unknown) => isLoopStoreLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Loop store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "loop-store-failed:read", label: "loop store failures (read step)" });

    assert.throws(() => getOpenLoop(root, healthy.id), (e: unknown) => isLoopStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "the lookup touch ledgers exactly one more line");
    assert.ok(lines[1].summary.startsWith("Loop store read failed: "), lines[1].summary);

    assert.throws(() => openLoop(root, { profile: "sam", question: "Another question?", watchFor: "movement" }), (e: unknown) => isLoopStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3, "the open touch ledgers exactly one write line");
    assert.ok(lines[2].summary.startsWith("Loop store write failed: "), lines[2].summary);
    assert.deepEqual(classifyDefect(lines[2]), { key: "loop-store-failed:write", label: "loop store failures (write step)" });

    assert.throws(() => closeLoop(root, healthy.id), (e: unknown) => isLoopStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 4, "a mutation door's inner read touch ledgers exactly one line, never two for one touch");
    assert.ok(lines[3].summary.startsWith("Loop store read failed: "), lines[3].summary);

    assert.throws(() => updateOpenLoop(root, healthy.id, { status: "closed" }), (e: unknown) => isLoopStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 5, "the update door's inner read touch ledgers exactly one more line");

    assert.ok(!JSON.stringify(lines).includes("secret stack"), "no loop question ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("Not yet."), "no loop answer ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop-store-failed: an absent store reads as no loops, and nothing is created or ledgered", () => {
  const root = scratch();
  try {
    assert.deepEqual(listLoops(root), []);
    assert.equal(getOpenLoop(root, "nope"), null);
    assert.deepEqual(dueLoops(root), []);
    assert.equal(openLoopCount(root), 0);
    assert.equal(updateOpenLoop(root, "nope", { status: "closed" }), null);
    assert.equal(closeLoop(root, "nope"), null);
    assert.equal(rescheduleLoop(root, "nope"), null);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing, not even the .sam directory");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop-store-failed: validation errors are not store failures and ledger nothing", () => {
  const root = scratch();
  try {
    assert.throws(() => openLoop(root, { profile: "sam", question: "  ", watchFor: "movement" }), (e: unknown) => /An open loop needs the question/.test((e as Error).message) && !isLoopStoreLedgered(e));
    assert.throws(() => openLoop(root, { profile: "sam", question: "Q?", watchFor: " " }), (e: unknown) => /watchFor/.test((e as Error).message) && !isLoopStoreLedgered(e));
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop-store-failed: a healthy store opens, reads, mutates, and closes with zero failure lines", () => {
  const root = scratch();
  try {
    const loop = openLoop(root, { profile: "sam", question: "Is it live?", answer: "Pending.", watchFor: "it moving", dueInHours: 1 });
    assert.equal(listLoops(root).length, 1);
    assert.equal(getOpenLoop(root, loop.id)?.question, "Is it live?");
    assert.equal(openLoopCount(root), 1);
    const rescheduled = rescheduleLoop(root, loop.id, new Date("2026-11-03T00:00:00.000Z"));
    assert.equal(rescheduled?.checks, 1);
    const updated = updateLoopAnswer(root, loop.id, "It is live.", new Date("2026-11-03T01:00:00.000Z"));
    assert.equal(updated?.answer, "It is live.");
    const adopted = adoptLoopChat(root, loop.id, "chat-9");
    assert.equal(adopted?.chatId, "chat-9");
    const closed = closeLoop(root, loop.id, "Settled.");
    assert.equal(closed?.status, "closed");
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop-store-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const root = scratch();
  try {
    openLoop(root, { profile: "sam", question: "First?", watchFor: "movement" });
    const raw = openDatabase(join(root, ".sam", "loops.db"));
    try {
      raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON open_loops BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => openLoop(root, { profile: "sam", question: "Second?", watchFor: "movement" }), (e: unknown) => isLoopStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Loop store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
