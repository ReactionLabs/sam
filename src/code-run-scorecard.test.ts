import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { codeRunLedgerSummary, codeRunScorecardText, parseCodeRunSummary } from "./code.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The code-run daily-measurement wiring (2026-11-18, the
// measured-proof series): every C2 verify-hand run ledgers
// one code-run line carrying the allowlisted command name
// and its outcome, but no daily surface ever counted the
// runs, so a build or test that started timing out, or a
// command whose binary vanished, was invisible in aggregate.
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it carries counts only: no
// stamp, no actor, no command name, and no verbatim summary;
// an unmatched shape counts as a run under other, never
// printed. The scorecard path is a pure read - it creates
// nothing, spends no model call, and runs nothing; every
// state here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-code-run-scorecard-"));
}

test("code-run scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = codeRunScorecardText(dir);
    assert.match(text, /^Code runs: clear$/m);
    assert.match(text, /^Runs: 0$/m);
    assert.match(text, /^By outcome: none$/m);
    assert.match(text, /^Timed-out runs: 0$/m);
    assert.match(text, /^Distinct commands: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = codeRunScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held code-run scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("code-run scorecard: runs fold to fixed buckets and counts, a bad or malformed line flips the verdict, and no command name leaks", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "code-run", codeRunLedgerSummary("sekrit-build", "ok"));
    recordActivity(dir, "sam", "code-run", codeRunLedgerSummary("sekrit-build", "ok"));
    recordActivity(dir, "sam", "code-run", codeRunLedgerSummary("sekrit-test", "exit 1"));
    const clean = codeRunScorecardText(dir);
    assert.match(clean, /^Code runs: attention$/m);
    assert.match(clean, /^Runs: 3$/m);
    assert.match(clean, /^By outcome: ok 2, failed 1$/m);
    assert.match(clean, /^Timed-out runs: 0$/m);
    assert.match(clean, /^Distinct commands: 2$/m);
    recordActivity(dir, "sam", "code-run", codeRunLedgerSummary("sekrit-test", "exit null (timed out)"));
    recordActivity(dir, "sam", "code-run", codeRunLedgerSummary("sekrit-doctor", "/opt/sekrit/bin is not installed on this machine - the allowlisted command cannot run until it is installed"));
    recordActivity(dir, "sam", "code-run", "Some wholly novel run shape mentioning sekrit-command");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = codeRunScorecardText(dir);
    assert.match(text, /^Code runs: attention$/m);
    assert.match(text, /^Runs: 6$/m);
    assert.match(text, /^By outcome: ok 2, failed 2, error 1, other 1$/m);
    assert.match(text, /^Timed-out runs: 1$/m);
    assert.match(text, /^Distinct commands: 3$/m);
    assert.equal(text.includes("sekrit"), false, "no command name or error prose surfaces");
    assert.equal(text.includes("novel run"), false, "an unmatched summary is never printed");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the changed scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("code-run parse: the seam's own lines parse, and only the fixed shape parses", () => {
  assert.deepEqual(parseCodeRunSummary(codeRunLedgerSummary("build", "ok")), { outcome: "ok", command: "build", timedOut: false });
  assert.deepEqual(parseCodeRunSummary(codeRunLedgerSummary("test", "exit 2")), { outcome: "failed", command: "test", timedOut: false });
  assert.deepEqual(parseCodeRunSummary(codeRunLedgerSummary("test", "exit null (timed out)")), { outcome: "failed", command: "test", timedOut: true });
  assert.deepEqual(parseCodeRunSummary(codeRunLedgerSummary("agent-reach-doctor", "agent-reach is not installed on this machine")), { outcome: "error", command: "agent-reach-doctor", timedOut: false });
  assert.equal(codeRunLedgerSummary("build", "ok"), "Ran build in the code root: ok", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(parseCodeRunSummary(""), null);
  assert.equal(parseCodeRunSummary("Some wholly novel run shape"), null);
  assert.equal(parseCodeRunSummary("Ran build somewhere else: ok"), null);
});

test("code-run scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-code-runs"), "sam-code-runs is allowlisted");
  const argv = scriptArgv("/some/root", "sam-code-runs");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["code", "run-scorecard"], "the argv rides code run-scorecard");
});
