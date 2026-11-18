import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { loaderLoopLedgerSummary, loaderLoopScorecardText, parseLoaderLoopSummary, prepLoopLedgerSummary } from "./tool-tiers.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The loader-loop daily-measurement wiring (2026-11-18,
// the measured-proof series): the loader-loop guard and
// its preparation-loop generalization ledger every stopped
// turn, but no daily surface ever counted the stops, so a
// chat that kept looping on preparation was invisible until
// the owner watched a turn die. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it
// carries counts only: no stamp, no actor, no tool name, no
// verbatim summary - stops fold into the two fixed shapes
// the guard writes and an unmatched shape is "other", never
// printed. The scorecard path is a pure read - it creates
// nothing, spends no model call, and retries nothing; every
// state here is built through the ledger's own public door
// (recordActivity) with the guard's own summary writers
// (loaderLoopLedgerSummary / prepLoopLedgerSummary), never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-loader-loop-scorecard-"));
}

test("loader loop scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = loaderLoopScorecardText(dir);
    assert.match(text, /^Loader loops: clear$/m);
    assert.match(text, /^Stopped turns: 0$/m);
    assert.match(text, /^By kind: none$/m);
    assert.match(text, /^Calls used: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = loaderLoopScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held loader-loop scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loader loop scorecard: stopped turns flip the verdict, fold to fixed kinds, and leak no content", () => {
  const dir = scratch();
  try {
    const clean = loaderLoopScorecardText(dir);
    recordActivity(dir, "sam", "loader-loop", loaderLoopLedgerSummary(Array.from({ length: 13 }, (_, i) => "tool_" + String(i))));
    recordActivity(dir, "dip", "preparation-loop", prepLoopLedgerSummary(["sam_load_tools", "sam_orchestrate", "sekrit_tool", "sam_load_tools", "sam_orchestrate"], false));
    recordActivity(dir, "sam", "loader-loop", loaderLoopLedgerSummary(["sam_load_tools", "sekrit_tool", "sam_load_tools"]) + " - owner turn steered, loader disabled, turn continues with the tools already loaded");
    recordActivity(dir, "sam", "loader-loop", "Some wholly novel stop shape mentioning sekrit_tool");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = loaderLoopScorecardText(dir);
    assert.match(text, /^Loader loops: attention$/m);
    assert.match(text, /^Stopped turns: 4$/m);
    assert.match(text, /^By kind: loader 2, other 1, preparation 1$/m);
    assert.match(text, /^Calls used: 21$/m);
    assert.equal(text.includes("sekrit"), false, "no tool name surfaces");
    assert.equal(text.includes("novel stop"), false, "an unmatched summary is never printed");
    assert.notEqual(text, clean, "the first stopped turn changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loader loop parse: every fixed shape classifies with its calls, and only into the fixed shapes", () => {
  assert.deepEqual(parseLoaderLoopSummary(loaderLoopLedgerSummary(["a", "b"])), { kind: "loader", calls: 2 });
  assert.deepEqual(parseLoaderLoopSummary(prepLoopLedgerSummary(["a"], true)), { kind: "loader", calls: 1 });
  assert.deepEqual(parseLoaderLoopSummary(prepLoopLedgerSummary(["a", "b", "c"], false)), { kind: "preparation", calls: 3 });
  assert.deepEqual(
    parseLoaderLoopSummary(loaderLoopLedgerSummary(["a"]) + " - owner turn steered, loader disabled, turn continues with the tools already loaded"),
    { kind: "loader", calls: 1 },
    "the steered suffix still parses by its fixed prefix",
  );
  assert.equal(parseLoaderLoopSummary(""), null);
  assert.equal(parseLoaderLoopSummary("Some wholly novel stop shape"), null);
});

test("loader loop scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-loader-loops"), "sam-loader-loops is allowlisted");
  const argv = scriptArgv("/some/root", "sam-loader-loops");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "loop-scorecard"], "the argv rides observe loop-scorecard");
});
