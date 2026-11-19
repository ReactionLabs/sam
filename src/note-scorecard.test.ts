import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { noteGatedLedgerSummary, notePatchGatedLedgerSummary, noteSavedLedgerSummary, noteScorecardText, parseNoteGatedSummary, parseNoteSavedSummary } from "./notes.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The note daily-measurement wiring (2026-11-19, the
// measured-proof series): the two-tier note system's two
// ledger classes - "note-saved" for a soft note that saved
// immediately and "note-gated" for every hard note or patch
// routed to the owner gate - were never folded, so how many
// notes SAM saved freely, how many it correctly gated, and
// why they gated (supersession vs identity vs law-like) was
// invisible in aggregate. The verdict is attention ONLY on
// an unparseable line, else clear: a saved soft note and a
// gated hard note are both the two-tier ruling working,
// never a defect. The scorecard text is a script job's
// stdout and is P3-diffed on its facts, so it is ONE line
// carrying counts only: no stamp, no actor, and never a
// record id, scope name, or note content - the distinct
// count rides each saved line's scope internally and
// surfaces as a number only. The scorecard path is a pure
// read - it creates nothing, spends no model call, and
// saves or gates nothing; every state here is built through
// the ledger's own public door (recordActivity) with the
// seams' own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-note-scorecard-"));
}

test("note scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = noteScorecardText(dir);
    assert.equal(text, "Notes: clear, 0 saved, 0 gated (hard 0, patch 0), gated reasons (supersession 0, identity 0, law 0, other 0), 0 distinct scopes, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = noteScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held note scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("note scorecard: both classes fold to counts, scopes collapse in the distinct count, and no identifier or content surfaces", () => {
  const dir = scratch();
  try {
    const clean = noteScorecardText(dir);
    recordActivity(dir, "sam", "note-saved", noteSavedLedgerSummary("0d1f4b80-24c9-47c7-ad04-1870ef8da302", "core", "A soft project fact about the Zorblax launch"));
    recordActivity(dir, "dip", "note-saved", noteSavedLedgerSummary("f244f4ec-cac4-4bd8-b436-7c8fa46b03dc", "core", "Another soft fact"));
    recordActivity(dir, "trading", "note-saved", noteSavedLedgerSummary("24bcb460-bfac-42e5-a232-80ea88bd242d", "profile:trading", "A scoped fact"));
    recordActivity(dir, "sam", "note-gated", notePatchGatedLedgerSummary("it patches (supersedes) record 24bcb460-bfac-42e5-a232-80ea88bd242d", "The old wording", "The new wording"));
    recordActivity(dir, "sam", "note-gated", noteGatedLedgerSummary("it says it replaces an existing record", "A replacement note"));
    recordActivity(dir, "sam", "note-gated", noteGatedLedgerSummary("it is phrased as a standing rule (always/never/must)", "A rule-shaped note"));
    recordActivity(dir, "sam", "note-gated", noteGatedLedgerSummary("it states how a person is addressed", "An addressing note"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = noteScorecardText(dir);
    assert.equal(text, "Notes: clear, 3 saved, 4 gated (hard 3, patch 1), gated reasons (supersession 2, identity 1, law 1, other 0), 2 distinct scopes, 7 total");
    assert.equal(text.includes("0d1f4b80"), false, "no record id surfaces");
    assert.equal(text.includes("Zorblax"), false, "no note content surfaces");
    assert.equal(text.includes("profile:trading"), false, "no scope name surfaces");
    assert.notEqual(text, clean, "the first note changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("note scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "note-saved", noteSavedLedgerSummary("0d1f4b80-24c9-47c7-ad04-1870ef8da302", "core", "A soft fact"));
    recordActivity(dir, "sam", "note-gated", "Some wholly novel note shape mentioning sekrit content");
    const text = noteScorecardText(dir);
    assert.equal(text, "Notes: attention, 1 saved, 0 gated (hard 0, patch 0), gated reasons (supersession 0, identity 0, law 0, other 0), 1 distinct scopes, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel note"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("note parse: the seams' own writer lines parse, the capped patch shape parses on its prefix, and only the fixed shapes parse", () => {
  assert.equal(
    noteSavedLedgerSummary("0d1f4b80-24c9-47c7-ad04-1870ef8da302", "core", "A soft fact"),
    "Saved note (0d1f4b80-24c9-47c7-ad04-1870ef8da302, core): A soft fact",
    "the writer is byte-identical to the shape saveNote has always ledgered",
  );
  assert.equal(
    noteGatedLedgerSummary("it says it replaces an existing record", "A replacement note"),
    "Hard note routed to owner approval (it says it replaces an existing record): A replacement note",
    "the writer is byte-identical to the shape the hard branch has always ledgered",
  );
  assert.equal(
    notePatchGatedLedgerSummary("it patches (supersedes) record 24bcb460-bfac-42e5-a232-80ea88bd242d", "The old wording", "The new wording"),
    "Note patch routed to owner approval (it patches (supersedes) record 24bcb460-bfac-42e5-a232-80ea88bd242d, was: The old wording): The new wording",
    "the writer is byte-identical to the shape patchNote has always ledgered",
  );
  assert.deepEqual(parseNoteSavedSummary(noteSavedLedgerSummary("0d1f4b80-24c9-47c7-ad04-1870ef8da302", "profile:trading", "A scoped fact")), { scope: "profile:trading" });
  assert.deepEqual(
    parseNoteSavedSummary("Saved note (f244f4ec-cac4-4bd8-b436-7c8fa46b03dc, core): A live-shaped saved line"),
    { scope: "core" },
    "a live-shaped line parses",
  );
  assert.deepEqual(
    parseNoteGatedSummary("Hard note routed to owner approval (it is phrased as a standing rule (always/never/must)): A live-shaped gated line"),
    { gatedKind: "hard", bucket: "law" },
    "a nested-paren reason parses to its bucket",
  );
  assert.deepEqual(
    parseNoteGatedSummary(notePatchGatedLedgerSummary("it patches (supersedes) record 24bcb460-bfac-42e5-a232-80ea88bd242d", "w".repeat(80), "c".repeat(120)).slice(0, 300)),
    { gatedKind: "patch", bucket: "supersession" },
    "the 300-char capped patch shape still parses on its fixed prefix",
  );
  assert.equal(parseNoteSavedSummary(""), null);
  assert.equal(parseNoteSavedSummary("Saved note (not-a-uuid, core): A fact"), null, "a malformed id does not parse");
  assert.equal(parseNoteGatedSummary("Hard note routed to owner approval (a reason)"), null, "a truncated line does not parse");
  assert.equal(parseNoteGatedSummary("Some wholly novel note shape"), null);
});

test("note scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-notes"), "sam-notes is allowlisted");
  const argv = scriptArgv("/some/root", "sam-notes");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "note-scorecard"], "the argv rides observe note-scorecard");
});
