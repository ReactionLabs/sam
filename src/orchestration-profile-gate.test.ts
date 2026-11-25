import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { listJobs, orchestrationProfileBlocker, planJob } from "./orchestration.js";

// The profile gate for the orchestration doors: every
// profile-naming creation, queue, propose, and
// standing-instruction door reads the profile registry
// before writing anything - but CLI `orchestrate plan`
// and `orchestrate run` passed the spec file's raw
// profile into planJob/orchestrate, which checks only
// that it is a non-empty string. A phantom or folded
// name ("Second Shift" for "second-shift") minted a job
// record and an orchestration-planned ledger line under
// a profile that does not exist, and run went on to hire
// workers accounted to nobody. orchestrationProfileBlocker
// is now the ONE source carrying the refusal text: BOTH
// CLI orchestrate doors throw it before planning or
// running anything. planJob/orchestrate themselves stay
// permissive by design (a profile removed after a job
// names it keeps its stored job; the sam_orchestrate
// chat tool names the speaking chat's actor by
// construction and the task battery names "sam"), so
// they are NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-orchestration-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

const LANE = {
  name: "brief", kind: "research" as const,
  goal: "Read the brief.", doneLooksLike: "A cited sentence.",
  notDoneLooksLike: "A claim with no source.", landsAt: "the job report",
};

test("orchestration profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(orchestrationProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(orchestrationProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("orchestration profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      orchestrationProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in orchestration spec. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      orchestrationProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in orchestration spec. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      orchestrationProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in orchestration spec. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("orchestration profile gate: the door's check plans nothing for a bogus profile", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    const blocker = orchestrationProfileBlocker(root, "Second Shift");
    assert.ok(blocker);
    // The door throws this text before calling planJob;
    // pin that the check alone leaves no job behind.
    assert.deepEqual(listJobs(root), []);
    assert.equal(existsSync(join(root, ".sam", "orchestration.db")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("orchestration profile gate: a registered profile passes the check and its plan really plans", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(orchestrationProfileBlocker(root, "second-shift"), null);
    const { job } = planJob(root, { profile: "second-shift", ask: "Gate test job", lanes: [LANE] });
    assert.equal(job.profile, "second-shift");
    assert.equal(listJobs(root, "second-shift").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("orchestration profile gate: planJob stays permissive - a job may name a profile removed later", () => {
  const root = fresh();
  try {
    const { job } = planJob(root, { profile: "trading", ask: "Legacy job", lanes: [LANE] });
    assert.equal(job.profile, "trading");
    assert.equal(listJobs(root, "trading").length, 1);
    assert.equal(existsSync(join(root, ".sam", "orchestration.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
