import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { fenceIntegrityFailureSummary, parseFenceIntegrityFailedSummary, fenceIntegrityFailedHistoryScorecardText, recordFenceIntegrityFailure, type FenceCheck } from "./fence-integrity.js";
import { sourceCitationFailureSummary } from "./source-citations.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The fence integrity failed history daily-measurement wiring
// (2026-11-22, the measured-proof series): the compaction fold
// ledgers every standing-law movement as a fence-integrity-failed
// line through the ONE writer fenceIntegrityFailureSummary,
// ridden by the one seam recordFenceIntegrityFailure - but the
// class was never folded, so how often a profile's law moved
// across a fold was invisible in aggregate. Every failure line
// is by construction a fence that moved, so the verdict is
// attention when any failure was ever recorded or any line is
// unparseable, else clear. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no profile
// name, no record id, and no identifier - the summaries carry
// profiles, record ids, and verbatim identifiers, which the
// fold consumes and never prints (the changed-record counts
// are summed from the explicit counts at the head of each
// changed part). The scorecard path is a pure read - it
// creates nothing, sends nothing, retries nothing, and
// compacts nothing; every state here is built through the
// ledger's own public door (recordActivity) with the seam's
// own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-fence-integrity-failed-history-"));
}

const BARE = "Fence integrity failed history: clear, 0 failed, 0 distinct profiles, 0 changed records, 0 total";

const CHANGED_TWO: FenceCheck = { ok: false, changedIds: ["12345678-aaaa-bbbb-cccc-dddddddddddd", "87654321-aaaa-bbbb-cccc-dddddddddddd"], missingIdentifiers: [] };
const LOST_TWO: FenceCheck = { ok: false, changedIds: [], missingIdentifiers: ["47-ALPHA", "dip@example.com"] };
const BOTH: FenceCheck = { ok: false, changedIds: ["abcdef12-aaaa-bbbb-cccc-dddddddddddd"], missingIdentifiers: ["47-ALPHA"] };

test("fence integrity failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = fenceIntegrityFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = fenceIntegrityFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held fence integrity scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fence integrity failed history scorecard: the seam's failures fold to counts across profiles and shapes, and no profile, record id, or identifier surfaces", () => {
  const dir = scratch();
  try {
    const clean = fenceIntegrityFailedHistoryScorecardText(dir);
    recordFenceIntegrityFailure(dir, "dip", "dip", CHANGED_TWO);
    recordFenceIntegrityFailure(dir, "trading", "trading", LOST_TWO);
    recordFenceIntegrityFailure(dir, "dip", "dip", BOTH);
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = fenceIntegrityFailedHistoryScorecardText(dir);
    assert.equal(text, "Fence integrity failed history: attention, 3 failed, 2 distinct profiles, 3 changed records, 3 total");
    assert.equal(text.includes("dip"), false, "no profile name surfaces");
    assert.equal(text.includes("trading"), false, "no profile name surfaces");
    assert.equal(text.includes("12345678"), false, "no record id surfaces");
    assert.equal(text.includes("47-ALPHA"), false, "no identifier surfaces");
    assert.equal(text.includes("example.com"), false, "no identifier surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fence integrity failed history scorecard: the writer's own 300-char cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const many: FenceCheck = {
      ok: false,
      changedIds: Array.from({ length: 40 }, (_, i) => String(i).padStart(8, "0") + "-aaaa-bbbb-cccc-dddddddddddd"),
      missingIdentifiers: [],
    };
    const capped = fenceIntegrityFailureSummary("dip", many);
    assert.equal(capped.length, 300, "the writer caps its line at 300");
    recordActivity(dir, "sam", "fence-integrity-failed", capped);
    assert.deepEqual(parseFenceIntegrityFailedSummary(capped), { profile: "dip", changed: 40 });
    const text = fenceIntegrityFailedHistoryScorecardText(dir);
    assert.equal(text, "Fence integrity failed history: attention, 1 failed, 1 distinct profiles, 40 changed records, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fence integrity failed history scorecard: an unmatched shape, a sibling kind's shape, a count that disagrees with its list, and an empty tail count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordFenceIntegrityFailure(dir, "dip", "dip", { ok: false, changedIds: [], missingIdentifiers: [] });
    recordActivity(dir, "sam", "fence-integrity-failed", "Some wholly novel fence shape naming sekrit_identifier");
    recordActivity(dir, "sam", "fence-integrity-failed", sourceCitationFailureSummary("attach", new Error("boom sekrit")));
    recordActivity(dir, "sam", "fence-integrity-failed", "Fence integrity check failed for profile dip: 1 law record(s) changed: aaaa1111, bbbb2222");
    recordActivity(dir, "sam", "fence-integrity-failed", "Fence integrity check failed for profile dip:");
    const text = fenceIntegrityFailedHistoryScorecardText(dir);
    assert.equal(text, "Fence integrity failed history: attention, 1 failed, 1 distinct profiles, 0 changed records, 5 total, 4 unparseable");
    assert.equal(text.includes("novel fence"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("aaaa1111"), false, "no record id surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fence integrity failed parse: the writer is byte-identical to the ledgered shapes and parses, and only the fixed shapes parse", () => {
  assert.equal(
    fenceIntegrityFailureSummary("dip", { ok: false, changedIds: ["12345678-aaaa-bbbb-cccc-dddddddddddd"], missingIdentifiers: [] }),
    "Fence integrity check failed for profile dip: 1 law record(s) changed: 12345678",
  );
  assert.equal(
    fenceIntegrityFailureSummary("dip", { ok: false, changedIds: [], missingIdentifiers: [] }),
    "Fence integrity check failed for profile dip: law snapshot digest changed",
  );
  assert.deepEqual(parseFenceIntegrityFailedSummary(fenceIntegrityFailureSummary("dip", CHANGED_TWO)), { profile: "dip", changed: 2 });
  assert.deepEqual(parseFenceIntegrityFailedSummary(fenceIntegrityFailureSummary("trading", LOST_TWO)), { profile: "trading", changed: 0 });
  assert.deepEqual(parseFenceIntegrityFailedSummary(fenceIntegrityFailureSummary("dip", BOTH)), { profile: "dip", changed: 1 });
  assert.deepEqual(parseFenceIntegrityFailedSummary(fenceIntegrityFailureSummary("dip", { ok: false, changedIds: [], missingIdentifiers: [] })), { profile: "dip", changed: 0 });
  assert.deepEqual(
    parseFenceIntegrityFailedSummary(fenceIntegrityFailureSummary("dip", { ok: false, changedIds: [], missingIdentifiers: ["https://secondshiftos.com/x"] })),
    { profile: "dip", changed: 0 },
    "an identifier carrying a colon still parses from the fixed head",
  );
  assert.equal(parseFenceIntegrityFailedSummary(""), null);
  assert.equal(parseFenceIntegrityFailedSummary("Fence integrity check failed for profile dip:"), null, "a line with no tail does not parse");
  assert.equal(parseFenceIntegrityFailedSummary("Fence integrity check failed for profile dip: "), null, "a line with a blank tail does not parse");
  assert.equal(parseFenceIntegrityFailedSummary("Fence integrity check failed for profile dip: identifier(s) lost: a, b, c, d, e"), null, "a lost list longer than the writer's 4-identifier slice does not parse");
  assert.equal(parseFenceIntegrityFailedSummary(sourceCitationFailureSummary("attach", new Error("boom"))), null, "a source-citation-failed line never parses as a fence-integrity-failed line");
});

test("fence integrity failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-fence-integrity-failed-history"), "sam-fence-integrity-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-fence-integrity-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "fence-integrity-failed-history"], "the argv rides observe fence-integrity-failed-history");
});
