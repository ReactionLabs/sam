import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodeWriteFailedSummary, codeWriteFailedHistoryScorecardText, codeWriteFailureSummary } from "./code.js";
import { recordActivity } from "./activity.js";
import { draftFailureSummary } from "./drafts.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The code write failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the writes
// ledger's touches ledger every failure as a code-write-failed
// line through the ONE writer codeWriteFailureSummary (fixed
// shape: "Code write <phase> failed for <event>: <reason>",
// phases read / append; the read event is the fixed label
// "ledger", the append event is the write label "write <path>
// (<created|edited>, +<n>/-<m> lines)") ridden by
// recordCodeWriteFailure from the append (which never eats a
// landed write) and the read (which fails closed) - but the
// class was never folded, so how often the writes ledger
// itself died (writes landing unrecorded, counts and close
// summaries throwing on a dead read) was invisible in
// aggregate. Every failure line is by construction a writes
// touch that did not complete its ledgering, so the verdict
// is attention when any failure was ever recorded or any line
// is unparseable, else clear. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no path, no event
// label, and no verbatim reason - the summaries carry paths
// and reasons, and the fold consumes and never prints them,
// and no file content ever surfaces (none enters the writer's
// line either). The scorecard path is a pure read - it
// creates nothing, sends nothing, and writes nothing; every
// state here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer, never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-code-write-failed-history-"));
}

const BARE = "Code write failed history: clear, 0 failed, 0 read, 0 append, 0 distinct events, 0 total";

test("code write failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = codeWriteFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = codeWriteFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held code write scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("code write failed history scorecard: the writer's failures fold to counts with distinct events as a number only, and no path or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = codeWriteFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "code-write-failed", codeWriteFailureSummary("read", "ledger", "EISDIR: illegal operation sekrit"));
    recordActivity(dir, "sam", "code-write-failed", codeWriteFailureSummary("read", "ledger", "disk full"));
    recordActivity(dir, "sam", "code-write-failed", codeWriteFailureSummary("append", "write a.txt (created, +1/-0 lines)", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "code-write-failed", codeWriteFailureSummary("append", "write b.txt (edited, +2/-1 lines)", "EACCES: permission denied"));
    recordActivity(dir, "sam", "code-write-failed", codeWriteFailureSummary("append", "write a.txt (created, +1/-0 lines)", "ENOSPC: no space left"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = codeWriteFailedHistoryScorecardText(dir);
    assert.equal(text, "Code write failed history: attention, 5 failed, 2 read, 3 append, 3 distinct events, 5 total");
    assert.equal(text.includes("a.txt"), false, "no path surfaces");
    assert.equal(text.includes("b.txt"), false, "no path surfaces");
    assert.equal(text.includes("ledger"), false, "no event label surfaces");
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

test("code write failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = codeWriteFailureSummary("append", "write a.txt (created, +1/-0 lines)", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseCodeWriteFailedSummary(capped), { phase: "append", event: "write a.txt (created, +1/-0 lines)" });
    recordActivity(dir, "sam", "code-write-failed", capped);
    const text = codeWriteFailedHistoryScorecardText(dir);
    assert.equal(text, "Code write failed history: attention, 1 failed, 0 read, 1 append, 1 distinct events, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("code write failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, a wrong-event shape, and an unknown-phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "code-write-failed", codeWriteFailureSummary("read", "ledger", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "code-write-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "code-write-failed", draftFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "code-write-failed", "Code write read failed for ledger:   ");
    recordActivity(dir, "sam", "code-write-failed", "Code write read failed for other: boom");
    recordActivity(dir, "sam", "code-write-failed", "Code write append failed for ledger: boom");
    recordActivity(dir, "sam", "code-write-failed", "Code write delete failed for ledger: boom");
    const text = codeWriteFailedHistoryScorecardText(dir);
    assert.equal(text, "Code write failed history: attention, 1 failed, 1 read, 0 append, 1 distinct events, 7 total, 6 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("code write failed parse: the writer is byte-identical to the ledgered shapes and parses, and only the fixed shapes parse", () => {
  assert.equal(codeWriteFailureSummary("read", "ledger", "database is locked"), "Code write read failed for ledger: database is locked");
  assert.equal(codeWriteFailureSummary("append", "write a.txt (created, +1/-0 lines)", "database is locked"), "Code write append failed for write a.txt (created, +1/-0 lines): database is locked");
  assert.deepEqual(parseCodeWriteFailedSummary(codeWriteFailureSummary("read", "ledger", "boom")), { phase: "read", event: "ledger" });
  assert.deepEqual(parseCodeWriteFailedSummary(codeWriteFailureSummary("append", "write a.txt (edited, +3/-2 lines)", "boom")), { phase: "append", event: "write a.txt (edited, +3/-2 lines)" });
  assert.equal(parseCodeWriteFailedSummary(""), null);
  assert.equal(parseCodeWriteFailedSummary("Code write read failed for ledger:"), null, "a line with no reason does not parse");
  assert.equal(parseCodeWriteFailedSummary("Code write read failed for ledger: "), null, "a line with a blank reason does not parse");
  assert.equal(parseCodeWriteFailedSummary("Code write read failed for other: boom"), null, "a read event the writer never writes does not parse");
  assert.equal(parseCodeWriteFailedSummary("Code write append failed for ledger: boom"), null, "an append event that is not a write label does not parse");
  assert.equal(parseCodeWriteFailedSummary("Code write append failed for write a.txt (created, +1/-0 lines)"), null, "an append line with no reason does not parse");
  assert.equal(parseCodeWriteFailedSummary("Code write delete failed for ledger: boom"), null, "a phase the door never writes does not parse");
  assert.equal(parseCodeWriteFailedSummary(draftFailureSummary("read", "boom")), null, "a draft-failed line never parses as a code-write-failed line");
  assert.deepEqual(parseCodeWriteFailedSummary("Code write read failed for ledger: boom: with colon"), { phase: "read", event: "ledger" }, "a reason carrying a colon still parses from the fixed head");
});

test("code write failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-code-write-failed-history"), "sam-code-write-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-code-write-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["code", "failed-history"], "the argv rides code failed-history");
});
