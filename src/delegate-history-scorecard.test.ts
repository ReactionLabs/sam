import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { delegateCancelledLedgerSummary, delegateFailedSummary, delegateFailureLedgerSummary, delegateHistoryScorecardText, delegateOutputLedgerSummary, delegateProposedLedgerSummary, delegateRunLedgerSummary, parseDelegateCancelledSummary, parseDelegateDoneSummary, parseDelegateFailedSummary, parseDelegateOutputSummary, parseDelegateProposedSummary } from "./coding-operatives.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The delegate history daily-measurement wiring (2026-11-21,
// the measured-proof series): the coding-operative
// delegation lifecycle ledgers five classes - a proposal
// ("delegate-proposed"), streamed output chunks
// ("delegate-output"), and the three terminal classes
// ("delegate-done" / "delegate-failed" /
// "delegate-cancelled", the cancelled class in three
// shapes) - but none was ever folded, so how many
// delegations were ever proposed, completed, failed, or
// cancelled over an install's life was invisible in
// aggregate; the delegations store is rewritten in place
// and holds only current jobs, so a finished delegation
// leaves no surface but these lines (the failover-routes
// precedent). A failed delegation is the failure class, so
// the verdict is attention when any failed was ever
// recorded or any line is unparseable, else clear; a
// cancellation is an owner act, not a failure. The
// scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, no delegation id, no
// adapter, no branch, no prompt, no output text, and no
// verbatim summary. The scorecard path is a pure read -
// it creates nothing, proposes nothing, and opens no
// store; every state here is built through the ledger's
// own public door (recordActivity) with the seams' own
// summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-delegate-history-"));
}

const BARE = "Delegate history: clear, 0 proposed, 0 done, 0 failed, 0 cancelled, 0 output lines, 0 distinct delegations, 0 total";
const ID1 = "11111111-2222-3333-4444-555555555555";
const ID2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ID3 = "99999999-8888-7777-6666-555555555555";
const DONE_SUMMARY = "Delegation done: codex on branch sam/sekrit-branch\nexit 0\ndiff:\n1 file changed\ntests: passed\nNot pushed. No pull request was opened.";
const FAILED_RUN_SUMMARY = "Delegation failed: codex on branch sam/sekrit-branch\nexit 1\ndiff:\n(none)\ntests: failed\nNot pushed. No pull request was opened.";

test("delegate history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = delegateHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = delegateHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held delegate scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delegate history scorecard: recorded lifecycle lines fold to counts with distinct delegations as a number only", () => {
  const dir = scratch();
  try {
    const clean = delegateHistoryScorecardText(dir);
    recordActivity(dir, "owner", "delegate-proposed", delegateProposedLedgerSummary(ID1, "codex", "sam/sekrit-branch"));
    recordActivity(dir, "owner", "delegate-proposed", delegateProposedLedgerSummary(ID2, "claude-code", "sam/other-branch"));
    recordActivity(dir, "owner", "delegate-output", delegateOutputLedgerSummary("codex", ID1, "sekrit chunk one"));
    recordActivity(dir, "owner", "delegate-output", delegateOutputLedgerSummary("codex", ID1, "sekrit chunk two"));
    recordActivity(dir, "owner", "delegate-done", delegateRunLedgerSummary(DONE_SUMMARY));
    recordActivity(dir, "owner", "delegate-failed", delegateRunLedgerSummary(FAILED_RUN_SUMMARY));
    recordActivity(dir, "owner", "delegate-cancelled", delegateCancelledLedgerSummary(ID3, "codex", "sam/third-branch"));
    recordActivity(dir, "owner", "delegate-cancelled", delegateFailureLedgerSummary(delegateFailedSummary("cancelled", new Error("owner stopped it"))));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = delegateHistoryScorecardText(dir);
    assert.equal(text, "Delegate history: attention, 2 proposed, 1 done, 1 failed, 2 cancelled, 2 output lines, 3 distinct delegations, 8 total");
    assert.equal(text.includes("sekrit"), false, "no branch, prompt, or output text surfaces");
    assert.equal(text.includes("codex"), false, "no adapter surfaces");
    assert.equal(text.includes("11111111"), false, "no delegation id surfaces");
    assert.equal(text.includes("owner"), false, "no actor surfaces");
    assert.notEqual(text, clean, "the first recorded proposal changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delegate history scorecard: a cancelled-only history stays clear, and an unmatched shape is attention and never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "owner", "delegate-cancelled", delegateCancelledLedgerSummary(ID1, "codex", "sam/sekrit-branch"));
    const cancelledOnly = delegateHistoryScorecardText(dir);
    assert.equal(cancelledOnly, "Delegate history: clear, 0 proposed, 0 done, 0 failed, 1 cancelled, 0 output lines, 1 distinct delegations, 1 total");
    recordActivity(dir, "owner", "delegate-done", "A sekrit delegation quietly finished");
    const text = delegateHistoryScorecardText(dir);
    assert.equal(text, "Delegate history: attention, 0 proposed, 0 done, 0 failed, 1 cancelled, 0 output lines, 1 distinct delegations, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delegate parsers: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(delegateProposedLedgerSummary(ID1, "codex", "sam/demo"), "Delegation " + ID1 + " cards the owner: codex sam/demo (nothing has run)");
  assert.deepEqual(parseDelegateProposedSummary(delegateProposedLedgerSummary(ID1, "codex", "sam/demo")), { id: ID1, adapter: "codex", branch: "sam/demo" });
  assert.equal(parseDelegateProposedSummary(""), null);
  assert.equal(parseDelegateProposedSummary("Delegation " + ID1 + " cards the owner: codex sam/demo (nothing has run) tonight"), null, "a line with trailing text does not parse");
  assert.equal(delegateOutputLedgerSummary("codex", ID1, "chunk  one\ntwo"), "codex 11111111: chunk one two");
  assert.deepEqual(parseDelegateOutputSummary(delegateOutputLedgerSummary("codex", ID1, "hello")), { adapter: "codex", idPrefix: "11111111" });
  assert.equal(parseDelegateOutputSummary("codex 1111111: short prefix"), null, "a seven-char prefix does not parse");
  assert.equal(delegateRunLedgerSummary("a\nb  c"), "a b c", "the run writer collapses whitespace");
  assert.equal(delegateFailureLedgerSummary("a\nb"), "a\nb", "the failure writer slices only");
  assert.deepEqual(parseDelegateDoneSummary(delegateRunLedgerSummary(DONE_SUMMARY)), { adapter: "codex", branch: "sam/sekrit-branch", exitCode: "0" });
  assert.equal(parseDelegateDoneSummary(delegateRunLedgerSummary(FAILED_RUN_SUMMARY)), null, "a failed line is not a done line");
  assert.deepEqual(parseDelegateFailedSummary(delegateRunLedgerSummary(FAILED_RUN_SUMMARY)), { adapter: "codex", branch: "sam/sekrit-branch" });
  assert.deepEqual(parseDelegateFailedSummary(delegateFailureLedgerSummary(delegateFailedSummary("failed", new Error("worktree dirty")))), { adapter: null, branch: null }, "the reason shape parses with no run fields");
  assert.equal(parseDelegateFailedSummary("Delegation failed:"), null, "an empty reason does not parse");
  assert.equal(delegateCancelledLedgerSummary(ID3, "codex", "sam/third"), "Cancelled delegation " + ID3 + " (codex sam/third)");
  assert.deepEqual(parseDelegateCancelledSummary(delegateCancelledLedgerSummary(ID3, "codex", "sam/third")), { id: ID3, adapter: "codex", branch: "sam/third" });
  assert.deepEqual(parseDelegateCancelledSummary(delegateFailureLedgerSummary(delegateFailedSummary("cancelled", new Error("owner stopped it")))), { id: null, adapter: null, branch: null }, "the cancelled reason shape parses");
  assert.equal(parseDelegateCancelledSummary(""), null);
  assert.equal(parseDelegateCancelledSummary(delegateProposedLedgerSummary(ID1, "codex", "sam/demo")), null, "a proposed line is not a cancelled line");
});

test("delegate history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-delegate-history"), "sam-delegate-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-delegate-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["delegate", "history"], "the argv rides delegate history");
});
