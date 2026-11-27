import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardAgentBlocker, saveDashboardConfig } from "./dashboard.js";
import { readDashboardConfig } from "./dashboard-config.js";
import { ChatStore } from "./chats.js";

// The dashboard agent gate: the dashboard config's
// defaultAgent is a registry name (the agent registry:
// "sam" plus every registered agent) that a person picks
// at the dashboard's own config panel. The ONE seam every
// config save rides, saveDashboardConfig in dashboard.ts,
// refused a bad name in two improvised pieces - a name
// failing the shape regex died on the bare "Invalid
// dashboard configuration" (the same text covering extra
// keys and bad types, echoing no value, naming no agent),
// a well-shaped unknown name died on the bare "Unknown
// agent" - and the config POST handler swallowed both
// into a third generic text, so a folded name ("Dip",
// "Second Shift") dead-ended. dashboardAgentBlocker in
// dashboard.ts is now the ONE source carrying the
// refusal text; saveDashboardConfig throws it before any
// config is written. Stored config readers stay
// permissive by design (readDashboardConfig parses
// forgiving to the defaults).

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-dashboard-agent-gate-")); }

function seed(root: string): void {
  const db = new ChatStore(root);
  try {
    db.createAgent("dip", "Dip's own SAM.");
    db.createAgent("second-shift", "Second Shift agent.");
  } finally { db.close(); }
}

test("dashboard agent gate: every registered agent and sam read no blocker", () => {
  const root = fresh();
  try {
    seed(root);
    assert.equal(dashboardAgentBlocker(root, "sam"), null);
    assert.equal(dashboardAgentBlocker(root, "dip"), null);
    assert.equal(dashboardAgentBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dashboard agent gate: an unknown agent names the registry, no correction", () => {
  const root = fresh();
  try {
    seed(root);
    assert.equal(
      dashboardAgentBlocker(root, "ghost"),
      "Unknown agent \"ghost\" in dashboard configuration. Valid agents: sam, dip, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dashboard agent gate: a folded name is refused with the correction", () => {
  const root = fresh();
  try {
    seed(root);
    assert.match(dashboardAgentBlocker(root, "Dip")!, /Did you mean "dip"\?$/);
    assert.match(dashboardAgentBlocker(root, "Second Shift")!, /Did you mean "second-shift"\?$/);
    assert.match(dashboardAgentBlocker(root, "SECOND_SHIFT")!, /Did you mean "second-shift"\?$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dashboard agent gate: a non-string value refuses naming the registry, no correction", () => {
  const root = fresh();
  try {
    seed(root);
    assert.equal(dashboardAgentBlocker(root, 42), "Unknown agent \"42\" in dashboard configuration. Valid agents: sam, dip, second-shift");
    assert.equal(dashboardAgentBlocker(root, ""), "Unknown agent \"\" in dashboard configuration. Valid agents: sam, dip, second-shift");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dashboard agent gate: the save seam throws the ONE source and writes no config", () => {
  const root = fresh();
  try {
    seed(root);
    assert.throws(
      () => saveDashboardConfig(root, { defaultAgent: "Second Shift", showTeamEvents: true }),
      /Unknown agent "Second Shift" in dashboard configuration\. Valid agents: sam, dip, second-shift\. Did you mean "second-shift"\?$/,
    );
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.db")), false);
    assert.deepEqual(readDashboardConfig(root), { defaultAgent: "sam", showTeamEvents: true });
    assert.deepEqual(saveDashboardConfig(root, { defaultAgent: "second-shift", showTeamEvents: false }), { defaultAgent: "second-shift", showTeamEvents: false });
    assert.deepEqual(readDashboardConfig(root), { defaultAgent: "second-shift", showTeamEvents: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
