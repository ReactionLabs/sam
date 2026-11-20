import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  parseSkillInstallSummary,
  skillInstallScorecardText,
  skillInstalledLedgerSummary,
  skillRemovedLedgerSummary,
} from "./skill-registry.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The skill install daily-measurement wiring (2026-11-20,
// the measured-proof series): every registry install and
// removal has ledgered as a skill line since the registry
// landed - one line per act, in the fixed shapes the two
// seams write, carrying the skill's name, its source repo,
// and (on an install) the files written - but the class was
// never folded, so how the library actually grew and
// whether anything was ever removed was invisible in
// aggregate (skill use is measured, and failed installs
// fold into the action-failure class; the installs
// themselves did not). Installing and removing skills is
// the gated workflow, so the verdict is attention only when
// a line is unparseable. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no skill
// name, no source - the summary carries the name and the
// source repo, which the fold counts and never prints. The
// scorecard path is a pure read - it creates nothing and
// installs nothing; every state here is built through the
// ledger's own public door (recordActivity) with the
// seams' own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-skill-install-scorecard-"));
}

test("skill install scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = skillInstallScorecardText(dir);
    assert.equal(text, "Skill installs: clear, 0 installed, 0 removed, 0 files written, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = skillInstallScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held skill install scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill install scorecard: the class folds to counts with files summed, and no name or source surfaces", () => {
  const dir = scratch();
  try {
    const clean = skillInstallScorecardText(dir);
    recordActivity(dir, "sam", "skill", skillInstalledLedgerSummary("sekrit-skill", "sekrit-owner/sekrit-repo", 4));
    recordActivity(dir, "sam", "skill", skillInstalledLedgerSummary("another-skill", "other-owner/other-repo", 1));
    recordActivity(dir, "operator", "skill", skillRemovedLedgerSummary("another-skill", "other-owner/other-repo"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = skillInstallScorecardText(dir);
    assert.equal(text, "Skill installs: clear, 2 installed, 1 removed, 5 files written, 3 total");
    assert.equal(text.includes("sekrit-skill"), false, "no skill name surfaces");
    assert.equal(text.includes("sekrit-owner"), false, "no source surfaces");
    assert.equal(text.includes("another-skill"), false, "no removed skill name surfaces");
    assert.notEqual(text, clean, "the first recorded install changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill install scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "skill", skillInstalledLedgerSummary("sekrit-skill", "sekrit-owner/sekrit-repo", 2));
    recordActivity(dir, "sam", "skill", "Some wholly novel skill shape mentioning sekrit-skill");
    const text = skillInstallScorecardText(dir);
    assert.equal(text, "Skill installs: attention, 1 installed, 0 removed, 2 files written, 2 total, 1 unparseable");
    assert.equal(text.includes("novel skill"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit-skill"), false, "no skill name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill install parse: the seams' own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    skillInstalledLedgerSummary("webclaw", "0xmassi/webclaw-skill", 1),
    "Installed skill webclaw from 0xmassi/webclaw-skill (1 files)",
  );
  assert.equal(
    skillRemovedLedgerSummary("webclaw", "0xmassi/webclaw-skill"),
    "Removed skill webclaw (was from 0xmassi/webclaw-skill)",
  );
  assert.deepEqual(parseSkillInstallSummary(skillInstalledLedgerSummary("webclaw", "0xmassi/webclaw-skill", 4)), { action: "installed", files: 4 });
  assert.deepEqual(parseSkillInstallSummary(skillRemovedLedgerSummary("webclaw", "0xmassi/webclaw-skill")), { action: "removed" });
  assert.equal(parseSkillInstallSummary(""), null);
  assert.equal(parseSkillInstallSummary("Installed skill webclaw from 0xmassi/webclaw-skill (1 file)"), null, "the seam always renders the plural files");
  assert.equal(parseSkillInstallSummary("Installed skill webclaw from 0xmassi/webclaw-skill (many files)"), null, "a non-numeric file count does not parse");
  assert.equal(parseSkillInstallSummary("Installed skill webclaw (4 files)"), null, "an install line with no source does not parse");
  assert.equal(parseSkillInstallSummary("Removed skill webclaw"), null, "a removal line with no source does not parse");
  assert.equal(parseSkillInstallSummary("Removed skill webclaw (was from )"), null, "a removal line with an empty source does not parse");
});

test("skill install scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-skill-installs"), "sam-skill-installs is allowlisted");
  const argv = scriptArgv("/some/root", "sam-skill-installs");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["skills", "install-scorecard"], "the argv rides skills install-scorecard");
});
