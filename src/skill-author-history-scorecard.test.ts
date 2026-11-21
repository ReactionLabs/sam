import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseSkillAuthoredSummary, parseSkillCuratorSummary, parseSkillGatedSummary, parseSkillPatchedSummary, skillAuthorHistoryScorecardText, skillCuratorLedgerSummary, skillGatedLedgerSummary, skillWrittenLedgerSummary, type CuratorFinding } from "./skill-author.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The skill author history daily-measurement wiring (2026-11-21,
// the measured-proof series): every act of the skill authoring
// lifecycle has ledgered as a skill-gated / skill-authored /
// skill-patched / skill-curator line since Phase B item 3 -
// all four as inline concatenation with no ONE writer and no
// fold, so how many drafts were ever gated, how many skills
// SAM ever authored or patched, across how many distinct
// skills, and how much curator flagging ever happened was
// invisible in aggregate (authoredSkills reads only the
// provenance store; curatorFindings reads only the last
// pass's finding set). This family has no failure class of
// its own, so the verdict is attention only when a line is
// unparseable. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, no skill name, no
// description - the summaries carry skill names and draft
// descriptions, which the fold consumes and never prints.
// The scorecard path is a pure read - it creates nothing,
// gates nothing, writes nothing, and runs no curator pass;
// every state here is built through the ledger's own public
// door (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-skill-author-history-"));
}

const BARE = "Skill author history: clear, 0 gated, 0 drafts, 0 gated patches, 0 authored, 0 patched, 0 distinct skills, 0 curator passes, 0 findings flagged, 0 duplicate-content, 0 duplicate-description, 0 shadowed, 0 orphaned-provenance, 0 unmatchable-description, 0 unused-skill, 0 stale-skill, 0 total";

test("skill author history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = skillAuthorHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = skillAuthorHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held skill author scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill author history scorecard: the gated and written acts fold to counts and distinct skills, and no name or description surfaces", () => {
  const dir = scratch();
  try {
    const clean = skillAuthorHistoryScorecardText(dir);
    recordActivity(dir, "sam", "skill-gated", skillGatedLedgerSummary(false, { name: "sekrit-alpha", description: "sekrit draft purpose", instructions: "x" }));
    recordActivity(dir, "trading", "skill-gated", skillGatedLedgerSummary(true, { name: "sekrit-beta", description: "sekrit patch purpose", instructions: "x" }));
    recordActivity(dir, "sam", "skill-authored", skillWrittenLedgerSummary(false, { name: "sekrit-alpha", description: "sekrit draft purpose", instructions: "x" }, 1));
    recordActivity(dir, "operator", "skill-patched", skillWrittenLedgerSummary(true, { name: "sekrit-beta", description: "sekrit patch purpose", instructions: "x" }, 2));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = skillAuthorHistoryScorecardText(dir);
    assert.equal(text, "Skill author history: clear, 2 gated, 1 drafts, 1 gated patches, 1 authored, 1 patched, 2 distinct skills, 0 curator passes, 0 findings flagged, 0 duplicate-content, 0 duplicate-description, 0 shadowed, 0 orphaned-provenance, 0 unmatchable-description, 0 unused-skill, 0 stale-skill, 4 total");
    assert.equal(text.includes("sekrit"), false, "no skill name or description surfaces");
    assert.notEqual(text, clean, "the first recorded authoring act changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill author history scorecard: curator passes fold with declared findings and per-kind counts, and no skill name surfaces", () => {
  const dir = scratch();
  try {
    const finding = (kind: CuratorFinding["kind"], skills: string[]): CuratorFinding => ({ id: "f-" + kind, kind, skills, detail: "sekrit detail", suggestedPatch: "sekrit patch" });
    recordActivity(dir, "sam", "skill-curator", skillCuratorLedgerSummary([finding("duplicate-content", ["sekrit-alpha", "sekrit-beta"]), finding("stale-skill", ["sekrit-gamma"])]));
    recordActivity(dir, "sam", "skill-curator", skillCuratorLedgerSummary([finding("duplicate-content", ["sekrit-delta", "sekrit-epsilon"])]));
    const text = skillAuthorHistoryScorecardText(dir);
    assert.equal(text, "Skill author history: clear, 0 gated, 0 drafts, 0 gated patches, 0 authored, 0 patched, 0 distinct skills, 2 curator passes, 3 findings flagged, 2 duplicate-content, 0 duplicate-description, 0 shadowed, 0 orphaned-provenance, 0 unmatchable-description, 0 unused-skill, 1 stale-skill, 2 total");
    assert.equal(text.includes("sekrit"), false, "no skill name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill author history scorecard: a curator line truncated by its own writer's slice still parses on its declared count", () => {
  const dir = scratch();
  try {
    const findings: CuratorFinding[] = [];
    for (let i = 0; i < 6; i += 1) {
      findings.push({ id: "f" + i, kind: "duplicate-description", skills: ["sekrit-skill-name-number-one-" + i, "sekrit-skill-name-number-two-" + i], detail: "d", suggestedPatch: "p" });
    }
    const summary = skillCuratorLedgerSummary(findings);
    assert.ok(summary.length > 300, "the writer's slice bounds the findings body, not the header");
    const parsed = parseSkillCuratorSummary(summary);
    assert.ok(parsed, "the truncated line parses");
    assert.equal(parsed.declared, 6, "the header count survives the slice");
    recordActivity(dir, "sam", "skill-curator", summary);
    const text = skillAuthorHistoryScorecardText(dir);
    assert.ok(text.startsWith("Skill author history: clear,"), "a truncated line is not a parse failure");
    assert.ok(text.includes("1 curator passes"), "the pass counts");
    assert.ok(text.includes("6 findings flagged"), "the declared findings count");
    assert.equal(text.includes("sekrit"), false, "no skill name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill author history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "skill-authored", skillWrittenLedgerSummary(false, { name: "alpha", description: "a real purpose", instructions: "x" }, 1));
    recordActivity(dir, "sam", "skill-gated", "Some wholly novel gating shape naming sekrit_evidence");
    recordActivity(dir, "sam", "skill-curator", "Skill curator flagged 1 issue(s): bogus-kind (sekrit-alpha)");
    const text = skillAuthorHistoryScorecardText(dir);
    assert.equal(text, "Skill author history: attention, 0 gated, 0 drafts, 0 gated patches, 1 authored, 0 patched, 1 distinct skills, 0 curator passes, 0 findings flagged, 0 duplicate-content, 0 duplicate-description, 0 shadowed, 0 orphaned-provenance, 0 unmatchable-description, 0 unused-skill, 0 stale-skill, 3 total, 2 unparseable");
    assert.equal(text.includes("novel gating"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill author parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  const draft = { name: "alpha", description: "A helpful purpose", instructions: "steps" };
  assert.equal(skillGatedLedgerSummary(false, draft), "Skill draft routed to owner approval: alpha - A helpful purpose");
  assert.equal(skillGatedLedgerSummary(true, draft), "Skill patch routed to owner approval: alpha - A helpful purpose");
  assert.equal(skillWrittenLedgerSummary(false, draft, 1), "Authored skill alpha (v1): A helpful purpose");
  assert.equal(skillWrittenLedgerSummary(true, draft, 3), "Patched skill alpha (v3): A helpful purpose");
  const finding: CuratorFinding = { id: "f1", kind: "shadowed", skills: ["alpha", "beta"], detail: "d", suggestedPatch: "p" };
  assert.equal(skillCuratorLedgerSummary([finding]), "Skill curator flagged 1 issue(s): shadowed (alpha, beta)");
  assert.deepEqual(parseSkillGatedSummary(skillGatedLedgerSummary(false, draft)), { patch: false, name: "alpha" });
  assert.deepEqual(parseSkillGatedSummary(skillGatedLedgerSummary(true, draft)), { patch: true, name: "alpha" });
  assert.deepEqual(parseSkillAuthoredSummary(skillWrittenLedgerSummary(false, draft, 1)), { name: "alpha", version: 1 });
  assert.deepEqual(parseSkillPatchedSummary(skillWrittenLedgerSummary(true, draft, 3)), { name: "alpha", version: 3 });
  assert.deepEqual(parseSkillCuratorSummary(skillCuratorLedgerSummary([finding])), { declared: 1, kinds: { shadowed: 1 } });
  assert.equal(parseSkillGatedSummary(""), null);
  assert.equal(parseSkillGatedSummary("Skill draft routed to owner approval: Bad Name - purpose"), null, "a name outside the skill name shape does not parse");
  assert.equal(parseSkillGatedSummary("Skill draft routed to owner approval: alpha - "), null, "a gated line with no description does not parse");
  assert.equal(parseSkillAuthoredSummary("Authored skill alpha: A helpful purpose"), null, "a written line with no version does not parse");
  assert.equal(parseSkillPatchedSummary("Authored skill alpha (v1): A helpful purpose"), null, "the authored shape does not parse as a patch");
  assert.equal(parseSkillCuratorSummary("Skill curator flagged 0 issue(s): "), null, "a zero-finding line the writer never emits does not parse");
  assert.equal(parseSkillCuratorSummary("Skill curator flagged 1 issue(s): bogus-kind (alpha)"), null, "a finding kind outside the fixed vocabulary does not parse");
  assert.equal(parseSkillCuratorSummary("Skill curator flagged two issue(s): shadowed (alpha)"), null, "a non-numeric count does not parse");
});

test("skill author history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-skill-history"), "sam-skill-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-skill-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["skills", "history"], "the argv rides skills history");
});
