import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parsePythonRunSummary, pythonRunLedgerSummary, pythonRunRefusedLedgerSummary, pythonRunScorecardText } from "./code.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The Python-run daily-measurement wiring (2026-11-18, the
// measured-proof series): every Python run ledgers one
// python-run line carrying the script's hash, its
// pass-through env names, its path, an optional sandbox
// name, and the outcome, but no daily surface ever counted
// the runs, so a runner that started failing was invisible
// in aggregate. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it carries counts only:
// no stamp, no actor, no hash, no path, no sandbox name, no
// pass-through name, no verbatim summary - the total runs,
// counts per fixed outcome bucket, and the sandbox,
// pass-through, and timed-out counts, and an unmatched
// shape counts as a run under other, never printed. The
// scorecard path is a pure read - it creates nothing,
// spends no model call, and runs nothing; every state here
// is built through the ledger's own public door
// (recordActivity) with the runner's own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-python-run-scorecard-"));
}

const HASH = "a".repeat(64);

test("python-run scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = pythonRunScorecardText(dir);
    assert.match(text, /^Python runs: clear$/m);
    assert.match(text, /^Runs: 0$/m);
    assert.match(text, /^By outcome: none$/m);
    assert.match(text, /^Sandbox runs: 0$/m);
    assert.match(text, /^Pass-through runs: 0$/m);
    assert.match(text, /^Timed-out runs: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = pythonRunScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held python-run scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("python-run scorecard: ok runs stay clear, a failed run flips the verdict, and no hash or path leaks", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "python-run", pythonRunLedgerSummary(HASH, "none", "sam-grep-phrase.py", null, "ok"));
    recordActivity(dir, "sam", "python-run", pythonRunLedgerSummary(HASH, "SOME_NAME", "tools/probe.py", "box1", "ok"));
    const clean = pythonRunScorecardText(dir);
    assert.match(clean, /^Python runs: clear$/m);
    assert.match(clean, /^Runs: 2$/m);
    assert.match(clean, /^By outcome: ok 2$/m);
    assert.match(clean, /^Sandbox runs: 1$/m);
    assert.match(clean, /^Pass-through runs: 1$/m);
    recordActivity(dir, "sam", "python-run", pythonRunLedgerSummary(HASH, "none", "sekrit-script.py", null, "exit 1"));
    recordActivity(dir, "sam", "python-run", pythonRunLedgerSummary(HASH, "none", "slow.py", null, "exit null (timed out)"));
    recordActivity(dir, "sam", "python-run", pythonRunRefusedLedgerSummary("nope.py", null, "Python script is not a file: nope.py"));
    recordActivity(dir, "sam", "python-run", "Some wholly novel run shape mentioning sekritpath");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = pythonRunScorecardText(dir);
    assert.match(text, /^Python runs: attention$/m);
    assert.match(text, /^Runs: 6$/m);
    assert.match(text, /^By outcome: ok 2, failed 2, refused 1, other 1$/m);
    assert.match(text, /^Sandbox runs: 1$/m);
    assert.match(text, /^Pass-through runs: 1$/m);
    assert.match(text, /^Timed-out runs: 1$/m);
    assert.equal(text.includes("sekrit"), false, "no path surfaces");
    assert.equal(text.includes(HASH), false, "a parsed hash is never printed");
    assert.equal(text.includes("SOME_NAME"), false, "a pass-through name is never printed");
    assert.equal(text.includes("box1"), false, "a sandbox name is never printed");
    assert.equal(text.includes("novel run"), false, "an unmatched summary is never printed");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("python-run parse: the runner's own lines parse, and only the fixed shapes parse", () => {
  assert.deepEqual(parsePythonRunSummary(pythonRunLedgerSummary(HASH, "none", "a.py", null, "ok")), { outcome: "ok", sandbox: false, passThrough: false, timedOut: false });
  assert.deepEqual(parsePythonRunSummary(pythonRunLedgerSummary(HASH, "A,B", "a.py", "sb", "exit 2")), { outcome: "failed", sandbox: true, passThrough: true, timedOut: false });
  assert.deepEqual(parsePythonRunSummary(pythonRunLedgerSummary(HASH, "none", "a.py", null, "exit null (timed out)")), { outcome: "failed", sandbox: false, passThrough: false, timedOut: true });
  assert.deepEqual(parsePythonRunSummary(pythonRunRefusedLedgerSummary("a.py", HASH, "denied")), { outcome: "refused", sandbox: false, passThrough: false, timedOut: false });
  assert.equal(parsePythonRunSummary(""), null);
  assert.equal(parsePythonRunSummary("Some wholly novel run shape"), null);
  assert.equal(parsePythonRunSummary("sha256:xyz pass-through:none path:a.py -> ok"), null);
});

test("python-run scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-python-runs"), "sam-python-runs is allowlisted");
  const argv = scriptArgv("/some/root", "sam-python-runs");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["code", "python-scorecard"], "the argv rides code python-scorecard");
});
