import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { classifyDefect, rankDefects } from "./self-work.js";
import { addTeamMember, runStandingTeam } from "./team-runtime.js";

// The supervised-work failure classes the ledger already carried but
// self-work's classifier dropped: each kind must classify to its own
// plain key so rankDefects counts it and a fix spec can be built.
test("supervised-work failure kinds classify to their own defect classes", () => {
  const line = (kind: string) => ({ at: "2026-11-13T14:00:00.000Z", actor: "sam", kind, summary: "boom" });
  assert.deepEqual(classifyDefect(line("subagent-failed")), { key: "subagent-failed", label: "sub-agent runs closing failed" });
  assert.deepEqual(classifyDefect(line("delegate-failed")), { key: "delegate-failed", label: "coding delegations closing failed" });
  assert.deepEqual(classifyDefect(line("team-failed")), { key: "team-failed", label: "standing team runs closing failed" });
  assert.deepEqual(classifyDefect(line("team-blocked")), { key: "team-blocked", label: "standing team runs closing blocked" });
  assert.deepEqual(classifyDefect(line("connector-pair-failed")), { key: "connector-pair-failed", label: "connector self-pairing failures" });
  // Success and neutral kinds of the same families stay unclassified.
  assert.equal(classifyDefect(line("subagent-done")), null);
  assert.equal(classifyDefect(line("delegate-done")), null);
  assert.equal(classifyDefect(line("team-done")), null);
  assert.equal(classifyDefect(line("connector-paired")), null);
});

test("rankDefects counts the newly classified classes from the ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-supervised-classify-"));
  try {
    recordActivity(root, "sam", "subagent-failed", "Sub-agent abcd1234 failed: model down");
    recordActivity(root, "sam", "subagent-failed", "Sub-agent efgh5678 failed: model down");
    recordActivity(root, "dip", "delegate-failed", "Delegation failed: worktree dirty");
    recordActivity(root, "sam", "connector-pair-failed", "Pairing connector \"x\" failed and was rolled back: refused");
    const ranked = rankDefects(root).filter(d => d.source === "ledger");
    const byKey = new Map(ranked.map(d => [d.key, d.count]));
    assert.equal(byKey.get("subagent-failed"), 2);
    assert.equal(byKey.get("delegate-failed"), 1);
    assert.equal(byKey.get("connector-pair-failed"), 1);
    assert.equal(ranked[0].key, "subagent-failed", "the recurring class tops the queue");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a thrown standing team run ledgers exactly one team-failed line, carrying the reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-supervised-classify-"));
  try {
    addTeamMember(root, { name: "ada", role: "builder", maxCalls: 4 });
    addTeamMember(root, { name: "cy", role: "reviewer", maxCalls: 4 });
    const run = await runStandingTeam(root, "Build the widget", {
      complete: async () => { throw new Error("worker model exploded"); },
    });
    assert.equal(run.status, "failed");
    const failed = readActivity(root, 100, { kind: "team-failed" });
    assert.equal(failed.length, 1, "one failure, one ledger line - the catch no longer double-writes");
    assert.match(failed[0].summary, /Team run .* failed after 0 review round\(s\) \(ada -> cy\): worker model exploded/);
    assert.equal(classifyDefect(failed[0])?.key, "team-failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a blocked standing team run ledgers one team-blocked line self-work counts", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-supervised-classify-"));
  try {
    addTeamMember(root, { name: "ada", role: "builder", maxCalls: 4 });
    addTeamMember(root, { name: "cy", role: "reviewer", maxCalls: 4 });
    const run = await runStandingTeam(root, "Build the widget", {
      maxRounds: 1,
      complete: async (input) => input.member.role === "reviewer" ? "VERDICT: request-changes\nStill missing." : "Attempt.",
    });
    assert.equal(run.status, "blocked");
    const blocked = readActivity(root, 100, { kind: "team-blocked" });
    assert.equal(blocked.length, 1);
    assert.equal(classifyDefect(blocked[0])?.key, "team-blocked");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
