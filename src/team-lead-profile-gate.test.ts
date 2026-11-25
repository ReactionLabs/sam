import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { addTeamMember, listTeamRuns, runStandingTeam, teamLeadProfileBlocker } from "./team-runtime.js";

// The profile gate for the team run lead door: every
// profile-naming creation, queue, propose, and
// standing-instruction door reads the profile registry
// before writing anything - but CLI `team run --lead`
// passed the raw lead into runStandingTeam, which checks
// nothing about it. A shape-valid phantom lead created
// the run's chat bound to itself (ChatStore.create checks
// only the name shape), stored the run record under
// itself, and ledgered the assignment and result team
// messages from itself; a folded name ("Second Shift"
// for "second-shift") died obscurely on that shape check
// naming no correction. teamLeadProfileBlocker is now
// the ONE source carrying the refusal text: the CLI team
// run door throws it before running anything.
// runStandingTeam itself stays permissive by design (a
// profile removed after a run names it keeps its stored
// run and chat; the CLI is its only caller), so it is
// NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-team-lead-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

function addPair(root: string): void {
  addTeamMember(root, { name: "ada", role: "builder", model: "builder-model" });
  addTeamMember(root, { name: "cy", role: "reviewer", model: "reviewer-model" });
}

const complete = async ({ member }: { member: { role: string } }) =>
  member.role === "reviewer" ? "VERDICT: approve\nok" : "built";

test("team lead profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(teamLeadProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(teamLeadProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team lead profile gate: an unknown lead names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      teamLeadProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in team run lead. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      teamLeadProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in team run lead. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      teamLeadProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in team run lead. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team lead profile gate: the door's check runs nothing for a bogus lead", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    const blocker = teamLeadProfileBlocker(root, "Second Shift");
    assert.ok(blocker);
    // The door throws this text before calling
    // runStandingTeam; pin that the check alone leaves
    // no run behind.
    assert.deepEqual(listTeamRuns(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team lead profile gate: a registered lead passes the check and its run really runs under it", async () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    addPair(root);
    assert.equal(teamLeadProfileBlocker(root, "second-shift"), null);
    const run = await runStandingTeam(root, "Build the widget", { lead: "second-shift", complete });
    assert.equal(run.lead, "second-shift");
    assert.equal(run.status, "done");
    const db = new ChatStore(root);
    try { assert.equal(db.get(run.chatId!)?.agent_name, "second-shift"); } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("team lead profile gate: runStandingTeam stays permissive - a run may name a profile removed later", async () => {
  const root = fresh();
  try {
    addPair(root);
    const run = await runStandingTeam(root, "Build the widget", { lead: "trading", complete });
    assert.equal(run.lead, "trading");
    assert.equal(run.status, "done");
    assert.equal(listTeamRuns(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
