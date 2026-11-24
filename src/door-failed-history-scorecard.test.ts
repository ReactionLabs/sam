import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doorFailedHistoryScorecardText, doorFailureSummary, parseDoorFailedSummary } from "./mini-door.js";
import { recordActivity } from "./activity.js";
import { chatQueueFailureSummary } from "./chat-queue-failure.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The door failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the mini-door
// store's touches ledger every failure as a door-failed
// line through the ONE writer (doorFailureSummary, fixed
// shape "Door <phase> failed: <reason>", capped 200;
// phases read / resolve, ridden by recordDoorFailure from
// the load seam, actor sam) - and while self-work labels
// single lines and the door history scorecard folds the
// guard's blocked / lockout kinds, no surface folds this
// kind, so which phase of the store every web door rides
// failed was invisible in aggregate. Every failure line is
// by construction a store touch that did not complete, so
// the verdict is attention when any failure was ever
// recorded or any line is unparseable, else clear. The
// scorecard text is a script job's stdout and is P3-diffed
// on its facts, so it is ONE line carrying counts only: no
// stamp, no reason, and no verbatim summary - the summaries
// carry reasons, and the fold consumes and never prints
// them, and no door record (a door key is a P10 bearer
// credential) ever surfaces. The scorecard path is a pure
// read - it creates nothing, updates nothing, and reads no
// door record; every state here is built through the
// ledger's own public door (recordActivity) with the seam's
// own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-door-failed-history-"));
}

const BARE = "Door failed history: clear, 0 failed, 0 read, 0 resolve, 0 total";

test("door failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = doorFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = doorFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held door scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("door failed history scorecard: the writer's failures fold to counts with the phase split, and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = doorFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "door-failed", doorFailureSummary("read", "unable to open sekrit database"));
    recordActivity(dir, "sam", "door-failed", doorFailureSummary("resolve", "disk full"));
    recordActivity(dir, "sam", "door-failed", doorFailureSummary("resolve", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = doorFailedHistoryScorecardText(dir);
    assert.equal(text, "Door failed history: attention, 3 failed, 1 read, 2 resolve, 3 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EPERM"), false, "no reason head surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("door failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = doorFailureSummary("resolve", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseDoorFailedSummary(capped), { phase: "resolve" });
    recordActivity(dir, "sam", "door-failed", capped);
    recordActivity(dir, "sam", "door-failed", doorFailureSummary("read", "boom"));
    const text = doorFailedHistoryScorecardText(dir);
    assert.equal(text, "Door failed history: attention, 2 failed, 1 read, 1 resolve, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("door failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and an unknown-phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "door-failed", doorFailureSummary("read", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "door-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "door-failed", chatQueueFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "door-failed", "Door read failed:   ");
    recordActivity(dir, "sam", "door-failed", "Door write failed: boom");
    const text = doorFailedHistoryScorecardText(dir);
    assert.equal(text, "Door failed history: attention, 1 failed, 1 read, 0 resolve, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("door failed history parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(doorFailureSummary("read", "database is locked"), "Door read failed: database is locked");
  assert.equal(doorFailureSummary("resolve", "disk gone"), "Door resolve failed: disk gone");
  assert.deepEqual(parseDoorFailedSummary(doorFailureSummary("read", "boom")), { phase: "read" });
  assert.deepEqual(parseDoorFailedSummary(doorFailureSummary("resolve", "boom")), { phase: "resolve" });
  assert.equal(parseDoorFailedSummary(""), null);
  assert.equal(parseDoorFailedSummary("Door read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseDoorFailedSummary("Door read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseDoorFailedSummary("Door write failed: boom"), null, "a phase the store never writes does not parse");
  assert.equal(parseDoorFailedSummary(chatQueueFailureSummary("read", "boom")), null, "a chat-queue-failed line never parses as a door-failed line");
  assert.deepEqual(parseDoorFailedSummary("Door resolve failed: boom: with colon"), { phase: "resolve" }, "a reason carrying a colon still parses from the fixed head");
});

test("door failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-door-failed-history"), "sam-door-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-door-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "door-failed-history"], "the argv rides observe door-failed-history");
});
