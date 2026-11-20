import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  artifactCreatedLedgerSummary,
  artifactFailureSummary,
  artifactScorecardText,
  artifactUpdatedLedgerSummary,
  parseArtifactCreatedSummary,
  parseArtifactFailedSummary,
  parseArtifactUpdatedSummary,
} from "./artifacts.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The artifact lifecycle daily-measurement wiring (2026-11-19,
// the measured-proof series): every artifact creation, every
// in-place revision, and every artifact store failure has
// ledgered as an artifact / artifact-failed line since the
// store landed - one line per event, in the fixed shapes the
// seams write, carrying the artifact's title (owner content),
// its kind and version, and an id prefix - but the classes were
// never folded, so how many deliverables SAM has created, how
// many were ever revised in place, and whether any artifact
// operation ever failed was invisible in aggregate. The verdict
// is attention only when an artifact operation failed or a
// line is unparseable: creates and updates are operator acts, a
// failed store operation is the news. The scorecard text is a
// script job's stdout and is P3-diffed on its facts, so it is
// ONE line carrying counts only: no stamp, no actor, no title,
// no kind, no version, no id - a fold that printed titles would
// leak owner content and change on every new deliverable even
// at an identical shape. The scorecard path is a pure read - it
// creates nothing, updates nothing, and reads no artifact
// content; every state here is built through the ledger's own
// public door (recordActivity) with the seams' own summary
// writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-artifact-scorecard-"));
}

const ID = "42c3a9f6-1111-2222-3333-444444444444";
const ID2 = "a1b2c3d4-5555-6666-7777-888888888888";

test("artifact scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = artifactScorecardText(dir);
    assert.equal(text, "Artifacts: clear, 0 created, 0 updated, 0 failed, 0 distinct artifacts, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = artifactScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held artifact scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("artifact scorecard: the lifecycle folds to counts and no title or id surfaces", () => {
  const dir = scratch();
  try {
    const clean = artifactScorecardText(dir);
    recordActivity(dir, "sam", "artifact", artifactCreatedLedgerSummary("Sekrit launch plan", "markdown", ID));
    recordActivity(dir, "sam", "artifact", artifactCreatedLedgerSummary("Second deliverable", "html", ID2));
    recordActivity(dir, "dip", "artifact", artifactUpdatedLedgerSummary("Sekrit launch plan", "markdown", 2, ID));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = artifactScorecardText(dir);
    assert.equal(text, "Artifacts: clear, 2 created, 1 updated, 0 failed, 2 distinct artifacts, 3 total");
    assert.equal(text.includes("Sekrit"), false, "no title surfaces");
    assert.equal(text.includes("42c3a9f6"), false, "no id surfaces");
    assert.equal(text.includes("markdown"), false, "no kind surfaces");
    assert.notEqual(text, clean, "the first artifact changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("artifact scorecard: a failed artifact operation is attention and its reason never surfaces", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "artifact", artifactCreatedLedgerSummary("Deliverable", "html", ID));
    recordActivity(dir, "sam", "artifact-failed", artifactFailureSummary("create", "sekrit disk path exploded"));
    const text = artifactScorecardText(dir);
    assert.equal(text, "Artifacts: attention, 1 created, 0 updated, 1 failed, 1 distinct artifacts, 2 total");
    assert.equal(text.includes("sekrit"), false, "no failure reason surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("artifact scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "artifact", artifactCreatedLedgerSummary("Deliverable", "html", ID));
    recordActivity(dir, "sam", "artifact", "Some wholly novel artifact shape mentioning sekrit titles");
    recordActivity(dir, "sam", "artifact-failed", "Artifact something odd happened");
    const text = artifactScorecardText(dir);
    assert.equal(text, "Artifacts: attention, 1 created, 0 updated, 0 failed, 1 distinct artifacts, 3 total, 2 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel artifact"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("artifact parse: the seams' own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    artifactCreatedLedgerSummary("Artifact test", "markdown", ID),
    "Created artifact 'Artifact test' (markdown, v1) 42c3a9f6",
  );
  assert.equal(
    artifactUpdatedLedgerSummary("Artifact test", "markdown", 3, ID),
    "Updated artifact 'Artifact test' (markdown, v3) 42c3a9f6",
  );
  assert.equal(artifactFailureSummary("create", "disk full"), "Artifact create failed: disk full");
  assert.deepEqual(parseArtifactCreatedSummary(artifactCreatedLedgerSummary("Artifact test", "markdown", ID)), { id: "42c3a9f6" });
  assert.deepEqual(parseArtifactUpdatedSummary(artifactUpdatedLedgerSummary("Artifact test", "markdown", 3, ID)), { id: "42c3a9f6", version: 3 });
  assert.deepEqual(parseArtifactFailedSummary(artifactFailureSummary("create", "disk full")), {});
  assert.equal(parseArtifactCreatedSummary(""), null);
  assert.equal(parseArtifactCreatedSummary("Created artifact 'X' (markdown, v1)"), null, "a truncated create line does not parse");
  assert.equal(parseArtifactCreatedSummary("Created artifact 'X' (pdf, v1) 42c3a9f6"), null, "a non-artifact kind does not parse");
  assert.equal(parseArtifactUpdatedSummary("Updated artifact 'X' (markdown, v1) 42c3a9f6"), null, "an update at v1 does not parse");
  assert.equal(parseArtifactFailedSummary("Artifact create failed:"), null, "a failure line with no reason does not parse");
  assert.equal(parseArtifactFailedSummary("Some wholly novel failure shape"), null);
});

test("artifact scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-artifacts"), "sam-artifacts is allowlisted");
  const argv = scriptArgv("/some/root", "sam-artifacts");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["artifacts", "scorecard"], "the argv rides artifacts scorecard");
});
