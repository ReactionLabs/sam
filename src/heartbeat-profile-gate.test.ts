import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listActions, proposeAction } from "./actions.js";
import { readActivity } from "./activity.js";
import { ChatStore } from "./chats.js";
import { addHeartbeatJob, heartbeatJobs, heartbeatProfileBlocker } from "./heartbeat.js";

// The profile gate for heartbeat job creation doors:
// validateHeartbeatDetail refused a profile outside the
// registry, but the two CLI doors (heartbeats add /
// schedule) passed the raw profile into the store, whose
// validJobProfile checks only the name's shape - minting a
// job whose every tick runs under a profile that does not
// exist. heartbeatProfileBlocker is now the ONE source
// carrying the gate's exact refusal text: the gate rides it
// and both CLI doors throw it before creating anything. The
// store itself stays permissive by design (a profile removed
// after a job names it is recorded by the tick's failure
// isolation), so addHeartbeatJob is NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-hb-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

function detail(profile: string): string {
  return JSON.stringify({ name: "morning check", minutes: 60, profile, prompt: "do the check" });
}

test("heartbeat profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(heartbeatProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(heartbeatProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      heartbeatProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in heartbeat detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      heartbeatProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in heartbeat detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      heartbeatProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in heartbeat detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat profile gate: a proposal naming a bogus profile refuses in the ONE source's words and creates nothing", () => {
  const root = fresh();
  try {
    const blocker = heartbeatProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    let err = "";
    try { proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Morning check", detail: detail("nosuchprofile") }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert.equal(err, blocker);
    assert.equal(listActions(root).length, 0);
    assert.equal(readActivity(root).filter(l => l.kind === "proposal").length, 0);
    assert.equal(heartbeatJobs(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat profile gate: a proposal naming a registered profile pends cleanly", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    const a = proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Morning check", detail: detail("second-shift") });
    assert.equal(a.status, "pending");
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat profile gate: the store stays permissive - a job may name a profile removed later", () => {
  const root = fresh();
  try {
    const job = addHeartbeatJob(root, "morning check", 60, "trading", "do the check");
    assert.equal(job.profile, "trading");
    assert.equal(heartbeatJobs(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
