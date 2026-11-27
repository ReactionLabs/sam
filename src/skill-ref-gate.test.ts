import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSkillRefName, skillRefBlocker } from "./skill-registry.js";

// The skill-ref gate: a skill is picked by name out of a
// repo's own candidate registry - `skills install
// owner/repo@skill` (and the approval-gate skill path and
// scanSkillRef, riding the same fetchSkillCandidates seam)
// downloads the repo, parses every SKILL.md candidate, then
// selects by exact name or exact directory basename. A miss
// improvised the bare "Skill not found in owner/repo: X",
// naming no candidate and offering NO fold correction, so
// a folded name ("My-Skill", "my_skill", a folded
// directory name) dead-ended after the full download.
// skillRefBlocker in skill-registry.ts is now the ONE
// source carrying the refusal text; fetchSkillCandidates
// throws it before anything is installed or scanned. The
// registry is dynamic per repo, so a correction is offered
// only when exactly one candidate matches folded for case
// and separators on its name OR its directory basename
// (the selection's own two keys).

const CANDIDATES = [
  { name: "my-skill", dir: "skills/my-skill" },
  { name: "data-tools", dir: "tools/data" },
  { name: "root-skill", dir: "" },
];

test("skill ref gate: the fold strips case and separators", () => {
  assert.equal(normalizeSkillRefName("My-Skill"), "myskill");
  assert.equal(normalizeSkillRefName("my_skill"), "myskill");
  assert.equal(normalizeSkillRefName("MY SKILL"), "myskill");
  assert.equal(normalizeSkillRefName("data.tools"), "datatools");
});

test("skill ref gate: no skill part and exact picks read no blocker", () => {
  assert.equal(skillRefBlocker("owner/repo", undefined, CANDIDATES), null);
  assert.equal(skillRefBlocker("owner/repo", "my-skill", CANDIDATES), null);
  // Exact directory basename is a standing selection key.
  assert.equal(skillRefBlocker("owner/repo", "data", CANDIDATES), null);
  assert.equal(skillRefBlocker("owner/repo", "root-skill", CANDIDATES), null);
});

test("skill ref gate: an unknown skill names the registry, no correction", () => {
  assert.equal(
    skillRefBlocker("owner/repo", "ghost", CANDIDATES),
    "Skill not found in owner/repo: \"ghost\". Skills in owner/repo: my-skill, data-tools, root-skill",
  );
});

test("skill ref gate: on an empty repo every pick refuses naming none found", () => {
  assert.equal(
    skillRefBlocker("owner/repo", "ghost", []),
    "Skill not found in owner/repo: \"ghost\". Skills in owner/repo: none found",
  );
});

test("skill ref gate: a folded name is refused with the correction", () => {
  assert.match(skillRefBlocker("owner/repo", "My-Skill", CANDIDATES)!, /Did you mean "my-skill"\?$/);
  assert.match(skillRefBlocker("owner/repo", "my_skill", CANDIDATES)!, /Did you mean "my-skill"\?$/);
  assert.match(skillRefBlocker("owner/repo", "ROOT SKILL", CANDIDATES)!, /Did you mean "root-skill"\?$/);
});

test("skill ref gate: a folded directory basename corrects to its candidate", () => {
  // "Data" folds to the directory basename of data-tools, not to any name.
  assert.match(skillRefBlocker("owner/repo", "Data", CANDIDATES)!, /Did you mean "data-tools"\?$/);
});

test("skill ref gate: an ambiguous fold offers no correction", () => {
  const ambiguous = [
    { name: "my-skill", dir: "a/my-skill" },
    { name: "my_skill", dir: "b/my_skill" },
  ];
  const out = skillRefBlocker("owner/repo", "My Skill", ambiguous)!;
  assert.match(out, /Skills in owner\/repo: my-skill, my_skill$/);
  assert.doesNotMatch(out, /Did you mean/);
});
