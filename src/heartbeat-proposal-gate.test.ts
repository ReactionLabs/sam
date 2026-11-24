import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listActions, proposeAction } from "./actions.js";
import { readActivity } from "./activity.js";
import { HEARTBEAT_JOB_LIMIT, addHeartbeatJob, heartbeatCreationBlocker, heartbeatJobs, removeHeartbeatJob } from "./heartbeat.js";

// The proposal-time creation gate for heartbeat jobs:
// validateHeartbeatDetail checked the profile, the name's shape,
// the channel, the schedule, and the script allowlist - but never
// the creation precondition createJob enforces (the store's job
// limit, or the name already being taken), so a heartbeat card
// could be shown whose approval could only fail. The live store
// sits AT the 32-job limit, which made every heartbeat proposal
// a dead card. heartbeatCreationBlocker is now the ONE source:
// createJob throws it at creation, the gate throws the identical
// text at proposal, before any card or ledger line exists.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-hb-gate-")); }

function fillToLimit(root: string): void {
  for (let i = 0; i < HEARTBEAT_JOB_LIMIT; i++) {
    addHeartbeatJob(root, "job " + i, 60, "sam", "check " + i);
  }
}

function detail(name: string): string {
  return JSON.stringify({ name, minutes: 60, profile: "sam", prompt: "do the check" });
}

test("heartbeat gate: at the job limit a proposal refuses in the ONE source's words and creates nothing", () => {
  const root = fresh();
  try {
    fillToLimit(root);
    const blocker = heartbeatCreationBlocker(root, "one more");
    assert.ok(blocker && blocker.includes(String(HEARTBEAT_JOB_LIMIT)));
    let err = "";
    try { proposeAction(root, { actor: "sam", kind: "heartbeat", title: "One more", detail: detail("one more") }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert.equal(err, blocker);
    assert.equal(listActions(root).length, 0);
    assert.equal(readActivity(root).filter(l => l.kind === "proposal").length, 0);
    assert.equal(heartbeatJobs(root).length, HEARTBEAT_JOB_LIMIT);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat gate: the limit refusal is byte-identical at proposal and at direct creation", () => {
  const root = fresh();
  try {
    fillToLimit(root);
    let direct = "";
    try { addHeartbeatJob(root, "one more", 60, "sam", "x"); } catch (e) { direct = e instanceof Error ? e.message : String(e); }
    let proposed = "";
    try { proposeAction(root, { actor: "sam", kind: "heartbeat", title: "One more", detail: detail("one more") }); } catch (e) { proposed = e instanceof Error ? e.message : String(e); }
    assert.ok(direct.length > 0);
    assert.equal(proposed, direct);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat gate: a duplicate name refuses at proposal time, byte-identical to creation", () => {
  const root = fresh();
  try {
    addHeartbeatJob(root, "morning check", 60, "sam", "x");
    const blocker = heartbeatCreationBlocker(root, "morning check");
    assert.ok(blocker && blocker.includes("already exists"));
    let proposed = "";
    try { proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Again", detail: detail("morning check") }); } catch (e) { proposed = e instanceof Error ? e.message : String(e); }
    assert.equal(proposed, blocker);
    let direct = "";
    try { addHeartbeatJob(root, "morning check", 60, "sam", "x"); } catch (e) { direct = e instanceof Error ? e.message : String(e); }
    assert.equal(direct, blocker);
    assert.equal(listActions(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat gate: below the limit a fresh name proposes cleanly", () => {
  const root = fresh();
  try {
    assert.equal(heartbeatCreationBlocker(root, "morning check"), null);
    const a = proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Morning check", detail: detail("morning check") });
    assert.equal(a.status, "pending");
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat gate: the check is a read, not a latch - retiring a job reopens proposing", () => {
  const root = fresh();
  try {
    fillToLimit(root);
    assert.ok(heartbeatCreationBlocker(root, "one more"));
    const first = heartbeatJobs(root)[0];
    assert.ok(first && removeHeartbeatJob(root, first.id));
    assert.equal(heartbeatCreationBlocker(root, "one more"), null);
    const a = proposeAction(root, { actor: "sam", kind: "heartbeat", title: "One more", detail: detail("one more") });
    assert.equal(a.status, "pending");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat gate: a script-schedule detail is gated the same way", () => {
  const root = fresh();
  try {
    fillToLimit(root);
    const scriptDetail = JSON.stringify({ name: "daily overview", schedule: "daily at 9am", profile: "sam", script: "sam-overview" });
    let err = "";
    try { proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Daily overview", detail: scriptDetail }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert.equal(err, heartbeatCreationBlocker(root, "daily overview"));
    assert.equal(listActions(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
