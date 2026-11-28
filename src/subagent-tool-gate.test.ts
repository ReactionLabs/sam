import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSubagent, listSubagents, profileToolNames, subagentToolBlocker, type SubagentCompleter } from "./subagents.js";

// The subagent-tool gate: a tool name is a registry name
// (the parent's tools - profileToolNames with no parent,
// the parent sub-agent's own list with one) that a person
// types at the CLI `subagent spawn --tools` door (and the
// hiring turn names at the sam_spawn_subagent door, both
// riding narrowTools). That seam refused any name outside
// the inherited set with the bare "Tool allowlist cannot
// widen past the parent: X" - none of the parent's tools
// named and no fold correction offered, so a folded name
// dead-ended. subagentToolBlocker in subagents.ts is now
// the ONE source carrying the refusal text (the standing
// prefix kept), thrown before anything spawns; a
// correction is offered only within the parent set, so it
// can never itself widen. Stored sub-agent tool lists are
// unchanged: read back as stored, never re-validated.

const text = (content: string): SubagentCompleter => async () => ({ content, calls: [] });

test("subagent tool gate: every exact tool, and an empty list, read no blocker", () => {
  const names = profileToolNames();
  assert.ok(names.length > 0);
  for (const name of names) assert.equal(subagentToolBlocker([name]), null, name);
  assert.equal(subagentToolBlocker(names), null);
  assert.equal(subagentToolBlocker([]), null);
});

test("subagent tool gate: the folded registry has no collisions", () => {
  const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const names = profileToolNames();
  assert.equal(new Set(names.map(fold)).size, names.length);
});

test("subagent tool gate: an unknown tool echoes the value and names the registry, no correction", () => {
  const names = profileToolNames();
  const blocker = subagentToolBlocker(["sam_teleport"])!;
  assert.ok(blocker.startsWith("Tool allowlist cannot widen past the parent: sam_teleport. Parent tools: "), blocker);
  for (const name of names) assert.ok(blocker.includes(name), name);
  assert.doesNotMatch(blocker, /Did you mean/);
});

test("subagent tool gate: a folded name is refused with the correction", () => {
  assert.match(subagentToolBlocker(["Sam-Memory-Search"])!, /Did you mean "sam_memory_search"\?$/);
  assert.match(subagentToolBlocker(["SAM_MEMORY_SEARCH"])!, /Did you mean "sam_memory_search"\?$/);
  assert.match(subagentToolBlocker(["sam memory search"])!, /Did you mean "sam_memory_search"\?$/);
  assert.match(subagentToolBlocker(["sam-workspace-read"])!, /Did you mean "sam_workspace_read"\?$/);
});

test("subagent tool gate: several unknowns are all echoed, each folded one corrected", () => {
  const blocker = subagentToolBlocker(["sam_teleport", "Sam-Reach", "sam_memory_list"])!;
  assert.ok(blocker.startsWith("Tool allowlist cannot widen past the parent: sam_teleport, Sam-Reach. Parent tools: "), blocker);
  assert.match(blocker, /Did you mean "sam_reach"\?$/);
});

test("subagent tool gate: the parent set is the registry - a real tool outside it widens with no correction, a folded parent tool corrects within it", () => {
  const parent = ["sam_memory_list", "sam_propose_action"];
  const widened = subagentToolBlocker(["sam_code"], parent)!;
  assert.ok(widened.startsWith("Tool allowlist cannot widen past the parent: sam_code. Parent tools: sam_memory_list, sam_propose_action"), widened);
  assert.doesNotMatch(widened, /Did you mean/);
  assert.equal(subagentToolBlocker(["sam_memory_list"], parent), null);
  assert.match(subagentToolBlocker(["Sam-Propose-Action"], parent)!, /Did you mean "sam_propose_action"\?$/);
});

test("subagent tool gate: the spawn seam refuses a folded tool before spawning anything, and exact tools spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-tool-gate-"));
  try {
    await assert.rejects(() => spawnSubagent(root, { profile: "sam", prompt: "look", tools: ["Sam-Memory-Search"] }, { complete: text("no") }), /Did you mean "sam_memory_search"\?$/);
    await assert.rejects(() => spawnSubagent(root, { profile: "sam", prompt: "look", tools: ["sam_teleport"] }, { complete: text("no") }), /^Error: Tool allowlist cannot widen past the parent: sam_teleport\. Parent tools:/);
    assert.deepEqual(listSubagents(root), []);
    const child = await spawnSubagent(root, { profile: "sam", prompt: "look", tools: ["sam_memory_search"] }, { complete: text("done") });
    assert.deepEqual(child.tools, ["sam_memory_search"]);
    assert.equal(listSubagents(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
