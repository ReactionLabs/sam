import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalPolicyFailureSummary, approvalPolicyFailedHistoryScorecardText, parseApprovalPolicyFailedSummary } from "./approval-policy.js";
import { recordActivity } from "./activity.js";
import { draftFailureSummary } from "./drafts.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The approval policy failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the approval
// policy store's touches ledger every failure as an
// approval-policy-failed line through the ONE writer
// (approvalPolicyFailureSummary, fixed shape: "Approval
// policy <phase> failed: <reason>", phases read / write,
// ridden by recordApprovalPolicyFailure from the store's
// read door and the save UPSERT, actor sam) - but the class
// was never folded, so how often the store that decides HOW
// every proposal on the ONE gate is decided failed a touch
// was invisible in aggregate (a dead store fails closed to
// manual by design, safe but silent). Every failure line is
// by construction a policy touch that did not complete its
// store work, so the verdict is attention when any failure
// was ever recorded or any line is unparseable, else clear.
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no reason, and no verbatim summary - the
// summaries carry reasons, and the fold consumes and never
// prints them, and no policy content ever surfaces (the
// mode and auto list are the owner's gate posture, not
// failure data, and never enter the writer's line either).
// The scorecard path is a pure read - it creates nothing,
// saves nothing, and decides nothing; every state here is
// built through the ledger's own public door
// (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-approval-policy-failed-history-"));
}

const BARE = "Approval policy failed history: clear, 0 failed, 0 read, 0 write, 0 total";

test("approval policy failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = approvalPolicyFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = approvalPolicyFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held approval policy scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("approval policy failed history scorecard: the writer's failures fold to counts with the phase split, and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = approvalPolicyFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "approval-policy-failed", approvalPolicyFailureSummary("read", "EISDIR: illegal operation sekrit"));
    recordActivity(dir, "sam", "approval-policy-failed", approvalPolicyFailureSummary("read", "disk full"));
    recordActivity(dir, "sam", "approval-policy-failed", approvalPolicyFailureSummary("write", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = approvalPolicyFailedHistoryScorecardText(dir);
    assert.equal(text, "Approval policy failed history: attention, 3 failed, 2 read, 1 write, 3 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EPERM"), false, "no reason head surfaces");
    assert.equal(text.includes("EISDIR"), false, "no reason head surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("approval policy failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = approvalPolicyFailureSummary("write", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseApprovalPolicyFailedSummary(capped), { phase: "write" });
    recordActivity(dir, "sam", "approval-policy-failed", capped);
    recordActivity(dir, "sam", "approval-policy-failed", approvalPolicyFailureSummary("read", "boom"));
    const text = approvalPolicyFailedHistoryScorecardText(dir);
    assert.equal(text, "Approval policy failed history: attention, 2 failed, 1 read, 1 write, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("approval policy failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and an unknown-phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "approval-policy-failed", approvalPolicyFailureSummary("read", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "approval-policy-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "approval-policy-failed", draftFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "approval-policy-failed", "Approval policy read failed:   ");
    recordActivity(dir, "sam", "approval-policy-failed", "Approval policy delete failed: boom");
    const text = approvalPolicyFailedHistoryScorecardText(dir);
    assert.equal(text, "Approval policy failed history: attention, 1 failed, 1 read, 0 write, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("approval policy failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(approvalPolicyFailureSummary("read", "database is locked"), "Approval policy read failed: database is locked");
  assert.equal(approvalPolicyFailureSummary("write", "disk gone"), "Approval policy write failed: disk gone");
  assert.deepEqual(parseApprovalPolicyFailedSummary(approvalPolicyFailureSummary("read", "boom")), { phase: "read" });
  assert.deepEqual(parseApprovalPolicyFailedSummary(approvalPolicyFailureSummary("write", "boom")), { phase: "write" });
  assert.equal(parseApprovalPolicyFailedSummary(""), null);
  assert.equal(parseApprovalPolicyFailedSummary("Approval policy read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseApprovalPolicyFailedSummary("Approval policy read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseApprovalPolicyFailedSummary("Approval policy delete failed: boom"), null, "a phase the door never writes does not parse");
  assert.equal(parseApprovalPolicyFailedSummary("Approval mode set to smart (auto: note)"), null, "an approval-mode line never parses as an approval-policy-failed line");
  assert.equal(parseApprovalPolicyFailedSummary(draftFailureSummary("read", "boom")), null, "a draft-failed line never parses as an approval-policy-failed line");
  assert.deepEqual(parseApprovalPolicyFailedSummary("Approval policy read failed: boom: with colon"), { phase: "read" }, "a reason carrying a colon still parses from the fixed head");
});

test("approval policy failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-approval-policy-failed-history"), "sam-approval-policy-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-approval-policy-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["actions", "policy-failed-history"], "the argv rides actions policy-failed-history");
});
