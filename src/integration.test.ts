import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Integrated build proof: every module from the six PRs works
 * through ONE CLI against ONE workspace database file, across
 * separate processes (so persistence is real, not in-memory).
 */
test("integrated CLI: mission, tasks, memory, operative, assignment and approval share one workspace", () => {
  const workspace = mkdtempSync(join(tmpdir(), "sam-integration-"));
  const cli = new URL("./cli.js", import.meta.url).pathname;
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, "--workspace", workspace, "--json", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const text = result.stdout.trim();
    try { return JSON.parse(text); } catch { return text; }
  };
  try {
    run("init");
    const mission = run("mission", "create", "Integrated mission");
    run("mission", "transition", mission.code, "PLANNING");
    run("mission", "transition", mission.code, "READY");

    const task = run("task", "add", mission.code, "Do the work");
    assert.ok(task.id);

    const memory = run("memory", "add", "decision", "Use one database for every module", "--source", "integration-test", "--mission", mission.code);
    assert.ok(memory.id);
    const found = run("memory", "search", "database");
    assert.equal(found.length, 1);
    assert.equal(found[0].id, memory.id);

    const operative = run("operative", "register", "mita", "local", "code,review");
    run("operative", "state", operative.id, "available");
    const candidates = run("operative", "candidates", "code");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, operative.id);

    run("mission", "transition", mission.code, "RUNNING");
    const lease = run("assignment", "claim", operative.id, task.id);
    assert.ok(lease.id);
    assert.equal(lease.generation, 1);
    const active = run("assignment", "active", operative.id);
    assert.equal(active.length, 1);

    const approval = run("approval", "request", mission.code, "LOCAL_WRITE", JSON.stringify({ tool: "write", path: "README.md" }));
    assert.equal(approval.status, "PENDING");
    const approvals = run("approval", "list", mission.code);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].id, approval.id);
    // There is deliberately no CLI decide/consume command: deciding
    // requires an owner-authenticated boundary that is not built yet.
    const decide = spawnSync(process.execPath, [cli, "--workspace", workspace, "approval", "decide", approval.id], { encoding: "utf8" });
    assert.notEqual(decide.status, 0);

    const status = run("status");
    assert.equal(status.missions, 1);
    assert.equal(status.memories, 1);
    assert.equal(status.operatives, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
