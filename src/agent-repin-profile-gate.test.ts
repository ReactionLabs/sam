import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { agentRepinProfileBlocker } from "./agent-repins.js";

// The profile gate for the agent re-pin doors: every
// profile-naming door reads the profile registry through a
// ONE source in its owning module carrying the refusal text
// with a fold correction - but the CLI agents set-model /
// set-provider / set-connector / set-instructions doors
// discovered an unknown profile only after their setter
// returned null and refused with their own "Known profiles"
// wording and no correction. agentRepinProfileBlocker in
// agent-repins.ts is now the ONE source carrying the
// refusal text, and all four CLI re-pin doors throw it
// before re-pinning anything (the "sam" core refusal stays
// after it, since "sam" passes this blocker). The ChatStore
// setters stay permissive by design and are NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-agent-repin-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("agent re-pin profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(agentRepinProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(agentRepinProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agent re-pin profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      agentRepinProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in agent re-pin detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      agentRepinProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in agent re-pin detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      agentRepinProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in agent re-pin detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agent re-pin profile gate: an ambiguous fold names no correction", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    register(root, "second_shift");
    assert.equal(
      agentRepinProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in agent re-pin detail. Valid profiles: sam, second-shift, second_shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agent re-pin profile gate: the store setters stay permissive - an unknown name returns null and changes nothing", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    const db = new ChatStore(root);
    try {
      assert.equal(db.setAgentModel("Second Shift", "some-model"), null);
      assert.equal(db.setAgentInstructions("nosuchprofile", "x"), null);
      assert.equal(db.agents().find(a => a.name === "second-shift")?.model ?? null, null);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agent re-pin profile gate: a registered profile still re-pins through the store after passing the blocker", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(agentRepinProfileBlocker(root, "second-shift"), null);
    const db = new ChatStore(root);
    try {
      const updated = db.setAgentModel("second-shift", "some-model");
      assert.equal(updated?.model, "some-model");
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
