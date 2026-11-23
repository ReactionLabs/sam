import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactFailedHistoryScorecardText, artifactFailureSummary, parseArtifactFailedHistorySummary } from "./artifacts.js";
import { recordActivity } from "./activity.js";
import { draftFailureSummary } from "./drafts.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The artifact failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the artifact
// store's touches ledger every failure as an artifact-failed
// line through the ONE writer (artifactFailureSummary, fixed
// shape: "Artifact <phase> failed: <reason>", phases create /
// update / read, ridden by failArtifact from the store's
// create, update, and read doors, the actor the owning
// profile) - and while the lifecycle scorecard folds those
// lines into its failed count, it parses them loosely (any
// phase word) and never splits them, so which door of the
// store that holds SAM's durable deliverables failed was
// invisible in aggregate. Every failure line is by
// construction an artifact touch that did not complete its
// store work, so the verdict is attention when any failure
// was ever recorded or any line is unparseable, else clear.
// The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no reason, and no verbatim summary - the
// summaries carry reasons, and the fold consumes and never
// prints them, and no artifact title or content ever
// surfaces (a title is owner content and never enters the
// writer's line either). The scorecard path is a pure read -
// it creates nothing, updates nothing, and reads no artifact
// content; every state here is built through the ledger's
// own public door (recordActivity) with the seam's own
// summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-artifact-failed-history-"));
}

const BARE = "Artifact failed history: clear, 0 failed, 0 create, 0 update, 0 read, 0 total";

test("artifact failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = artifactFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = artifactFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held artifact scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("artifact failed history scorecard: the writer's failures fold to counts with the phase split, and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = artifactFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "artifact-failed", artifactFailureSummary("create", "EISDIR: illegal operation sekrit"));
    recordActivity(dir, "trading", "artifact-failed", artifactFailureSummary("read", "disk full"));
    recordActivity(dir, "trading", "artifact-failed", artifactFailureSummary("read", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "artifact-failed", artifactFailureSummary("update", "database is locked"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = artifactFailedHistoryScorecardText(dir);
    assert.equal(text, "Artifact failed history: attention, 4 failed, 1 create, 1 update, 2 read, 4 total");
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

test("artifact failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = artifactFailureSummary("create", "x".repeat(500));
    assert.equal(capped.length, 300, "the writer caps its line at 300");
    assert.deepEqual(parseArtifactFailedHistorySummary(capped), { phase: "create" });
    recordActivity(dir, "sam", "artifact-failed", capped);
    recordActivity(dir, "sam", "artifact-failed", artifactFailureSummary("read", "boom"));
    const text = artifactFailedHistoryScorecardText(dir);
    assert.equal(text, "Artifact failed history: attention, 2 failed, 1 create, 0 update, 1 read, 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("artifact failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and an unknown-phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "artifact-failed", artifactFailureSummary("read", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "artifact-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "artifact-failed", draftFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "artifact-failed", "Artifact read failed:   ");
    recordActivity(dir, "sam", "artifact-failed", "Artifact delete failed: boom");
    const text = artifactFailedHistoryScorecardText(dir);
    assert.equal(text, "Artifact failed history: attention, 1 failed, 0 create, 0 update, 1 read, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("artifact failed history parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(artifactFailureSummary("create", "database is locked"), "Artifact create failed: database is locked");
  assert.equal(artifactFailureSummary("read", "disk gone"), "Artifact read failed: disk gone");
  assert.deepEqual(parseArtifactFailedHistorySummary(artifactFailureSummary("create", "boom")), { phase: "create" });
  assert.deepEqual(parseArtifactFailedHistorySummary(artifactFailureSummary("update", "boom")), { phase: "update" });
  assert.deepEqual(parseArtifactFailedHistorySummary(artifactFailureSummary("read", "boom")), { phase: "read" });
  assert.equal(parseArtifactFailedHistorySummary(""), null);
  assert.equal(parseArtifactFailedHistorySummary("Artifact read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseArtifactFailedHistorySummary("Artifact read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseArtifactFailedHistorySummary("Artifact delete failed: boom"), null, "a phase the store never writes does not parse");
  assert.equal(parseArtifactFailedHistorySummary("Created artifact 'Weekly report' (html, v1) abcdef01"), null, "an artifact success line never parses as an artifact-failed line");
  assert.equal(parseArtifactFailedHistorySummary(draftFailureSummary("read", "boom")), null, "a draft-failed line never parses as an artifact-failed line");
  assert.deepEqual(parseArtifactFailedHistorySummary("Artifact read failed: boom: with colon"), { phase: "read" }, "a reason carrying a colon still parses from the fixed head");
});

test("artifact failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-artifact-failed-history"), "sam-artifact-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-artifact-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["artifacts", "failed-history"], "the argv rides artifacts failed-history");
});
