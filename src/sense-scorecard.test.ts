import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { SENSES_NOT_INSTALLED, parseSenseReadSummary, senseReadLedgerSummary, senseScorecardText } from "./senses.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The sense-read daily-measurement wiring (2026-11-19, the
// measured-proof series): the P2 senses' one ledger class -
// "sense-read" for every core mail or agenda read - was
// never folded, so how often SAM tried to see the owner's
// day, through which sense, and how those reads ended was
// invisible in aggregate. The verdict is attention when any
// parsed read is not ok or any line is unparseable, else
// clear: a sense read is attempted only when the owner or
// the brief asks, so every read that ends without the
// owner's day in hand is a day SAM could not see. The
// scorecard text is a script job's stdout and is P3-diffed
// on its facts, so it is ONE line carrying counts only: no
// stamp, no actor, and never a query, reader output, error
// text, or verbatim summary - a sense line never carries
// the query or content by the module's own rule, and the
// fold surfaces none of what it does carry. The scorecard
// path is a pure read - it creates nothing, spends no model
// call, and reads no sense; every state here is built
// through the ledger's own public door (recordActivity)
// with the seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-sense-scorecard-"));
}

test("sense scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = senseScorecardText(dir);
    assert.equal(text, "Sense reads: clear, 0 reads (mail 0, agenda 0), outcomes (ok 0, not installed 0, failed 0, timed out 0), 0 chars read, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = senseScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held sense scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sense scorecard: every outcome folds to counts and no error text or identifier surfaces", () => {
  const dir = scratch();
  try {
    const clean = senseScorecardText(dir);
    recordActivity(dir, "sam", "sense-read", senseReadLedgerSummary("mail", "reader not installed"));
    recordActivity(dir, "sam", "sense-read", senseReadLedgerSummary("mail", SENSES_NOT_INSTALLED.slice(0, 120)));
    recordActivity(dir, "sam", "sense-read", senseReadLedgerSummary("agenda", "reader not installed"));
    recordActivity(dir, "sam", "sense-read", senseReadLedgerSummary("mail", "ok (100 chars)"));
    recordActivity(dir, "sam", "sense-read", senseReadLedgerSummary("agenda", "ok (50 chars)"));
    recordActivity(dir, "sam", "sense-read", senseReadLedgerSummary("mail", "exit 2"));
    recordActivity(dir, "sam", "sense-read", senseReadLedgerSummary("agenda", "exit null (timed out)"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = senseScorecardText(dir);
    assert.equal(text, "Sense reads: attention, 7 reads (mail 4, agenda 3), outcomes (ok 2, not installed 3, failed 1, timed out 1), 150 chars read, 7 total");
    assert.equal(text.includes("gog"), false, "no reader error text surfaces");
    assert.equal(text.includes("SAM_GOG_BIN"), false, "no verbatim summary surfaces");
    assert.notEqual(text, clean, "the first sense read changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sense scorecard: reads that all land ok read clear", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "sense-read", senseReadLedgerSummary("mail", "ok (10 chars)"));
    recordActivity(dir, "sam", "sense-read", senseReadLedgerSummary("agenda", "ok (20 chars)"));
    assert.equal(senseScorecardText(dir), "Sense reads: clear, 2 reads (mail 1, agenda 1), outcomes (ok 2, not installed 0, failed 0, timed out 0), 30 chars read, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sense scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "sense-read", senseReadLedgerSummary("mail", "ok (10 chars)"));
    recordActivity(dir, "sam", "sense-read", "Some wholly novel sense shape mentioning sekrit content");
    const text = senseScorecardText(dir);
    assert.equal(text, "Sense reads: attention, 1 reads (mail 1, agenda 0), outcomes (ok 1, not installed 0, failed 0, timed out 0), 10 chars read, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel sense"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sense parse: the seam's own writer lines parse, the live shapes parse, and only the fixed shapes parse", () => {
  assert.equal(
    senseReadLedgerSummary("mail", "reader not installed"),
    "Sense mail read: reader not installed",
    "the writer is byte-identical to the shape the missing-reader branch has always ledgered",
  );
  assert.equal(
    senseReadLedgerSummary("agenda", "ok (4321 chars)"),
    "Sense agenda read: ok (4321 chars)",
    "the writer is byte-identical to the shape the result branch has always ledgered",
  );
  assert.deepEqual(parseSenseReadSummary("Sense mail read: reader not installed"), { sense: "mail", bucket: "not-installed", chars: 0 });
  assert.deepEqual(
    parseSenseReadSummary("Sense mail read: " + SENSES_NOT_INSTALLED.slice(0, 120)),
    { sense: "mail", bucket: "not-installed", chars: 0 },
    "the runner-vanished shape (the not-installed error's own opening slice) parses",
  );
  assert.deepEqual(
    parseSenseReadSummary("Sense agenda read: " + "The senses reader exited with code 1 - it may not be authorized yet (authorizing it with the owner's Google account is the operator's act). Its output is carried below.".slice(0, 120)),
    { sense: "agenda", bucket: "failed", chars: 0 },
    "the unauthorized shape (the exit error's own opening slice) parses on its fixed prefix",
  );
  assert.deepEqual(parseSenseReadSummary("Sense agenda read: The senses reader timed out after 30 seconds."), { sense: "agenda", bucket: "timed-out", chars: 0 });
  assert.deepEqual(parseSenseReadSummary("Sense mail read: ok (4321 chars)"), { sense: "mail", bucket: "ok", chars: 4321 });
  assert.deepEqual(parseSenseReadSummary("Sense mail read: exit 2"), { sense: "mail", bucket: "failed", chars: 0 });
  assert.deepEqual(parseSenseReadSummary("Sense agenda read: exit null (timed out)"), { sense: "agenda", bucket: "timed-out", chars: 0 });
  assert.equal(parseSenseReadSummary(""), null);
  assert.equal(parseSenseReadSummary("Sense mail read: "), null, "an empty tail does not parse");
  assert.equal(parseSenseReadSummary("Sense calendar read: ok (1 chars)"), null, "an unknown sense does not parse");
  assert.equal(parseSenseReadSummary("Some wholly novel sense shape"), null);
});

test("sense scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-senses"), "sam-senses is allowlisted");
  const argv = scriptArgv("/some/root", "sam-senses");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "sense-scorecard"], "the argv rides observe sense-scorecard");
});
