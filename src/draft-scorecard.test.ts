import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  draftCreatedLedgerSummary,
  draftDiscardedLedgerSummary,
  draftScorecardText,
  parseDraftSummary,
} from "./drafts.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The draft daily-measurement wiring (2026-11-20, the
// measured-proof series): every draft SAM creates and every
// draft the owner discards has ledgered as a draft line
// since P12 landed - one line per act, in the fixed shapes
// the two seams write, carrying the channel, the recipient,
// and the subject on a created line and the discarded id's
// first 8 chars on a discard line - but the class was never
// folded, so how much drafting SAM does on the owner's
// behalf and how much of it is thrown away was invisible in
// aggregate (the drafts surfaces list the live store; none
// trends the ledger). Creating and discarding drafts is the
// normal owner workflow, so the verdict is attention only
// when a line is unparseable. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no
// recipient, no subject, no draft id - the summary carries
// the recipient and the subject, which the fold counts by
// channel and never prints. The scorecard path is a pure
// read - it creates nothing and drafts nothing; every state
// here is built through the ledger's own public door
// (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-draft-scorecard-"));
}

test("draft scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = draftScorecardText(dir);
    assert.equal(text, "Drafts: clear, 0 created, 0 discarded, channels none, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = draftScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held draft scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("draft scorecard: the class folds to counts by channel, and no recipient or subject surfaces", () => {
  const dir = scratch();
  try {
    const clean = draftScorecardText(dir);
    recordActivity(dir, "sam", "draft", draftCreatedLedgerSummary("text", "QA Probe", null));
    recordActivity(dir, "sam", "draft", draftCreatedLedgerSummary("email", "Person One", "A secret subject"));
    recordActivity(dir, "sam", "draft", draftCreatedLedgerSummary("email", "Person Two", null));
    recordActivity(dir, "owner", "draft", draftDiscardedLedgerSummary("1aa19b44-dead-beef-0000-000000000000"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = draftScorecardText(dir);
    assert.equal(text, "Drafts: clear, 3 created, 1 discarded, channels email 2 / text 1, 4 total");
    assert.equal(text.includes("QA Probe"), false, "no recipient surfaces");
    assert.equal(text.includes("Person One"), false, "no recipient surfaces");
    assert.equal(text.includes("secret subject"), false, "no subject surfaces");
    assert.equal(text.includes("1aa19b44"), false, "no draft id surfaces");
    assert.notEqual(text, clean, "the first recorded draft changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("draft scorecard: channels report in the fixed enum order, not ledger order", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "draft", draftCreatedLedgerSummary("other", "Someone", null));
    recordActivity(dir, "sam", "draft", draftCreatedLedgerSummary("message", "Someone", null));
    recordActivity(dir, "sam", "draft", draftCreatedLedgerSummary("email", "Someone", null));
    const text = draftScorecardText(dir);
    assert.equal(text, "Drafts: clear, 3 created, 0 discarded, channels email 1 / message 1 / other 1, 3 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("draft scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "draft", draftCreatedLedgerSummary("text", "QA Probe", null));
    recordActivity(dir, "sam", "draft", "Some wholly novel draft shape mentioning a recipient");
    const text = draftScorecardText(dir);
    assert.equal(text, "Drafts: attention, 1 created, 0 discarded, channels text 1, 2 total, 1 unparseable");
    assert.equal(text.includes("novel draft"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("recipient"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("draft parse: the seams' own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    draftCreatedLedgerSummary("text", "QA Probe", null),
    "Drafted text to QA Probe",
  );
  assert.equal(
    draftCreatedLedgerSummary("email", "Person One", "Hello there"),
    "Drafted email to Person One: Hello there",
  );
  assert.equal(
    draftDiscardedLedgerSummary("1aa19b44-dead-beef-0000-000000000000"),
    "Discarded draft 1aa19b44",
  );
  assert.deepEqual(parseDraftSummary(draftCreatedLedgerSummary("text", "QA Probe", null)), { action: "created", channel: "text" });
  assert.deepEqual(parseDraftSummary(draftCreatedLedgerSummary("letter", "Person One", "A subject")), { action: "created", channel: "letter" });
  assert.deepEqual(parseDraftSummary(draftDiscardedLedgerSummary("1aa19b44-dead-beef-0000-000000000000")), { action: "discarded" });
  assert.equal(parseDraftSummary(""), null);
  assert.equal(parseDraftSummary("Drafted text to "), null, "a created line with no recipient does not parse");
  assert.equal(parseDraftSummary("Drafted pigeon to QA Probe"), null, "an unknown channel does not parse");
  assert.equal(parseDraftSummary("Discarded draft 1aa19b44-extra"), null, "a discard line past 8 chars does not parse");
  assert.equal(parseDraftSummary("Discarded draft "), null, "a truncated discard line does not parse");
});

test("draft scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-drafts"), "sam-drafts is allowlisted");
  const argv = scriptArgv("/some/root", "sam-drafts");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["drafts", "scorecard"], "the argv rides drafts scorecard");
});
