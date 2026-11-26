import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptArgv, scriptCommandNames, scriptNameBlocker } from "./schedule.js";
import { addScheduledJob, heartbeatJobs } from "./heartbeat.js";

// The script-name gate: every door that resolves a no-agent
// script name rides scriptArgv (heartbeat job creation, the
// P1 proposal gate's heartbeat validation, and the tick's
// script runner), and that seam improvised its refusal
// inline - "Unknown script 'X'. Allowlisted scripts: ..."
// named the registry but offered no fold correction, so a
// folded name ("Sam Overview", "sam_overview") dead-ended
// with nothing to act on. scriptNameBlocker in schedule.ts
// is now the ONE source carrying the refusal text, and
// scriptArgv throws it before anything is created,
// proposed, or run. scriptCommandNames and
// SCRIPT_JOB_COMMANDS stay permissive by design (the
// listing door reads them raw), so neither is gated here.

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "sam-script-name-gate-"));
}

test("script name gate: an exact allowlisted name reads no blocker", () => {
  assert.equal(scriptNameBlocker("sam-overview"), null);
  assert.equal(scriptNameBlocker("sam-brief"), null);
  for (const name of scriptCommandNames()) assert.equal(scriptNameBlocker(name), null);
});

test("script name gate: an unknown name names the allowlist, no correction", () => {
  const blocker = scriptNameBlocker("rm-rf")!;
  assert.ok(blocker.startsWith("Unknown script 'rm-rf'. Allowlisted scripts: "));
  assert.ok(blocker.includes("sam-overview"));
  assert.ok(!blocker.includes("Did you mean"));
  const root = fresh();
  try {
    assert.throws(() => scriptArgv(root, "rm-rf"), (e: unknown) => e instanceof Error && e.message === blocker);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("script name gate: a folded name is refused with the correction", () => {
  assert.match(scriptNameBlocker("Sam Overview")!, /Did you mean 'sam-overview'\?$/);
  assert.match(scriptNameBlocker("sam_overview")!, /Did you mean 'sam-overview'\?$/);
  assert.match(scriptNameBlocker("SAM-BRIEF")!, /Did you mean 'sam-brief'\?$/);
  const root = fresh();
  try {
    assert.throws(() => scriptArgv(root, "Sam Overview"), (e: unknown) => e instanceof Error && e.message === scriptNameBlocker("Sam Overview"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("script name gate: a folded script refuses job creation and creates nothing", () => {
  const root = fresh();
  try {
    assert.throws(
      () => addScheduledJob(root, { name: "folded", profile: "sam", schedule: "every 30 minutes", script: "Sam Overview" }),
      (e: unknown) => e instanceof Error && e.message === scriptNameBlocker("Sam Overview"),
    );
    assert.equal(heartbeatJobs(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("script name gate: an exact name still resolves its argv and creates its job", () => {
  const root = fresh();
  try {
    const argv = scriptArgv(root, "sam-overview");
    assert.equal(argv[0], process.execPath);
    assert.ok(argv.some(a => a.endsWith("cli.js")));
    const job = addScheduledJob(root, { name: "watch", profile: "sam", schedule: "every 30 minutes", script: "sam-overview" });
    assert.equal(job.mode, "script");
    assert.equal(job.script, "sam-overview");
    assert.equal(heartbeatJobs(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
