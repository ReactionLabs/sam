import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHeartbeatJob, findHeartbeatJob, heartbeatJobBlocker, heartbeatJobs, removeHeartbeatJob } from "./heartbeat.js";

// The heartbeat-job gate for the remove door: jobs are
// created by name (unique), listed by name, and diffed and
// delivered by name in every ledger line, but
// `sam heartbeats remove <id>` rode removeHeartbeatJob
// alone and took an id ONLY: it accepted no name at all,
// and an unknown id silently returned {removed:false},
// naming nothing, so at the door that DELETES a job the
// owner could not tell a typo from a genuinely absent job
// (the channel-remove shape). The CLI remove door now
// takes <idOrName>, resolves it through findHeartbeatJob
// (throwing heartbeatJobBlocker, the ONE source naming the
// registry with a fold correction, before anything is
// removed) and removes by the resolved id;
// removeHeartbeatJob keeps its boolean contract (false on
// a miss) for internal callers - the store seam stays
// permissive by design.

function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-heartbeat-remove-gate-"));
  addHeartbeatJob(root, "stack watch", 30, "sam", "Watch the stack.");
  addHeartbeatJob(root, "morning-digest", 60, "sam", "Digest the morning.");
  return root;
}

test("heartbeat remove gate: an exact name reads no blocker and removes by the resolved id", () => {
  const root = fresh();
  try {
    assert.equal(heartbeatJobBlocker(root, "stack watch"), null);
    const resolved = findHeartbeatJob(root, "stack watch");
    assert.equal(removeHeartbeatJob(root, resolved.id), true);
    assert.deepEqual(heartbeatJobs(root).map(j => j.name), ["morning-digest"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat remove gate: an exact id reads no blocker and removes", () => {
  const root = fresh();
  try {
    const target = findHeartbeatJob(root, "morning-digest");
    assert.equal(heartbeatJobBlocker(root, target.id), null);
    assert.equal(removeHeartbeatJob(root, findHeartbeatJob(root, target.id).id), true);
    assert.deepEqual(heartbeatJobs(root).map(j => j.name), ["stack watch"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat remove gate: a folded name is refused with the correction and removes nothing", () => {
  const root = fresh();
  try {
    const stack = findHeartbeatJob(root, "stack watch");
    const digest = findHeartbeatJob(root, "morning-digest");
    const blocker = heartbeatJobBlocker(root, "Stack Watch")!;
    assert.equal(
      blocker,
      "Heartbeat job not found: \"Stack Watch\". Heartbeat jobs: stack watch (" + stack.id + "), morning-digest (" + digest.id + "). Did you mean \"stack watch\" (" + stack.id + ")?",
    );
    assert.throws(() => findHeartbeatJob(root, "Stack Watch"), (e: unknown) => e instanceof Error && e.message === blocker);
    // The door throws before the store seam runs, so the
    // job is still registered afterwards.
    assert.deepEqual(heartbeatJobs(root).map(j => j.name), ["stack watch", "morning-digest"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat remove gate: a separator-folded name corrects the same way", () => {
  const root = fresh();
  try {
    const blocker = heartbeatJobBlocker(root, "Morning_Digest")!;
    assert.match(blocker, /Did you mean "morning-digest" \(.+\)\?$/);
    assert.deepEqual(heartbeatJobs(root).map(j => j.name), ["stack watch", "morning-digest"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat remove gate: an unknown name or id names the registry with no correction", () => {
  const root = fresh();
  try {
    const blocker = heartbeatJobBlocker(root, "ghost")!;
    assert.match(blocker, /^Heartbeat job not found: "ghost"\. Heartbeat jobs: stack watch \(.+\), morning-digest \(.+\)$/);
    assert.throws(() => findHeartbeatJob(root, "ghost"));
    assert.equal(heartbeatJobs(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat remove gate: an empty registry names none registered", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-heartbeat-remove-gate-"));
  try {
    assert.equal(heartbeatJobBlocker(root, "ghost"), "Heartbeat job not found: \"ghost\". Heartbeat jobs: none registered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat remove gate: an ambiguous fold offers no correction", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-heartbeat-remove-gate-"));
  try {
    addHeartbeatJob(root, "stack watch", 30, "sam", "Watch the stack.");
    addHeartbeatJob(root, "stack-watch", 30, "sam", "Watch the stack again.");
    const blocker = heartbeatJobBlocker(root, "STACK_WATCH")!;
    assert.doesNotMatch(blocker, /Did you mean/);
    assert.equal(heartbeatJobs(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat remove gate: the store seam keeps its boolean contract", () => {
  const root = fresh();
  try {
    assert.equal(removeHeartbeatJob(root, "nope"), false);
    const target = findHeartbeatJob(root, "stack watch");
    assert.equal(removeHeartbeatJob(root, target.id), true);
    assert.equal(removeHeartbeatJob(root, target.id), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
