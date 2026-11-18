import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseTripwireSummary, researchLedgerSummary, spelunkLedgerSummary, tripwireScorecardText } from "./loop-guards.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The turn-economy tripwire daily-measurement wiring
// (2026-11-18, the measured-proof series): the turn-economy
// guard ledgers one line per tripped turn per wire
// (spelunk-tripwire / research-tripwire) when a live chat
// turn escalates into code digging or research instead of
// answering, but no daily surface ever counted the trips, so
// a model that kept escalating ordinary questions was
// invisible in aggregate. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it carries
// counts only: no stamp, no actor, no verbatim summary - the
// tripped turns, counts per fixed wire, and the summed calls
// at trip, and an unmatched shape counts as a trip under
// other with no calls, never printed. The scorecard path is
// a pure read - it creates nothing, spends no model call,
// and retries nothing; every state here is built through
// the ledger's own public door (recordActivity) with the
// guard's own summary writers (spelunkLedgerSummary /
// researchLedgerSummary), never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-tripwire-scorecard-"));
}

test("tripwire scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = tripwireScorecardText(dir);
    assert.match(text, /^Tripwires: clear$/m);
    assert.match(text, /^Tripped turns: 0$/m);
    assert.match(text, /^By wire: none$/m);
    assert.match(text, /^Calls at trip: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = tripwireScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held tripwire scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tripwire scorecard: trips flip the verdict, count per wire, sum calls at trip, and leak no content", () => {
  const dir = scratch();
  try {
    const clean = tripwireScorecardText(dir);
    recordActivity(dir, "sam", "spelunk-tripwire", spelunkLedgerSummary());
    recordActivity(dir, "dip", "spelunk-tripwire", spelunkLedgerSummary());
    recordActivity(dir, "sam", "research-tripwire", researchLedgerSummary());
    recordActivity(dir, "sam", "spelunk-tripwire", "Some wholly novel tripwire shape mentioning sekrit-digging");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = tripwireScorecardText(dir);
    assert.match(text, /^Tripwires: attention$/m);
    assert.match(text, /^Tripped turns: 4$/m);
    assert.match(text, /^By wire: spelunk 2, research 1, other 1$/m);
    assert.match(text, /^Calls at trip: 20$/m);
    assert.equal(text.includes("sekrit"), false, "no digging content surfaces");
    assert.equal(text.includes("novel tripwire"), false, "an unmatched summary is never printed");
    assert.notEqual(text, clean, "the first trip changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tripwire parse: the guard's own lines parse, and only the fixed shapes parse", () => {
  assert.deepEqual(parseTripwireSummary(spelunkLedgerSummary()), { wire: "spelunk", calls: 6 });
  assert.deepEqual(parseTripwireSummary(researchLedgerSummary()), { wire: "research", calls: 8 });
  assert.equal(parseTripwireSummary(""), null);
  assert.equal(parseTripwireSummary("Some wholly novel tripwire shape"), null);
  assert.equal(parseTripwireSummary("Code digging cut in a chat turn after some code lookups"), null);
});

test("tripwire scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-tripwires"), "sam-tripwires is allowlisted");
  const argv = scriptArgv("/some/root", "sam-tripwires");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "tripwire-scorecard"], "the argv rides observe tripwire-scorecard");
});
