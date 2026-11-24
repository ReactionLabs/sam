import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillScanHoldSummary, skillScanHoldHistoryScorecardText, skillScanHoldLedgerSummary } from "./actions.js";
import { recordActivity } from "./activity.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The skill scan hold history daily-measurement wiring
// (2026-11-24, the measured-proof series): the ONE gate
// ledgers every held auto-install as a "skill-scan-hold"
// line through the ONE writer (skillScanHoldLedgerSummary,
// fixed shape "<kind>: <title> - flagged skill content:
// <name> [<hit ids>]; ..." over the scan's fixed five-class
// vocabulary) - and while the held card sits in the gate
// folds as an ordinary pending card, no surface folds this
// kind: how often the content scan caught a flagged skill an
// approval mode would otherwise have installed silently was
// invisible in aggregate. Every hold line is by construction
// a flagged skill the scan stopped, so the verdict is
// attention when any hold was ever recorded or any line is
// unparseable, else clear. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no title,
// no skill name, and no verbatim summary. The scorecard path
// is a pure read - it creates nothing, spends no model call,
// and installs nothing; every state here is built through
// the ledger's own public door (recordActivity) with the
// seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-skill-scan-hold-history-"));
}

const SCAN_ONE = "flagged skill content: delta-skill [ignore-instructions, pipe-to-shell]";
const SCAN_TWO = "flagged skill content: delta-skill [ignore-instructions]; echo-skill [exfiltrate-credentials]";

const BARE = "Skill scan hold history: clear, 0 held, 0 distinct skills, hits none, kinds none, 0 total";

test("skill scan hold history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = skillScanHoldHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = skillScanHoldHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held skill scan hold scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill scan hold history scorecard: the writer's holds fold to counts with the distinct-skill count, and no title or skill name surfaces", () => {
  const dir = scratch();
  try {
    const clean = skillScanHoldHistoryScorecardText(dir);
    recordActivity(dir, "sam", "skill-scan-hold", skillScanHoldLedgerSummary("skill", "Install delta-skill", SCAN_ONE));
    recordActivity(dir, "sam", "skill-scan-hold", skillScanHoldLedgerSummary("skill", "Install two skills", SCAN_TWO));
    recordActivity(dir, "sam", "never-list", "Refused a skill proposal (pipe-to-root-shell): sekrit title");
    const text = skillScanHoldHistoryScorecardText(dir);
    assert.equal(text, "Skill scan hold history: attention, 2 held, 2 distinct skills, hits ignore-instructions 2 / exfiltrate-credentials 1 / pipe-to-shell 1, kinds skill 2, 2 total");
    assert.equal(text.includes("delta-skill"), false, "no skill name surfaces");
    assert.equal(text.includes("Install"), false, "no title surfaces");
    assert.notEqual(text, clean, "the first recorded hold changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill scan hold history scorecard: an unmatched shape, a cross-kind shape, an out-of-vocabulary hit, and a hitless entry count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "skill-scan-hold", skillScanHoldLedgerSummary("skill", "Install delta-skill", SCAN_ONE));
    recordActivity(dir, "sam", "skill-scan-hold", "Some wholly novel ledger shape naming sekrit_skill");
    recordActivity(dir, "sam", "skill-scan-hold", "Refused a skill proposal (pipe-to-root-shell): a never-list line");
    recordActivity(dir, "sam", "skill-scan-hold", "skill: Install x - flagged skill content: x-skill [made-up-hit]");
    recordActivity(dir, "sam", "skill-scan-hold", "skill: Install x - flagged skill content: x-skill []");
    const text = skillScanHoldHistoryScorecardText(dir);
    assert.equal(text, "Skill scan hold history: attention, 1 held, 1 distinct skills, hits ignore-instructions 1 / pipe-to-shell 1, kinds skill 1, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("made-up-hit"), false, "an out-of-vocabulary hit is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill scan hold history parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(
    skillScanHoldLedgerSummary("skill", "Install delta-skill", SCAN_ONE),
    "skill: Install delta-skill - flagged skill content: delta-skill [ignore-instructions, pipe-to-shell]",
  );
  assert.deepEqual(parseSkillScanHoldSummary(skillScanHoldLedgerSummary("skill", "Install delta-skill", SCAN_ONE)), { kind: "skill", skills: ["delta-skill"], hits: ["ignore-instructions", "pipe-to-shell"] });
  assert.deepEqual(parseSkillScanHoldSummary(skillScanHoldLedgerSummary("skill-author", "Author two", SCAN_TWO)), { kind: "skill-author", skills: ["delta-skill", "echo-skill"], hits: ["ignore-instructions", "exfiltrate-credentials"] });
  assert.deepEqual(parseSkillScanHoldSummary("mystery: T - flagged skill content: a-skill [override-gate]"), { kind: "other", skills: ["a-skill"], hits: ["override-gate"] });
  assert.equal(parseSkillScanHoldSummary(""), null);
  assert.equal(parseSkillScanHoldSummary("skill: Install delta-skill - flagged skill content: delta-skill [ignore-instructions"), null, "a line missing the closing bracket does not parse");
  assert.equal(parseSkillScanHoldSummary("skill: Install delta-skill - some other scan wording: delta-skill [ignore-instructions]"), null, "a line without the fixed scan head does not parse");
  assert.equal(parseSkillScanHoldSummary("skill: Install delta-skill - flagged skill content: delta-skill [made-up-hit]"), null, "a hit id outside the scan vocabulary does not parse");
  assert.equal(parseSkillScanHoldSummary("Refused a skill proposal (pipe-to-root-shell): a never-list line"), null, "a never-list line never parses as a skill-scan-hold line");
});

test("skill scan hold history scorecard: repeat holds of one skill raise the held count only, and a held state re-reads identically", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "skill-scan-hold", skillScanHoldLedgerSummary("skill", "Install delta-skill", SCAN_ONE));
    recordActivity(dir, "sam", "skill-scan-hold", skillScanHoldLedgerSummary("skill", "Install delta-skill again", SCAN_ONE));
    recordActivity(dir, "sam", "skill-scan-hold", skillScanHoldLedgerSummary("skill", "Install delta-skill once more", SCAN_ONE));
    const text = skillScanHoldHistoryScorecardText(dir);
    assert.equal(text, "Skill scan hold history: attention, 3 held, 1 distinct skills, hits ignore-instructions 3 / pipe-to-shell 3, kinds skill 3, 3 total");
    assert.equal(skillScanHoldHistoryScorecardText(dir), text, "a held state re-reads identically");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill scan hold history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-skill-scan-hold-history"), "sam-skill-scan-hold-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-skill-scan-hold-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["actions", "scan-hold-history"], "the argv rides actions scan-hold-history");
});
