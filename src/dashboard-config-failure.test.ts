import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import {
  dashboardConfigFailureSummary, isDashboardConfigLedgered,
  readDashboardConfig, writeDashboardConfig,
} from "./dashboard-config.js";
import { coreActor } from "./chat-manage.js";
import { classifyDefect } from "./self-work.js";

// Dashboard-config store failure visibility (gap found
// 2026-11-14, hourly run 10:04): the config store is read on
// nearly every turn, and every touch was unguarded - the
// direct readers (agent-turn, heartbeat, status) threw raw
// on a dead dashboard-config.db with the seam unnamed, the
// coreActor resolver swallowed the same throw into its
// designed "sam" fallback (a scoped default agent's unbound
// chats silently routed to the core profile), and the write
// door threw raw behind the dashboard config save. Each
// touch now ledgers ONE dashboard-config-failed line and
// rethrows exactly, tagged; the resolver still falls back
// exactly as before, now countable.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-dash-config-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "dashboard-config-failed" });
}

function plantDeadStore(root: string): void {
  mkdirSync(join(root, ".sam", "dashboard-config.db"), { recursive: true });
}

test("dashboard-config-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(dashboardConfigFailureSummary("read", "unable to open\n  database   file"), "Dashboard config read failed: unable to open database file");
  assert.equal(dashboardConfigFailureSummary("resolve", "disk gone"), "Dashboard config resolve failed: disk gone");
  assert.equal(dashboardConfigFailureSummary("write", "disk gone"), "Dashboard config write failed: disk gone");
  assert.equal(dashboardConfigFailureSummary("read", "x".repeat(500)).length, 200);
  for (const phase of ["read", "resolve", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "dashboard-config-failed", summary: dashboardConfigFailureSummary(phase, "boom") }),
      { key: "dashboard-config-failed:" + phase, label: "dashboard config store failures (" + phase + " step)" },
    );
  }
});

test("dashboard-config-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", () => {
  const root = scratch();
  try {
    plantDeadStore(root);
    assert.throws(() => readDashboardConfig(root), (e: unknown) => isDashboardConfigLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Dashboard config read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "dashboard-config-failed:read", label: "dashboard config store failures (read step)" });

    // The resolver still falls back to "sam" exactly as
    // before - and ledgers exactly one resolve line, never
    // a second line from its own catch.
    assert.equal(coreActor(root), "sam");
    lines = failedLines(root);
    assert.equal(lines.length, 2, "the resolver touch ledgers exactly one more line, never two for one touch");
    assert.ok(lines[1].summary.startsWith("Dashboard config resolve failed: "), lines[1].summary);
    assert.deepEqual(classifyDefect(lines[1]), { key: "dashboard-config-failed:resolve", label: "dashboard config store failures (resolve step)" });

    assert.throws(() => writeDashboardConfig(root, { defaultAgent: "dip", showTeamEvents: false }), (e: unknown) => isDashboardConfigLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3);
    assert.ok(lines[2].summary.startsWith("Dashboard config write failed: "), lines[2].summary);
    assert.deepEqual(classifyDefect(lines[2]), { key: "dashboard-config-failed:write", label: "dashboard config store failures (write step)" });

    assert.ok(!lines.some(l => l.summary.includes("dip")), "no config content ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dashboard-config-failed: an absent store reads the defaults, resolves sam, and creates nothing", () => {
  const root = scratch();
  try {
    assert.deepEqual(readDashboardConfig(root), { defaultAgent: "sam", showTeamEvents: true });
    assert.equal(coreActor(root), "sam");
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.db")), false, "a pure read creates no store");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing at all");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dashboard-config-failed: a healthy config reads, resolves, and writes back with zero failure lines", () => {
  const root = scratch();
  try {
    writeDashboardConfig(root, { defaultAgent: "dip", showTeamEvents: false });
    assert.deepEqual(readDashboardConfig(root), { defaultAgent: "dip", showTeamEvents: false });
    assert.equal(coreActor(root), "dip");
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
