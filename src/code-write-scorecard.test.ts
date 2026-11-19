import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { codeWriteLedgerSummary, codeWriteScorecardText, parseCodeWriteSummary } from "./code.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The code-write daily-measurement wiring (2026-11-18, the
// measured-proof series): every C1 write ledgers one
// code-write line carrying the verb, the path, and the diff's
// line counts, but no daily surface ever counted the writes,
// so the hands going silent, a mix shift, or a churn spike
// was invisible in aggregate. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it carries
// counts only: no stamp, no actor, no path, and no verbatim
// summary; an unmatched shape counts as a write under other,
// never printed. The scorecard path is a pure read - it
// creates nothing, spends no model call, and writes nothing;
// every state here is built through the ledger's own public
// door (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-code-write-scorecard-"));
}

test("code-write scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = codeWriteScorecardText(dir);
    assert.match(text, /^Code writes: clear$/m);
    assert.match(text, /^Writes: 0$/m);
    assert.match(text, /^By kind: none$/m);
    assert.match(text, /^Lines added: 0$/m);
    assert.match(text, /^Lines removed: 0$/m);
    assert.match(text, /^Distinct files: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = codeWriteScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held code-write scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("code-write scorecard: writes fold to fixed buckets and sums, a malformed line flips the verdict, and no path leaks", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "code-write", codeWriteLedgerSummary(true, "sekrit-file.py", 19, 0));
    recordActivity(dir, "sam", "code-write", codeWriteLedgerSummary(false, "sekrit-file.py", 3, 2));
    recordActivity(dir, "sam", "code-write", codeWriteLedgerSummary(false, "other-file.py", 1, 1));
    const clean = codeWriteScorecardText(dir);
    assert.match(clean, /^Code writes: clear$/m);
    assert.match(clean, /^Writes: 3$/m);
    assert.match(clean, /^By kind: created 1, edited 2$/m);
    assert.match(clean, /^Lines added: 23$/m);
    assert.match(clean, /^Lines removed: 3$/m);
    assert.match(clean, /^Distinct files: 2$/m);
    recordActivity(dir, "sam", "code-write", "Some wholly novel write shape mentioning sekrit-path.py");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = codeWriteScorecardText(dir);
    assert.match(text, /^Code writes: attention$/m);
    assert.match(text, /^Writes: 4$/m);
    assert.match(text, /^By kind: created 1, edited 2, other 1$/m);
    assert.equal(text.includes("sekrit"), false, "no path surfaces");
    assert.equal(text.includes("novel write"), false, "an unmatched summary is never printed");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("code-write parse: the seam's own lines parse, and only the fixed shape parses", () => {
  assert.deepEqual(parseCodeWriteSummary(codeWriteLedgerSummary(true, "a.py", 19, 0)), { kind: "created", path: "a.py", addedLines: 19, removedLines: 0 });
  assert.deepEqual(parseCodeWriteSummary(codeWriteLedgerSummary(false, "sub/b.ts", 3, 2)), { kind: "edited", path: "sub/b.ts", addedLines: 3, removedLines: 2 });
  assert.equal(codeWriteLedgerSummary(true, "a.py", 19, 0), "Wrote a.py in the code root (+19/-0 lines)", "the writer's shape is byte-identical to the historical inline shape");
  assert.equal(parseCodeWriteSummary(""), null);
  assert.equal(parseCodeWriteSummary("Some wholly novel write shape"), null);
  assert.equal(parseCodeWriteSummary("Wrote a.py in the code root (+19 lines)"), null);
});

test("code-write scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-code-writes"), "sam-code-writes is allowlisted");
  const argv = scriptArgv("/some/root", "sam-code-writes");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["code", "write-scorecard"], "the argv rides code write-scorecard");
});
