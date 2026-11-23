import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillCatalogFailedSummary, skillCatalogFailedHistoryScorecardText, skillCatalogFailureSummary } from "./own-tools.js";
import { recordActivity } from "./activity.js";
import { skillUseFailureSummary } from "./skill-use.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The skill catalog failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the catalog
// assembly ledgers every failed discovery touch as a
// skill-catalog-failed line through the ONE writer
// skillCatalogFailureSummary (naming the actor whose catalog
// failed to assemble), ridden by recordSkillCatalogFailure -
// but the class was never folded, so how often a catalog
// assembly failed, and for how many distinct profiles, was
// invisible in aggregate. Every failure line is by
// construction a catalog assembly that did not complete, so
// the verdict is attention when any failure was ever recorded
// or any line is unparseable, else clear. The scorecard text
// is a script job's stdout and is P3-diffed on its facts, so
// it is ONE line carrying counts only: no stamp, no actor,
// and no verbatim reason - the summaries carry actors and
// reasons, and the fold consumes and never prints them. The
// scorecard path is a pure read - it creates nothing, sends
// nothing, and retries nothing; every state here is built
// through the ledger's own public door (recordActivity) with
// the seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-skill-catalog-failed-history-"));
}

const BARE = "Skill catalog failed history: clear, 0 failed, 0 distinct actors, 0 total";

test("skill catalog failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = skillCatalogFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = skillCatalogFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held skill catalog scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill catalog failed history scorecard: the writer's failures fold to counts with distinct actors as a number only, and no actor or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = skillCatalogFailedHistoryScorecardText(dir);
    recordActivity(dir, "dip", "skill-catalog-failed", skillCatalogFailureSummary("dip", "unable to open database file sekrit"));
    recordActivity(dir, "dip", "skill-catalog-failed", skillCatalogFailureSummary("dip", "disk full"));
    recordActivity(dir, "sam", "skill-catalog-failed", skillCatalogFailureSummary("second-shift", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = skillCatalogFailedHistoryScorecardText(dir);
    assert.equal(text, "Skill catalog failed history: attention, 3 failed, 2 distinct actors, 3 total");
    assert.equal(text.includes("second-shift"), false, "no actor name surfaces");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EPERM"), false, "no reason head surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill catalog failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = skillCatalogFailureSummary("dip", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseSkillCatalogFailedSummary(capped), { actor: "dip" });
    recordActivity(dir, "dip", "skill-catalog-failed", capped);
    const text = skillCatalogFailedHistoryScorecardText(dir);
    assert.equal(text, "Skill catalog failed history: attention, 1 failed, 1 distinct actors, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill catalog failed history scorecard: an unmatched shape, a sibling kind's shape, and an empty-reason shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "skill-catalog-failed", skillCatalogFailureSummary("dip", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "skill-catalog-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "skill-catalog-failed", skillUseFailureSummary("agent-reach", null, "boom sekrit"));
    recordActivity(dir, "sam", "skill-catalog-failed", "Skill catalog assemble failed for dip:   ");
    const text = skillCatalogFailedHistoryScorecardText(dir);
    assert.equal(text, "Skill catalog failed history: attention, 1 failed, 1 distinct actors, 4 total, 3 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill catalog failed parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(
    skillCatalogFailureSummary("dip", "EPERM: operation not permitted"),
    "Skill catalog assemble failed for dip: EPERM: operation not permitted",
  );
  assert.deepEqual(parseSkillCatalogFailedSummary(skillCatalogFailureSummary("dip", "boom")), { actor: "dip" });
  assert.equal(parseSkillCatalogFailedSummary(""), null);
  assert.equal(parseSkillCatalogFailedSummary("Skill catalog assemble failed for dip:"), null, "a line with no reason does not parse");
  assert.equal(parseSkillCatalogFailedSummary("Skill catalog assemble failed for dip: "), null, "a line with a blank reason does not parse");
  assert.equal(parseSkillCatalogFailedSummary("Skill catalog assemble failed for : boom"), null, "a line with no actor does not parse");
  assert.equal(parseSkillCatalogFailedSummary("Skill catalog assemble failed for dip smith: boom"), null, "an actor with a space does not parse as the writer's single-token actor followed by the fixed colon");
  assert.equal(parseSkillCatalogFailedSummary("Skill catalog build failed for dip: boom"), null, "a shape the seam never writes does not parse");
  assert.equal(parseSkillCatalogFailedSummary(skillUseFailureSummary("agent-reach", null, "boom")), null, "a skill-use-failed line never parses as a skill-catalog-failed line");
  assert.deepEqual(parseSkillCatalogFailedSummary("Skill catalog assemble failed for dip: boom: with colon"), { actor: "dip" }, "a reason carrying a colon still parses from the fixed head");
});

test("skill catalog failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-skill-catalog-failed-history"), "sam-skill-catalog-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-skill-catalog-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["skills", "catalog-failed-history"], "the argv rides skills catalog-failed-history");
});
