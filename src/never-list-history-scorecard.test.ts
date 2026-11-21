import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { neverListBlockedLedgerSummary, neverListHistoryScorecardText, neverListRefusedLedgerSummary, parseNeverListSummary } from "./actions.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The never-list history daily-measurement wiring
// (2026-11-21, the measured-proof series): every hardline
// never-list hit ledgers exactly one never-list line - a
// proposal-time refusal (the proposal is never stored, so
// the line is the only record the refusal ever happened) or
// a decision-time block (which lands on its record as an
// ordinary failure, indistinguishable in the gate folds) -
// but the class was never folded, so how many hardline
// payloads were ever refused or blocked, and which of the
// five hardline classes they hit, was invisible. A recorded
// hit is itself the signal, so the verdict is attention
// when any hit was ever recorded or any line is
// unparseable, else clear (the delivery-failure precedent).
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no actor, no proposal id, no title - the
// title is the proposer's own words and never surfaces. The
// scorecard path is a pure read - it creates nothing and
// proposes, decides, and executes nothing; every state here
// is built through the ledger's own public door
// (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-never-list-history-"));
}

const BARE = "Never-list history: clear, 0 refused, 0 blocked, hits none, kinds none, 0 total";
const UUID = "1d255a8d-6d00-47c6-b00e-5f2e089ab0d6";

test("never-list history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = neverListHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = neverListHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held never-list scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("never-list history scorecard: recorded hits fold to counts with hits in the fixed vocabulary order and kinds in the fixed enum order", () => {
  const dir = scratch();
  try {
    const clean = neverListHistoryScorecardText(dir);
    recordActivity(dir, "sam", "never-list", neverListRefusedLedgerSummary("note", "mkfs", "sekrit title one"));
    recordActivity(dir, "trading", "never-list", neverListRefusedLedgerSummary("law", "rm-rf-root", "sekrit title two"));
    recordActivity(dir, "owner", "never-list", neverListBlockedLedgerSummary("note", UUID, "mkfs", "sekrit title three"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = neverListHistoryScorecardText(dir);
    assert.equal(text, "Never-list history: attention, 2 refused, 1 blocked, hits rm-rf-root 1 / mkfs 2, kinds note 2 / law 1, 3 total");
    assert.equal(text.includes("sekrit"), false, "no title surfaces");
    assert.equal(text.includes("1d255a8d"), false, "no proposal id surfaces");
    assert.equal(text.includes("trading"), false, "no actor surfaces");
    assert.notEqual(text, clean, "the first recorded hit changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("never-list history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "never-list", neverListRefusedLedgerSummary("note", "mkfs", "a real refusal"));
    recordActivity(dir, "sam", "never-list", "Refused a note proposal (made-up-hit): sekrit text");
    recordActivity(dir, "sam", "never-list", "Some other shape entirely sekrit");
    const text = neverListHistoryScorecardText(dir);
    assert.equal(text, "Never-list history: attention, 1 refused, 0 blocked, hits mkfs 1, kinds note 1, 3 total, 2 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("made-up-hit"), false, "no drifted hit id surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("never-list parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(neverListRefusedLedgerSummary("note", "rm-rf-root", "Wipe it"), "Refused a note proposal (rm-rf-root): Wipe it");
  assert.equal(neverListBlockedLedgerSummary("law", UUID, "fork-bomb", "Loop it"), "Blocked execution of law " + UUID + " (fork-bomb): Loop it");
  assert.equal(neverListRefusedLedgerSummary("note", "mkfs", "x".repeat(200)), "Refused a note proposal (mkfs): " + "x".repeat(120), "the title slice is 120 chars");
  assert.deepEqual(parseNeverListSummary(neverListRefusedLedgerSummary("skill-author", "pipe-to-root-shell", "Pipe it")), { stage: "refused", kind: "skill-author", hit: "pipe-to-root-shell" });
  assert.deepEqual(parseNeverListSummary(neverListBlockedLedgerSummary("heartbeat", UUID, "dd-to-device", "Write it")), { stage: "blocked", kind: "heartbeat", hit: "dd-to-device" });
  assert.deepEqual(parseNeverListSummary(neverListRefusedLedgerSummary("bogus-kind", "mkfs", "Format it")), { stage: "refused", kind: "other", hit: "mkfs" }, "an unknown kind folds to other");
  assert.equal(parseNeverListSummary(""), null);
  assert.equal(parseNeverListSummary("Refused a note proposal (mkfs):"), null, "a line missing the separator space and title does not parse");
  assert.equal(parseNeverListSummary("Refused a note proposal (unknown-hit): some title"), null, "a hit id outside the five-class vocabulary does not parse");
  assert.equal(parseNeverListSummary("Blocked execution of law (mkfs): some title"), null, "a blocked line missing its proposal id does not parse");
});

test("never-list history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-never-list-history"), "sam-never-list-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-never-list-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["actions", "never-history"], "the argv rides actions never-history");
});
