import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTeamMember, listTeamMembers, teamRoleBlocker, TEAM_ROLES } from "./team-runtime.js";

// The team-role gate: the role is a registry name
// (TEAM_ROLES in team-runtime.ts: builder, researcher,
// qa, reviewer) that a person types at the CLI
// `team member add` door. The ONE seam every role rides,
// addTeamMember, refused an unknown role with "Role must
// be one of: ..." - the roles named, but the bad value
// never echoed and no fold correction offered, so a
// folded name dead-ended. teamRoleBlocker in
// team-runtime.ts is now the ONE source carrying the
// refusal text, thrown before any member, profile, or
// operative is created. Stored member roles are unchanged:
// read back as stored, never re-validated.

test("team role gate: every exact role reads no blocker", () => {
  for (const role of TEAM_ROLES) assert.equal(teamRoleBlocker(role), null, role);
  assert.equal(TEAM_ROLES.length, 4);
});

test("team role gate: an unknown role echoes the value and names the roles, no correction", () => {
  assert.equal(
    teamRoleBlocker("manager"),
    "Unknown team role \"manager\". Role must be one of: builder, researcher, qa, reviewer",
  );
});

test("team role gate: a folded name is refused with the correction", () => {
  assert.match(teamRoleBlocker("Builder")!, /Did you mean "builder"\?$/);
  assert.match(teamRoleBlocker("QA")!, /Did you mean "qa"\?$/);
  assert.match(teamRoleBlocker("Re-viewer")!, /Did you mean "reviewer"\?$/);
  assert.match(teamRoleBlocker("research_er")!, /Did you mean "researcher"\?$/);
});

test("team role gate: a non-string or empty value refuses naming the roles, no correction", () => {
  assert.match(teamRoleBlocker(42)!, /^Unknown team role "42"\. Role must be one of:/);
  assert.doesNotMatch(teamRoleBlocker(42)!, /Did you mean/);
  assert.match(teamRoleBlocker("")!, /^Unknown team role ""\. Role must be one of:/);
  assert.doesNotMatch(teamRoleBlocker("")!, /Did you mean/);
});

test("team role gate: the addTeamMember seam refuses a folded role before creating anything, and an exact role adds", () => {
  const root = mkdtempSync(join(tmpdir(), "team-role-gate-"));
  try {
    assert.throws(() => addTeamMember(root, { name: "ada", role: "Builder" }), /Did you mean "builder"\?$/);
    assert.throws(() => addTeamMember(root, { name: "ada", role: "manager" }), /^Error: Unknown team role "manager"\. Role must be one of:/);
    assert.deepEqual(listTeamMembers(root), []);
    const member = addTeamMember(root, { name: "ada", role: "builder" });
    assert.equal(member.role, "builder");
    assert.equal(listTeamMembers(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
