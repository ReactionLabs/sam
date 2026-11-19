import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseStackWatchSummary, stackWatchLedgerSummary, stackWatchScorecardText } from "./stack-watch.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The stack-watch daily-measurement wiring (2026-11-19, the
// measured-proof series): the deterministic watch's one ledger
// class - "stack-watch" for every report - was never folded,
// so how many watches had run, how many found the stack frozen
// versus moving, and whether the entered count was ever
// knowable exactly was invisible in aggregate. The verdict is
// attention when any parsed watch found the stack frozen or
// any line is unparseable, else clear. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it is
// ONE line carrying counts only: no stamp, no actor, no
// connector name, no newest value, and no verbatim summary.
// The scorecard path is a pure read - it creates nothing,
// spends no model call, and reads no connector; every state
// here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer, never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-stack-watch-scorecard-"));
}

test("stack scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = stackWatchScorecardText(dir);
    assert.equal(text, "Stack watches: clear, 0 watches, frozen (yes 0, no 0), entered (floor 0, exact 0), 0 distinct newest, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = stackWatchScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held stack scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stack scorecard: frozen and moving watches fold to counts and no newest value surfaces", () => {
  const dir = scratch();
  try {
    const clean = stackWatchScorecardText(dir);
    recordActivity(dir, "sam", "stack-watch", stackWatchLedgerSummary(282966, "2026-11-04T22:45:59.894Z", { count: 100, exact: false }, true));
    recordActivity(dir, "sam", "stack-watch", stackWatchLedgerSummary(282966, "2026-11-04T22:45:59.894Z", { count: 100, exact: false }, true));
    recordActivity(dir, "sam", "stack-watch", stackWatchLedgerSummary(283093, "2026-11-14T13:12:21Z", { count: 100, exact: false }, false));
    recordActivity(dir, "sam", "stack-watch", stackWatchLedgerSummary(298548, "2026-11-19T17:05:16Z", { count: 37, exact: true }, false));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = stackWatchScorecardText(dir);
    assert.equal(text, "Stack watches: attention, 4 watches, frozen (yes 2, no 2), entered (floor 3, exact 1), 3 distinct newest, 4 total");
    assert.equal(text.includes("2026-11-04"), false, "no newest value surfaces");
    assert.equal(text.includes("282,966"), false, "no verbatim summary surfaces");
    assert.notEqual(text, clean, "the first watch changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stack scorecard: watches that all find the stack moving read clear", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "stack-watch", stackWatchLedgerSummary(283093, "2026-11-14T13:12:21Z", { count: 100, exact: false }, false));
    recordActivity(dir, "sam", "stack-watch", stackWatchLedgerSummary(283100, "2026-11-14T13:42:21Z", { count: 12, exact: true }, false));
    assert.equal(stackWatchScorecardText(dir), "Stack watches: clear, 2 watches, frozen (yes 0, no 2), entered (floor 1, exact 1), 2 distinct newest, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stack scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "stack-watch", stackWatchLedgerSummary(283093, "2026-11-14T13:12:21Z", { count: 100, exact: false }, false));
    recordActivity(dir, "sam", "stack-watch", "Some wholly novel stack shape mentioning sekrit content");
    const text = stackWatchScorecardText(dir);
    assert.equal(text, "Stack watches: attention, 1 watches, frozen (yes 0, no 1), entered (floor 1, exact 0), 1 distinct newest, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel stack"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stack parse: the seam's own writer lines parse, the live shapes parse, and only the fixed shapes parse", () => {
  assert.equal(
    stackWatchLedgerSummary(282966, "2026-11-04T22:45:59.894Z", { count: 100, exact: false }, true),
    "Stack watch (deterministic): candidates 282,966, newest 2026-11-04T22:45:59Z, entered 100+ (page cap), frozen yes",
    "the writer is byte-identical to the shape the report seam has always ledgered (second precision, the P3 lesson)",
  );
  assert.equal(
    stackWatchLedgerSummary(298548, "2026-11-19T17:05:16.123Z", { count: 37, exact: true }, false),
    "Stack watch (deterministic): candidates 298,548, newest 2026-11-19T17:05:16Z, entered 37, frozen no",
  );
  assert.deepEqual(
    parseStackWatchSummary("Stack watch (deterministic): candidates 282,966, newest 2026-11-04T22:45:59Z, entered 100+ (page cap), frozen yes"),
    { candidates: 282966, newest: "2026-11-04T22:45:59Z", entered: 100, enteredFloor: true, frozen: true },
    "the live frozen-era shape parses",
  );
  assert.deepEqual(
    parseStackWatchSummary("Stack watch (deterministic): candidates 283,093, newest 2026-11-14T13:12:21Z, entered 100+ (page cap), frozen no"),
    { candidates: 283093, newest: "2026-11-14T13:12:21Z", entered: 100, enteredFloor: true, frozen: false },
    "the live moving shape parses",
  );
  assert.equal(parseStackWatchSummary("Stack watch (deterministic): candidates many, newest soon, entered some, frozen maybe"), null);
  assert.equal(parseStackWatchSummary("Stack watch: candidates 1"), null);
  assert.equal(parseStackWatchSummary(""), null);
});

test("stack scorecard: the script allowlist carries the trend job riding the CLI subcommand", () => {
  assert.ok(scriptCommandNames().includes("sam-stack-watch-trend"), "the trend joins the Phase C allowlist");
  assert.ok(scriptCommandNames().includes("sam-stack-watch"), "the report job keeps its own name");
  const argv = scriptArgv("/tmp/root", "sam-stack-watch-trend");
  assert.ok(argv.join(" ").includes("observe stack-scorecard"), "the trend rides the observe stack-scorecard subcommand");
});
