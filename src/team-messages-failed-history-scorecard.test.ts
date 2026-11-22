import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseTeamMessagesFailedSummary, teamMessagesFailedHistoryScorecardText, teamMessagesFailureSummary } from "./team-runtime.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The team messages failed history daily-measurement wiring
// (2026-11-21, the measured-proof series): every failed touch
// of the standing team's message ledger ledgers one
// "team-messages-failed" line through the ONE existing writer
// teamMessagesFailureSummary - an append shape naming the
// message kind and its from -> to label, and a read shape
// naming the ledger - but the shape was never folded, so how
// often the team's own record of its work failed to land or
// to read back was invisible in aggregate; the message ledger
// is append-only, so a failed append leaves no other surface,
// and a failed read rethrows. A recorded failure is itself
// the signal, so the verdict is attention when any failure
// was ever recorded or any line is unparseable, else clear.
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no actor, no label, no member name, no
// message text, no reason, and no verbatim summary. The
// scorecard path is a pure read - it creates nothing, appends
// and reads no team message, and opens no store; every state
// here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer, never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-team-messages-failed-history-"));
}

const BARE = "Team messages failed history: clear, 0 append, 0 read, 0 distinct labels, 0 total";

test("team messages failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = teamMessagesFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = teamMessagesFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held team messages failed scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("team messages failed history scorecard: recorded failures fold to counts with distinct labels as a number only", () => {
  const dir = scratch();
  try {
    const clean = teamMessagesFailedHistoryScorecardText(dir);
    recordActivity(dir, "sekritactor", "team-messages-failed", teamMessagesFailureSummary("append", "work ada -> cy", "EISDIR: sekrit reason"));
    recordActivity(dir, "sekritactor", "team-messages-failed", teamMessagesFailureSummary("append", "assignment sam -> ada", "EISDIR: sekrit reason"));
    recordActivity(dir, "sekritactor", "team-messages-failed", teamMessagesFailureSummary("append", "work ada -> cy", "EISDIR: sekrit reason"));
    recordActivity(dir, "sekritactor", "team-messages-failed", teamMessagesFailureSummary("read", "ledger", "EISDIR: sekrit reason"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = teamMessagesFailedHistoryScorecardText(dir);
    assert.equal(text, "Team messages failed history: attention, 3 append, 1 read, 3 distinct labels, 4 total");
    assert.equal(text.includes("sekrit"), false, "no actor or reason surfaces");
    assert.equal(text.includes("ada"), false, "no member name surfaces");
    assert.equal(text.includes("EISDIR"), false, "no reason surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("team messages failed history scorecard: an unmatched shape is attention, counts toward the total and the unparseable count, and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sekritactor", "team-messages-failed", teamMessagesFailureSummary("append", "work ada -> cy", "EISDIR: illegal operation on a directory"));
    recordActivity(dir, "sekritactor", "team-messages-failed", "Team messages quietly failed for sekrit reasons");
    const text = teamMessagesFailedHistoryScorecardText(dir);
    assert.equal(text, "Team messages failed history: attention, 1 append, 0 read, 1 distinct labels, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("team messages failed parsers: the writer is byte-identical to the ledgered shapes and parses, and only the fixed shapes parse", () => {
  assert.equal(teamMessagesFailureSummary("append", "work ada -> cy", "EISDIR: illegal operation on a directory"), "Team messages append failed for work ada -> cy: EISDIR: illegal operation on a directory");
  assert.deepEqual(parseTeamMessagesFailedSummary(teamMessagesFailureSummary("append", "work ada -> cy", "EISDIR: illegal operation on a directory")), { phase: "append", label: "work ada -> cy", kind: "work", from: "ada", to: "cy" });
  assert.equal(teamMessagesFailureSummary("read", "ledger", ""), "Team messages read failed for ledger: unknown error");
  assert.deepEqual(parseTeamMessagesFailedSummary(teamMessagesFailureSummary("read", "ledger", "EISDIR: illegal operation on a directory")), { phase: "read", label: "ledger", kind: null, from: null, to: null });
  assert.equal(parseTeamMessagesFailedSummary(""), null);
  assert.equal(parseTeamMessagesFailedSummary("Team messages delete failed for ledger: boom"), null, "an unknown phase does not parse");
  assert.equal(parseTeamMessagesFailedSummary("Team messages append failed for chat ada -> cy: boom"), null, "an unknown message kind does not parse");
  assert.equal(parseTeamMessagesFailedSummary("Team messages append failed for work Ada -> cy: boom"), null, "an uppercase member name does not parse");
  assert.equal(parseTeamMessagesFailedSummary("Team messages read failed for work ada -> cy: boom"), null, "a read line with an append label does not parse");
  assert.equal(parseTeamMessagesFailedSummary("Team messages append failed for ledger: boom"), null, "an append line with the read label does not parse");
  assert.equal(parseTeamMessagesFailedSummary("Team messages append failed for work ada -> cy:"), null, "a line with no reason does not parse");
});

test("team messages failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-team-messages-failed-history"), "sam-team-messages-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-team-messages-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["team", "messages-failed-history"], "the argv rides team messages-failed-history");
});
