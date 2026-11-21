import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseSetupVerifiedSummary, setupHistoryScorecardText, setupVerifiedLedgerSummary } from "./config-wizard.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The setup history daily-measurement wiring (2026-11-21,
// the measured-proof series): every successful first-run
// setup verification has ledgered as a setup-verified line
// since CLI dressing item 1 - as inline concatenation with
// no ONE writer and no fold, so how many times this
// install's model route was ever verified, across how many
// distinct models and providers, was invisible in aggregate
// (readSetupRecord reads only the current baseline; the
// setup store is a singleton whose one row is overwritten
// on every successful setup). This family has no failure
// class of its own (setup-store-failed rides the
// store-failure fold), so the verdict is attention only
// when a line is unparseable. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it
// is ONE line carrying counts only: no stamp, no actor, no
// model name, no provider name - the summaries carry model
// and provider names, which the fold consumes and never
// prints. The scorecard path is a pure read - it creates
// nothing, verifies nothing, and saves nothing; every state
// here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-setup-history-"));
}

const BARE = "Setup history: clear, 0 verified, 0 distinct models, 0 distinct providers, 0 total";

test("setup history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = setupHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = setupHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held setup scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("setup history scorecard: verifications fold to counts and distinct models and providers, and no name surfaces", () => {
  const dir = scratch();
  try {
    const clean = setupHistoryScorecardText(dir);
    recordActivity(dir, "owner", "setup-verified", setupVerifiedLedgerSummary("sekrit-model-alpha", "minimax"));
    recordActivity(dir, "owner", "setup-verified", setupVerifiedLedgerSummary("sekrit-model-alpha", "minimax"));
    recordActivity(dir, "owner", "setup-verified", setupVerifiedLedgerSummary("sekrit-model-beta", "none"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = setupHistoryScorecardText(dir);
    assert.equal(text, "Setup history: clear, 3 verified, 2 distinct models, 2 distinct providers, 3 total");
    assert.equal(text.includes("sekrit"), false, "no model or provider name surfaces");
    assert.equal(text.includes("minimax"), false, "no provider name surfaces");
    assert.notEqual(text, clean, "the first recorded verification changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("setup history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "owner", "setup-verified", setupVerifiedLedgerSummary("alpha", "minimax"));
    recordActivity(dir, "owner", "setup-verified", "Some wholly novel setup shape naming sekrit_evidence");
    recordActivity(dir, "owner", "setup-verified", "Model setup verified: beta via bogus-provider (one real completion; recorded in the setup store)");
    const text = setupHistoryScorecardText(dir);
    assert.equal(text, "Setup history: attention, 1 verified, 1 distinct models, 1 distinct providers, 3 total, 2 unparseable");
    assert.equal(text.includes("novel setup"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("bogus"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("setup parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(setupVerifiedLedgerSummary("MiniMax-M2.5", "minimax"), "Model setup verified: MiniMax-M2.5 via minimax (one real completion; recorded in the setup store)");
  assert.deepEqual(parseSetupVerifiedSummary(setupVerifiedLedgerSummary("MiniMax-M2.5", "minimax")), { model: "MiniMax-M2.5", provider: "minimax" });
  assert.deepEqual(parseSetupVerifiedSummary(setupVerifiedLedgerSummary("some-model", "none")), { model: "some-model", provider: "none" });
  assert.equal(parseSetupVerifiedSummary(""), null);
  assert.equal(parseSetupVerifiedSummary("Model setup verified: alpha via openai (one real completion; recorded in the setup store)"), null, "a provider outside the fixed vocabulary does not parse");
  assert.equal(parseSetupVerifiedSummary("Model setup verified: alpha via minimax"), null, "a line missing the fixed tail does not parse");
  assert.equal(parseSetupVerifiedSummary("Model setup verified:  via minimax (one real completion; recorded in the setup store)"), null, "a line with no model does not parse");
  assert.equal(parseSetupVerifiedSummary("Model setup verified: alpha beta via minimax (one real completion; recorded in the setup store)"), null, "a model with a space does not parse as one token");
});

test("setup history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-setup-history"), "sam-setup-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-setup-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["config", "history"], "the argv rides config history");
});
