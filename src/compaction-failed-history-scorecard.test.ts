import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactionFailedHistoryScorecardText, compactionFailureSummary, parseCompactionFailedSummary } from "./compaction.js";
import { recordActivity } from "./activity.js";
import { contactFailureSummary } from "./contacts.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The compaction failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the fold's three
// durable steps ledger every failure as a compaction-failed
// line through the ONE writer (compactionFailureSummary, fixed
// shape "Compaction <phase> failed for chat <8-char prefix>:
// <reason>", capped 200; phases read / flush / save, ridden by
// recordCompactionFailure from the fold seams) - and while
// self-work labels single lines and the success side carries
// its own fold, no surface folds this kind, so which step of a
// wedged fold failed (a flush failure means the chat never
// compacts at all) was invisible in aggregate. Every failure
// line is by construction a fold step that did not complete,
// so the verdict is attention when any failure was ever
// recorded or any line is unparseable, else clear. The
// scorecard text is a script job's stdout and is P3-diffed on
// its facts, so it is ONE line carrying counts only: no stamp,
// no reason, no chat id, and no verbatim summary - the
// summaries carry reasons and chat prefixes, and the fold
// consumes and never prints them (distinct chats surface as a
// number only), and no message content or digest text ever
// surfaces. The scorecard path is a pure read - it creates
// nothing, updates nothing, and folds nothing; every state
// here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer, never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-compaction-failed-history-"));
}

const BARE = "Compaction failed history: clear, 0 failed, 0 read, 0 flush, 0 save, 0 distinct chats, 0 total";

test("compaction failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = compactionFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = compactionFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held compaction scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compaction failed history scorecard: the writer's failures fold to counts with the phase split and the distinct-chat count, and no reason or chat id surfaces", () => {
  const dir = scratch();
  try {
    const clean = compactionFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "compaction-failed", compactionFailureSummary("abcdef123456", "flush", "unable to open sekrit store"));
    recordActivity(dir, "sam", "compaction-failed", compactionFailureSummary("abcdef123456", "flush", "disk full"));
    recordActivity(dir, "sam", "compaction-failed", compactionFailureSummary("99887766aabb", "save", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "compaction-failed", compactionFailureSummary("99887766aabb", "read", "boom"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = compactionFailedHistoryScorecardText(dir);
    assert.equal(text, "Compaction failed history: attention, 4 failed, 1 read, 2 flush, 1 save, 2 distinct chats, 4 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EPERM"), false, "no reason head surfaces");
    assert.equal(text.includes("abcdef12"), false, "no chat prefix surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compaction failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = compactionFailureSummary("abcdef123456", "save", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseCompactionFailedSummary(capped), { phase: "save", chat: "abcdef12" });
    recordActivity(dir, "sam", "compaction-failed", capped);
    recordActivity(dir, "sam", "compaction-failed", compactionFailureSummary("abcdef123456", "read", "boom"));
    const text = compactionFailedHistoryScorecardText(dir);
    assert.equal(text, "Compaction failed history: attention, 2 failed, 1 read, 0 flush, 1 save, 1 distinct chats, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compaction failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, an unknown-phase shape, and an over-long chat segment count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "compaction-failed", compactionFailureSummary("abcdef123456", "read", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "compaction-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "compaction-failed", contactFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "compaction-failed", "Compaction read failed for chat abcdef12:   ");
    recordActivity(dir, "sam", "compaction-failed", "Compaction delete failed for chat abcdef12: boom");
    recordActivity(dir, "sam", "compaction-failed", "Compaction read failed for chat abcdef123: boom");
    const text = compactionFailedHistoryScorecardText(dir);
    assert.equal(text, "Compaction failed history: attention, 1 failed, 1 read, 0 flush, 0 save, 1 distinct chats, 6 total, 5 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compaction failed history parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(compactionFailureSummary("abcdef123456", "read", "database is locked"), "Compaction read failed for chat abcdef12: database is locked");
  assert.equal(compactionFailureSummary("99887766aabb", "flush", "disk gone"), "Compaction flush failed for chat 99887766: disk gone");
  assert.deepEqual(parseCompactionFailedSummary(compactionFailureSummary("abcdef123456", "read", "boom")), { phase: "read", chat: "abcdef12" });
  assert.deepEqual(parseCompactionFailedSummary(compactionFailureSummary("abcdef123456", "save", "boom")), { phase: "save", chat: "abcdef12" });
  assert.equal(parseCompactionFailedSummary(""), null);
  assert.equal(parseCompactionFailedSummary("Compaction read failed for chat abcdef12:"), null, "a line with no reason does not parse");
  assert.equal(parseCompactionFailedSummary("Compaction read failed for chat abcdef12: "), null, "a line with a blank reason does not parse");
  assert.equal(parseCompactionFailedSummary("Compaction delete failed for chat abcdef12: boom"), null, "a phase the fold never writes does not parse");
  assert.equal(parseCompactionFailedSummary("Compaction read failed for chat abcdef123: boom"), null, "a chat segment longer than the writer's 8-char slice never parses");
  assert.equal(parseCompactionFailedSummary(contactFailureSummary("read", "boom")), null, "a contact-failed line never parses as a compaction-failed line");
  assert.deepEqual(parseCompactionFailedSummary("Compaction flush failed for chat abcdef12: boom: with colon"), { phase: "flush", chat: "abcdef12" }, "a reason carrying a colon still parses from the fixed head");
});

test("compaction failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-compaction-failed-history"), "sam-compaction-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-compaction-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "compaction-failed-history"], "the argv rides observe compaction-failed-history");
});
