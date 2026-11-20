import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  parseSelfWorkFixSummary,
  parseSelfWorkSummary,
  selfWorkFixMissingTaskDigest,
  selfWorkFixQueuedLedgerSummary,
  selfWorkNoSpecLedgerSummary,
  selfWorkScorecardText,
  selfWorkSpecLedgerSummary,
} from "./self-work.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The self-work ledger daily-measurement wiring (2026-11-20,
// the measured-proof series): the self-work picker and work
// bridge have ledgered as "self-work" and "self-work-fix"
// lines since the loop landed - spec lines and no-spec run
// lines from runSelfWork, fix-queued lines from
// queueSelfWorkFix, and one digest line per terminal fix
// from reconcileSelfWorkFixes - but the classes were never
// folded: the coding scorecard reads the coding tasks the
// fixes become and the gate scorecards read the proposals
// finished fixes land as, yet the loop's own record (how
// many specs were written, how many were owner-only or
// blocked, how many fixes queued, and how those fixes
// closed) had no trending surface, so whether SAM's
// self-repair loop is landing or stalling was invisible in
// aggregate. A fix that closes blocked or failed is the
// loop stalling, so the verdict is attention when any
// digest closed blocked, failed, or other, or any line is
// unparseable. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, no spec id, no defect
// key, no task id, no branch, and no verbatim summary -
// the summaries carry all of those, which the fold counts
// and never prints. The digest status folds to the fixed
// done / blocked / failed / other buckets. The scorecard
// path is a pure read - it creates nothing and runs,
// queues, and reconciles nothing; every state here is
// built through the ledger's own public door
// (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-self-work-ledger-scorecard-"));
}

test("self-work ledger scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = selfWorkScorecardText(dir);
    assert.equal(text, "Self-work: clear, 0 total, runs 0 (specs 0 / no-spec 0), distinct specs 0, owner-only 0 / blocked specs 0, peak ranked 0, fixes 0 (queued 0 / digests 0: done 0 / blocked 0 / failed 0 / other 0)");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = selfWorkScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held self-work scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("self-work ledger scorecard: the classes fold to counts per run, stamp, and fix outcome, and no id or key surfaces", () => {
  const dir = scratch();
  try {
    const clean = selfWorkScorecardText(dir);
    const spec = { id: "selfwork-sekrit1", defectKey: "sekrit-defect", count: 11, ownerOnly: false, blockedBy: null };
    recordActivity(dir, "sam", "self-work", selfWorkSpecLedgerSummary(spec, 4));
    recordActivity(dir, "sam", "self-work", selfWorkSpecLedgerSummary(spec, 6));
    recordActivity(dir, "sam", "self-work", selfWorkSpecLedgerSummary({ id: "selfwork-sekrit2", defectKey: "sekrit-defect", count: 3, ownerOnly: true, blockedBy: "sekrit reason" }, 6));
    recordActivity(dir, "sam", "self-work", selfWorkNoSpecLedgerSummary());
    recordActivity(dir, "sam", "self-work-fix", selfWorkFixQueuedLedgerSummary(spec, "sekrit-task-id"));
    recordActivity(dir, "sam", "self-work-fix", "Self-fix selfwork-sekrit1 (sekrit-defect x11): done - 1 file(s) changed on sam/sekrit-branch, 1 local commit(s); git-push proposal sekrit99 waits on the owner's approval - nothing lands without it");
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = selfWorkScorecardText(dir);
    assert.equal(text, "Self-work: clear, 6 total, runs 4 (specs 3 / no-spec 1), distinct specs 2, owner-only 1 / blocked specs 1, peak ranked 6, fixes 2 (queued 1 / digests 1: done 1 / blocked 0 / failed 0 / other 0)");
    assert.equal(text.includes("sekrit"), false, "no id, key, task, branch, or proposal surfaces");
    assert.equal(text.includes("selfwork-"), false, "no spec id surfaces");
    assert.notEqual(text, clean, "the first recorded run changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("self-work ledger scorecard: blocked, failed, and missing-task digests read attention, and an unmatched shape is never printed", () => {
  const dir = scratch();
  try {
    const fix = { specId: "selfwork-sekrit3", defectKey: "sekrit-defect", count: 5 };
    recordActivity(dir, "sam", "self-work-fix", "Self-fix selfwork-sekrit3 (sekrit-defect x5): blocked - The code root's sekrit working tree reason");
    recordActivity(dir, "sam", "self-work-fix", "Self-fix selfwork-sekrit3 (sekrit-defect x5): failed - Runner sekrit failure");
    recordActivity(dir, "sam", "self-work-fix", selfWorkFixMissingTaskDigest(fix));
    recordActivity(dir, "sam", "self-work-fix", "Some wholly novel fix shape mentioning sekrit-title");
    const text = selfWorkScorecardText(dir);
    assert.equal(text, "Self-work: attention, 4 total, runs 0 (specs 0 / no-spec 0), distinct specs 1, owner-only 0 / blocked specs 0, peak ranked 0, fixes 4 (queued 0 / digests 3: done 0 / blocked 1 / failed 1 / other 1), 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no id, key, or reason surfaces");
    assert.equal(text.includes("novel fix"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("self-work ledger parse: the seams' own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    selfWorkSpecLedgerSummary({ id: "selfwork-07372cda", defectKey: "tool-budget", count: 11, ownerOnly: false, blockedBy: null }, 4),
    "Self-work spec selfwork-07372cda written: tool-budget x11 - 4 defect class(es) ranked",
  );
  assert.equal(
    selfWorkSpecLedgerSummary({ id: "selfwork-07372cda", defectKey: "tool-budget", count: 11, ownerOnly: true, blockedBy: "some reason" }, 4),
    "Self-work spec selfwork-07372cda written: tool-budget x11 (owner-only) (blocked) - 4 defect class(es) ranked",
  );
  assert.equal(selfWorkNoSpecLedgerSummary(), "Self-work run: no ledgered defect classes found - no spec written");
  assert.equal(
    selfWorkFixQueuedLedgerSummary({ id: "selfwork-07372cda", defectKey: "tool-budget", count: 11 }, "882278e4-3e2b-49d8-9360-9ed73782ca03"),
    "Self-work fix queued: spec selfwork-07372cda (tool-budget x11) -> coding task 882278e4-3e2b-49d8-9360-9ed73782ca03 in the designated code root; it lands only through the git-push approval gate",
  );
  assert.equal(
    selfWorkFixMissingTaskDigest({ specId: "selfwork-07372cda", defectKey: "tool-budget", count: 11 }),
    "Self-fix selfwork-07372cda (tool-budget x11): coding task record no longer exists - nothing landed; re-spec from the ledger if the class still recurs",
  );
  assert.deepEqual(parseSelfWorkSummary(selfWorkSpecLedgerSummary({ id: "s1", defectKey: "k", count: 2, ownerOnly: true, blockedBy: null }, 7)), { specId: "s1", ownerOnly: true, blocked: false, ranked: 7 });
  assert.deepEqual(parseSelfWorkSummary(selfWorkNoSpecLedgerSummary()), { specId: null });
  assert.deepEqual(parseSelfWorkFixSummary(selfWorkFixQueuedLedgerSummary({ id: "s1", defectKey: "k", count: 2 }, "t1")), { type: "queued", specId: "s1" });
  assert.deepEqual(parseSelfWorkFixSummary("Self-fix s1 (k x2): done - 0 file(s) changed"), { type: "digest", specId: "s1", status: "done" });
  assert.deepEqual(parseSelfWorkFixSummary(selfWorkFixMissingTaskDigest({ specId: "s1", defectKey: "k", count: 2 })), { type: "digest", specId: "s1", status: "other" }, "the missing-task digest folds to other");
  assert.equal(parseSelfWorkSummary(""), null);
  assert.equal(parseSelfWorkSummary("Self-work spec s1 written: k x2 - many defect class(es) ranked"), null, "a non-numeric ranked count does not parse");
  assert.equal(parseSelfWorkFixSummary(""), null);
  assert.equal(parseSelfWorkFixSummary("Self-work fix queued: spec s1 (k x2) -> coding task t1 somewhere else"), null, "a queued line off the fixed shape does not parse");
});

test("self-work ledger scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-self-work-scorecard"), "sam-self-work-scorecard is allowlisted");
  const argv = scriptArgv("/some/root", "sam-self-work-scorecard");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["self-work", "scorecard"], "the argv rides self-work scorecard");
});
