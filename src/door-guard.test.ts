import test from "node:test";
import assert from "node:assert/strict";
import { BENIGN_PACK, DoorAbuseGuard, RED_TEAM_PACK, runRedTeamPack, screenDoorMessage } from "./door-guard.js";

test("door guard: the whole red-team pack is refused under its own category", () => {
  for (const entry of RED_TEAM_PACK) {
    const result = screenDoorMessage(entry.text);
    assert.equal(result.blocked, true, entry.text);
    assert.equal(result.category, entry.category, entry.text);
  }
});

test("door guard: the benign pack passes whole - owner near-misses are not attacks", () => {
  for (const text of BENIGN_PACK) assert.deepEqual(screenDoorMessage(text), { blocked: false, category: null }, text);
  const report = runRedTeamPack();
  assert.equal(report.pass, true);
  assert.equal(report.blocked, report.total);
  assert.equal(report.benignPassed, report.benignTotal);
  assert.deepEqual(report.missed, []);
  assert.deepEqual(report.falsePositives, []);
});

test("door guard: the per-mini aggregate cap cannot be reset by rotating sessions", () => {
  const guard = new DoorAbuseGuard(3, 20, 600000, 300000);
  // The session-keyed limiter would give each of these a fresh allowance;
  // the aggregate sees one mini, three messages, then a wall.
  assert.equal(guard.allowMini("alex", 1000), true);
  assert.equal(guard.allowMini("alex", 2000), true);
  assert.equal(guard.allowMini("alex", 3000), true);
  assert.equal(guard.allowMini("alex", 4000), false);
  assert.equal(guard.allowMini("blair", 4000), true);
  assert.equal(guard.stats(4000).rateLimited, 1);
  // The window slides: an hour later the same mini is welcome again.
  assert.equal(guard.allowMini("alex", 1000 + 3600001), true);
});

test("door guard: key probing is counted and locks the doors exactly once", () => {
  const guard = new DoorAbuseGuard(120, 3, 600000, 300000);
  assert.deepEqual(guard.noteProbe(1000), { locked: false, justLocked: false });
  assert.deepEqual(guard.noteProbe(2000), { locked: false, justLocked: false });
  assert.deepEqual(guard.noteProbe(3000), { locked: true, justLocked: true });
  assert.equal(guard.probeLocked(3001), true);
  // Probes during the lockout extend nothing and never re-report the trip.
  assert.deepEqual(guard.noteProbe(4000), { locked: true, justLocked: false });
  assert.equal(guard.probeLocked(3000 + 300001), false);
  const stats = guard.stats(4000);
  assert.equal(stats.probes, 4);
  assert.ok(stats.probeLockedUntil);
  guard.noteBlocked(); guard.noteBlocked();
  assert.equal(guard.stats(4000).blockedMessages, 2);
});
