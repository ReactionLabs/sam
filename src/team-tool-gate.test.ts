import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTeamMember, listTeamMembers, teamToolBlocker } from "./team-runtime.js";
import { profileToolNames } from "./subagents.js";

// The team-tool gate: a tool name is a registry name
// (profileToolNames, the own-tools registry) that a person
// types at the CLI `team member add --tools` door. The ONE
// seam every member allowlist rides, addTeamMember, refused
// an unknown tool with the bare "Unknown tool in allowlist:
// X" - the value echoed, but none of the registry named and
// no fold correction offered, so a folded name dead-ended.
// teamToolBlocker in team-runtime.ts is now the ONE source
// carrying the refusal text, thrown before any member,
// profile, or operative is created. Stored member tool
// lists are unchanged: read back as stored, never
// re-validated.

test("team tool gate: every exact tool, and an empty list, read no blocker", () => {
  const names = profileToolNames();
  assert.ok(names.length > 0);
  for (const name of names) assert.equal(teamToolBlocker([name]), null, name);
  assert.equal(teamToolBlocker(names), null);
  assert.equal(teamToolBlocker([]), null);
});

test("team tool gate: the folded registry has no collisions", () => {
  const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const names = profileToolNames();
  assert.equal(new Set(names.map(fold)).size, names.length);
});

test("team tool gate: an unknown tool echoes the value and names the registry, no correction", () => {
  const names = profileToolNames();
  const blocker = teamToolBlocker(["sam_teleport"])!;
  assert.ok(blocker.startsWith("Unknown tool in allowlist: sam_teleport. Tools: "), blocker);
  for (const name of names) assert.ok(blocker.includes(name), name);
  assert.doesNotMatch(blocker, /Did you mean/);
});

test("team tool gate: a folded name is refused with the correction", () => {
  assert.match(teamToolBlocker(["Sam-Memory-Search"])!, /Did you mean "sam_memory_search"\?$/);
  assert.match(teamToolBlocker(["SAM_MEMORY_SEARCH"])!, /Did you mean "sam_memory_search"\?$/);
  assert.match(teamToolBlocker(["sam memory search"])!, /Did you mean "sam_memory_search"\?$/);
  assert.match(teamToolBlocker(["sam-workspace-read"])!, /Did you mean "sam_workspace_read"\?$/);
});

test("team tool gate: several unknowns are all echoed, each folded one corrected", () => {
  const blocker = teamToolBlocker(["sam_teleport", "Sam-Reach", "sam_memory_list"])!;
  assert.ok(blocker.startsWith("Unknown tool in allowlist: sam_teleport, Sam-Reach. Tools: "), blocker);
  assert.match(blocker, /Did you mean "sam_reach"\?$/);
});

test("team tool gate: the addTeamMember seam refuses a folded tool before creating anything, and exact tools add", () => {
  const root = mkdtempSync(join(tmpdir(), "team-tool-gate-"));
  try {
    assert.throws(() => addTeamMember(root, { name: "ada", role: "builder", tools: ["Sam-Memory-Search"] }), /Did you mean "sam_memory_search"\?$/);
    assert.throws(() => addTeamMember(root, { name: "ada", role: "builder", tools: ["sam_teleport"] }), /^Error: Unknown tool in allowlist: sam_teleport\. Tools:/);
    assert.deepEqual(listTeamMembers(root), []);
    const member = addTeamMember(root, { name: "ada", role: "builder", tools: ["sam_memory_search"] });
    assert.deepEqual(member.tools, ["sam_memory_search"]);
    assert.equal(listTeamMembers(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
