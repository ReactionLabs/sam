import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { listSubagents, spawnSubagent, subagentProfileBlocker, type SubagentCompleter } from "./subagents.js";

// The profile gate for the subagent spawn door: every
// profile-naming creation door and the background, coding,
// engine, and parallel queue doors read the profile registry
// before creating anything, but CLI `subagent spawn
// --profile` passed the raw profile into spawnSubagent,
// which checks only the name's shape - minting a running
// helper bound to nobody: the record sits in the registry
// under a profile that is no profile, its subagent-spawn
// ledger line carries that same phantom actor, and the
// child resolves no registered profile. subagentProfileBlocker
// is now the ONE source carrying the refusal text: the spawn
// door throws it before spawning anything. spawnSubagent
// itself stays permissive by design (a profile removed after
// a helper names it leaves the record with its stored
// profile, the sam_spawn_subagent chat tool names its
// profile by construction - the speaking chat's own
// profile - and the orchestration lane runner carries its
// job's stored profile), so it is NOT gated here.

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-subagent-profile-gate-")); }
const text = (content: string): SubagentCompleter => async () => ({ content, calls: [] });

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("subagent profile gate: sam and a registered profile read no blocker", () => {
  const root = scratch();
  try {
    assert.equal(subagentProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(subagentProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subagent profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = scratch();
  try {
    assert.equal(
      subagentProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in subagent detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      subagentProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in subagent detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      subagentProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in subagent detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subagent profile gate: the door's check spawns nothing for a bogus profile", () => {
  const root = scratch();
  try {
    const blocker = subagentProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    // The door throws this text before calling
    // spawnSubagent; pin that the check alone leaves
    // no helper behind.
    assert.equal(listSubagents(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subagent profile gate: a registered profile passes the check and the helper spawns bound to it", async () => {
  const root = scratch();
  try {
    register(root, "second-shift");
    assert.equal(subagentProfileBlocker(root, "second-shift"), null);
    const child = await spawnSubagent(root, { profile: "second-shift", prompt: "Summarize the inbox", tools: ["sam_memory_list"], rounds: 1, maxCalls: 1 }, { complete: text("Done") });
    assert.equal(child.profile, "second-shift");
    assert.equal(child.status, "done");
    assert.equal(listSubagents(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subagent profile gate: spawnSubagent stays permissive - a helper may name a profile removed later", async () => {
  const root = scratch();
  try {
    const child = await spawnSubagent(root, { profile: "trading", prompt: "Summarize the inbox", tools: ["sam_memory_list"], rounds: 1, maxCalls: 1 }, { complete: text("Done") });
    assert.equal(child.profile, "trading");
    assert.equal(listSubagents(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
