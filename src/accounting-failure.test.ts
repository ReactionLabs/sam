import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { recordUsage, usageFailureSummary, usageSummary } from "./usage.js";
import { noteCapTrip, recordSessionTurn, sessionCapsFailureSummary, sessionUsageToday } from "./session-caps.js";
import { classifyDefect, rankDefects } from "./self-work.js";

// Turn accounting failure visibility (gap found 2026-11-13, hourly
// run 12:04): the two accounting ledgers every turn writes had
// opposite, both-wrong failure disciplines - recordUsage swallowed
// its write failures whole (spend silently froze while the
// summaries kept reporting it as truth), and recordSessionTurn /
// noteCapTrip appended unguarded (a dead caps ledger threw at the
// end of a completed turn, masked the real error on the failure
// path, and could kill the graceful cap reply). Both now follow
// the house contract: accounting never breaks a turn, and each
// failed write ledgers exactly one failure line.
const ENTRY = { actor: "dip", route: "chat" as const, tier: "main" as const, model: "MiniMax-M2.5", promptTokens: 987654, completionTokens: 5 };

function scratch() {
  return mkdtempSync(join(tmpdir(), "sam-accounting-fail-"));
}

// Plant a directory where a ledger file belongs: every append to
// that path throws EISDIR, the dead-ledger shape.
function plantDir(root: string, name: string) {
  mkdirSync(join(root, ".sam"), { recursive: true });
  mkdirSync(join(root, ".sam", name));
}

test("usage-failed: a dead usage ledger ledgers one line per failed write and still returns null", () => {
  const root = scratch();
  try {
    plantDir(root, "usage.jsonl"); // every append throws
    assert.equal(recordUsage(root, ENTRY), null, "accounting never breaks the caller");
    assert.equal(recordUsage(root, ENTRY), null, "a persistent failure recurs per write - that recurrence is the countable signal");
    const lines = readActivity(root, 100, { kind: "usage-failed" });
    assert.equal(lines.length, 2, "exactly one line per failed write");
    assert.equal(lines[0].actor, "dip");
    assert.ok(lines[0].summary.startsWith("Usage record failed for model MiniMax-M2.5: "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("987654"), "the entry's token counts never enter the line");
    assert.equal(usageSummary(root).calls, 0, "nothing was recorded - the frozen total is exactly why the failure line matters");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("usage-failed: a healthy write records and ledgers nothing; malformed usage stays silent by design", () => {
  const root = scratch();
  try {
    const line = recordUsage(root, ENTRY);
    assert.ok(line && line.totalTokens === 987659);
    assert.equal(recordUsage(root, { ...ENTRY, promptTokens: -1 }), null, "a malformed report records nothing");
    assert.equal(readActivity(root, 100, { kind: "usage-failed" }).length, 0, "no failure line for a healthy write or a validation refusal");
    assert.equal(usageSummary(root).calls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("session-caps-failed: a dead caps ledger never throws out of a turn record, and ledgers one line", () => {
  const root = scratch();
  try {
    plantDir(root, "session-caps.jsonl");
    assert.doesNotThrow(() => recordSessionTurn(root, { chatId: "abcd1234-0000-4000-8000-000000000000", route: "chat", tokens: 987654 }),
      "a completed turn must survive its own accounting");
    const lines = readActivity(root, 100, { kind: "session-caps-failed" });
    assert.equal(lines.length, 1, "exactly one line for the failed write");
    assert.ok(lines[0].summary.startsWith("Session caps turn record failed for chat abcd1234: "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("987654"), "the turn's token count never enters the line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("session-caps-failed: a failed cap trip returns not-noted and never throws; a healthy trip records once", () => {
  const root = scratch();
  try {
    plantDir(root, "session-caps.jsonl");
    let noted: boolean | undefined;
    assert.doesNotThrow(() => { noted = noteCapTrip(root, "abcd1234-0000-4000-8000-000000000000", "chat", "turns"); },
      "the graceful cap reply must survive its own trip record");
    assert.equal(noted, false, "an unrecorded trip reads as not-noted, so no session-cap line rides it");
    const lines = readActivity(root, 100, { kind: "session-caps-failed" });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Session caps cap trip failed for chat abcd1234: "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }

  const ok = scratch();
  try {
    recordSessionTurn(ok, { chatId: "abcd1234-0000-4000-8000-000000000000", route: "chat", tokens: 7 });
    assert.equal(noteCapTrip(ok, "abcd1234-0000-4000-8000-000000000000", "chat", "turns"), true, "the first trip of the day records");
    assert.equal(noteCapTrip(ok, "abcd1234-0000-4000-8000-000000000000", "chat", "turns"), false, "the second trip of the day is already noted");
    assert.equal(readActivity(ok, 100, { kind: "session-caps-failed" }).length, 0, "no failure line on the healthy path");
    assert.equal(sessionUsageToday(ok)[0].turns, 1, "the healthy turn record landed");
  } finally { rmSync(ok, { recursive: true, force: true }); }
});

test("accounting failure summaries collapse and cap the verbatim reason", () => {
  const usage = usageFailureSummary("mock", "EISDIR: illegal operation\n  on a directory");
  assert.ok(!usage.includes("\n"), "the reason is one line");
  const caps = sessionCapsFailureSummary("turn record", "abcd1234-0000-4000-8000-000000000000", "x".repeat(500));
  assert.ok(caps.length <= 200, "the summary is capped at 200");
});

test("accounting failure kinds classify to their own defect classes and rank", () => {
  const line = (kind: string) => ({ at: "2026-11-13T17:00:00.000Z", actor: "sam", kind, summary: "boom" });
  assert.deepEqual(classifyDefect(line("usage-failed")), { key: "usage-failed", label: "usage accounting failures" });
  assert.deepEqual(classifyDefect(line("session-caps-failed")), { key: "session-caps-failed", label: "session-cap ledger failures" });
  const root = scratch();
  try {
    recordActivity(root, "dip", "usage-failed", "Usage record failed for model MiniMax-M2.5: EISDIR");
    recordActivity(root, "sam", "session-caps-failed", "Session caps turn record failed for chat abcd1234: EISDIR");
    const ranked = rankDefects(root);
    assert.equal(ranked.find(r => r.key === "usage-failed")?.count, 1);
    assert.equal(ranked.find(r => r.key === "session-caps-failed")?.count, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
