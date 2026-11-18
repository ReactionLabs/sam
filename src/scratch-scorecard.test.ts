import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseScratchRefusalSummary, scratchRefusalLedgerSummary, scratchScorecardText } from "./loop-guards.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The scratch-write refusal daily-measurement wiring
// (2026-11-18, the measured-proof series): the turn-economy
// guard refuses a chat turn's creation of a throwaway
// scratch script in the code root and ledgers one
// scratch-write-refused line per refusal, but no daily
// surface ever counted the refusals, so a model that kept
// inventing scratch scripts was invisible in aggregate.
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it carries counts only: no
// stamp, no actor, no path, no verbatim summary - the
// refused writes and counts per fixed extension bucket,
// and an unmatched shape counts as a refusal under other,
// never printed. The scorecard path is a pure read - it
// creates nothing, spends no model call, and retries
// nothing; every state here is built through the ledger's
// own public door (recordActivity) with the guard's own
// summary writer (scratchRefusalLedgerSummary), never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-scratch-scorecard-"));
}

test("scratch scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = scratchScorecardText(dir);
    assert.match(text, /^Scratch writes: clear$/m);
    assert.match(text, /^Refused writes: 0$/m);
    assert.match(text, /^By extension: none$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = scratchScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held scratch scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scratch scorecard: refusals flip the verdict, count per extension, and leak no path", () => {
  const dir = scratch();
  try {
    const clean = scratchScorecardText(dir);
    recordActivity(dir, "sam", "scratch-write-refused", scratchRefusalLedgerSummary("sam-grep-phrase.py"));
    recordActivity(dir, "dip", "scratch-write-refused", scratchRefusalLedgerSummary("tools/sam-find-orch.py"));
    recordActivity(dir, "sam", "scratch-write-refused", scratchRefusalLedgerSummary("probe-run.sh"));
    recordActivity(dir, "sam", "scratch-write-refused", "Some wholly novel refusal shape mentioning sekrit-scratch.py");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = scratchScorecardText(dir);
    assert.match(text, /^Scratch writes: attention$/m);
    assert.match(text, /^Refused writes: 4$/m);
    assert.match(text, /^By extension: py 2, sh 1, other 1$/m);
    assert.equal(text.includes("sekrit"), false, "no invented path surfaces");
    assert.equal(text.includes("sam-grep-phrase"), false, "a parsed path is never printed");
    assert.equal(text.includes("novel refusal"), false, "an unmatched summary is never printed");
    assert.notEqual(text, clean, "the first refusal changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scratch parse: the guard's own lines parse, and only the fixed shapes parse", () => {
  assert.deepEqual(parseScratchRefusalSummary(scratchRefusalLedgerSummary("sam-grep-phrase.py")), { extension: "py" });
  assert.deepEqual(parseScratchRefusalSummary(scratchRefusalLedgerSummary("deep/sam_x.mjs")), { extension: "mjs" });
  assert.deepEqual(parseScratchRefusalSummary(scratchRefusalLedgerSummary("sam-notes.txt")), { extension: "other" });
  assert.equal(parseScratchRefusalSummary(""), null);
  assert.equal(parseScratchRefusalSummary("Some wholly novel refusal shape"), null);
  assert.equal(parseScratchRefusalSummary("Refused a scratch script write in a chat turn: sam-x.py somewhere else"), null);
});

test("scratch scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-scratch-refusals"), "sam-scratch-refusals is allowlisted");
  const argv = scriptArgv("/some/root", "sam-scratch-refusals");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "scratch-scorecard"], "the argv rides observe scratch-scorecard");
});
