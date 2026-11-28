import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTeamMember, findTeamMember, listTeamMembers, removeTeamMember, teamMemberBlocker } from "./team-runtime.js";

// The team member gate for the remove door: members are
// added by name, listed by name, routed and ledgered by
// name, and the sibling doors on the same add seam read
// their registries through fold-corrected ONE sources
// (teamRoleBlocker, teamToolBlocker), but `sam team member
// remove <name>` rode removeTeamMember alone - an exact
// name only, no description at all - so an unknown or
// folded name silently returned {removed:false}, naming
// nothing, and at the door that removes a standing member
// the owner could not tell a typo or a fold from a
// genuinely absent member. Members carry no separate id -
// the name IS the key - so this door's registry is the
// member names alone. The CLI remove door now resolves
// through findTeamMember (throwing teamMemberBlocker, the
// ONE source naming the registry with a fold correction,
// before anything is removed) and removes by the resolved
// name; removeTeamMember keeps its boolean contract
// (false on a miss) for internal callers - the store seam
// stays permissive by design.

function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-team-member-remove-gate-"));
  addTeamMember(root, { name: "ada", role: "builder", tools: [], maxCalls: 4 });
  addTeamMember(root, { name: "cy-b", role: "reviewer", tools: [], maxCalls: 4 });
  return root;
}

test("team member remove gate: an exact name reads no blocker and removes by the resolved name", () => {
  const root = fresh();
  try {
    assert.equal(teamMemberBlocker(root, "ada"), null);
    const resolved = findTeamMember(root, "ada");
    assert.equal(removeTeamMember(root, resolved.name), true);
    assert.deepEqual(listTeamMembers(root).map(m => m.name), ["cy-b"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team member remove gate: a folded name is refused with the correction and removes nothing", () => {
  const root = fresh();
  try {
    const blocker = teamMemberBlocker(root, "Cy B")!;
    assert.equal(
      blocker,
      "Team member not found: \"Cy B\". Team members: ada, cy-b. Did you mean \"cy-b\"?",
    );
    assert.throws(() => findTeamMember(root, "Cy B"), (e: unknown) => e instanceof Error && e.message === blocker);
    // The door throws before the store seam runs, so the
    // member is still registered afterwards.
    assert.deepEqual(listTeamMembers(root).map(m => m.name), ["ada", "cy-b"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team member remove gate: a separator-folded name corrects the same way", () => {
  const root = fresh();
  try {
    const blocker = teamMemberBlocker(root, "CY_B")!;
    assert.match(blocker, /Did you mean "cy-b"\?$/);
    assert.deepEqual(listTeamMembers(root).map(m => m.name), ["ada", "cy-b"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team member remove gate: an unknown name names the registry with no correction", () => {
  const root = fresh();
  try {
    const blocker = teamMemberBlocker(root, "ghost")!;
    assert.equal(blocker, "Team member not found: \"ghost\". Team members: ada, cy-b");
    assert.throws(() => findTeamMember(root, "ghost"));
    assert.equal(listTeamMembers(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team member remove gate: an empty registry names none registered", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-team-member-remove-gate-"));
  try {
    assert.equal(teamMemberBlocker(root, "ghost"), "Team member not found: \"ghost\". Team members: none registered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team member remove gate: an ambiguous fold offers no correction", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-team-member-remove-gate-"));
  try {
    addTeamMember(root, { name: "cy-b", role: "builder", tools: [], maxCalls: 4 });
    addTeamMember(root, { name: "cy.b", role: "reviewer", tools: [], maxCalls: 4 });
    const blocker = teamMemberBlocker(root, "CY B")!;
    assert.doesNotMatch(blocker, /Did you mean/);
    assert.equal(listTeamMembers(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team member remove gate: the store seam keeps its boolean contract", () => {
  const root = fresh();
  try {
    assert.equal(removeTeamMember(root, "nope"), false);
    assert.equal(removeTeamMember(root, "ada"), true);
    assert.equal(removeTeamMember(root, "ada"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
