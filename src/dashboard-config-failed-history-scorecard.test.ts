import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDashboardConfigFailedSummary, dashboardConfigFailedHistoryScorecardText, dashboardConfigFailureSummary } from "./dashboard-config.js";
import { recordActivity } from "./activity.js";
import { connectorFailureSummary } from "./connectors.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The dashboard config failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the dashboard config
// store ledgers every failed store touch as a
// dashboard-config-failed line through the ONE writer
// dashboardConfigFailureSummary (one fixed shape: "Dashboard
// config <phase> failed: <reason>", phases read / resolve /
// write, ledger actor sam always), ridden by
// recordDashboardConfigFailure from the store read on nearly
// every turn, tick, and status read - but the class was never
// folded, so how often the default-agent resolution itself
// died was invisible in aggregate. Every failure line is by
// construction a dashboard config store touch that did not
// complete, so the verdict is attention when any failure was
// ever recorded or any line is unparseable, else clear. The
// scorecard text is a script job's stdout and is P3-diffed on
// its facts, so it is ONE line carrying counts only: no stamp
// and no verbatim reason - the summaries carry reasons, and
// the fold consumes and never prints them, and no config
// record ever surfaces (the default agent and team-events
// flag are routing data, not failure data). The scorecard
// path is a pure read - it creates nothing, sends nothing,
// and retries nothing; every state here is built through the
// ledger's own public door (recordActivity) with the seam's
// own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-dashboard-config-failed-history-"));
}

const BARE = "Dashboard config failed history: clear, 0 failed, 0 read, 0 resolve, 0 write, 0 total";

test("dashboard config failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = dashboardConfigFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = dashboardConfigFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held dashboard config scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dashboard config failed history scorecard: the writer's failures fold to counts per phase, and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = dashboardConfigFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "dashboard-config-failed", dashboardConfigFailureSummary("read", "database is locked sekrit"));
    recordActivity(dir, "sam", "dashboard-config-failed", dashboardConfigFailureSummary("read", "disk full"));
    recordActivity(dir, "sam", "dashboard-config-failed", dashboardConfigFailureSummary("resolve", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "dashboard-config-failed", dashboardConfigFailureSummary("write", "EACCES: permission denied"));
    recordActivity(dir, "sam", "dashboard-config-failed", dashboardConfigFailureSummary("write", "EISDIR: illegal operation"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = dashboardConfigFailedHistoryScorecardText(dir);
    assert.equal(text, "Dashboard config failed history: attention, 5 failed, 2 read, 1 resolve, 2 write, 5 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EPERM"), false, "no reason head surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dashboard config failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = dashboardConfigFailureSummary("write", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseDashboardConfigFailedSummary(capped), { phase: "write" });
    recordActivity(dir, "sam", "dashboard-config-failed", capped);
    const text = dashboardConfigFailedHistoryScorecardText(dir);
    assert.equal(text, "Dashboard config failed history: attention, 1 failed, 0 read, 0 resolve, 1 write, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dashboard config failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and an unknown-phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "dashboard-config-failed", dashboardConfigFailureSummary("read", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "dashboard-config-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "dashboard-config-failed", connectorFailureSummary("read", "boom sekrit"));
    recordActivity(dir, "sam", "dashboard-config-failed", "Dashboard config read failed:   ");
    recordActivity(dir, "sam", "dashboard-config-failed", "Dashboard config delete failed: boom");
    const text = dashboardConfigFailedHistoryScorecardText(dir);
    assert.equal(text, "Dashboard config failed history: attention, 1 failed, 1 read, 0 resolve, 0 write, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dashboard config failed parse: the writer is byte-identical to the ledgered shapes and parses, and only the fixed shapes parse", () => {
  assert.equal(dashboardConfigFailureSummary("read", "database is locked"), "Dashboard config read failed: database is locked");
  assert.equal(dashboardConfigFailureSummary("resolve", "database is locked"), "Dashboard config resolve failed: database is locked");
  assert.equal(dashboardConfigFailureSummary("write", "database is locked"), "Dashboard config write failed: database is locked");
  assert.deepEqual(parseDashboardConfigFailedSummary(dashboardConfigFailureSummary("read", "boom")), { phase: "read" });
  assert.deepEqual(parseDashboardConfigFailedSummary(dashboardConfigFailureSummary("resolve", "boom")), { phase: "resolve" });
  assert.deepEqual(parseDashboardConfigFailedSummary(dashboardConfigFailureSummary("write", "boom")), { phase: "write" });
  assert.equal(parseDashboardConfigFailedSummary(""), null);
  assert.equal(parseDashboardConfigFailedSummary("Dashboard config read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseDashboardConfigFailedSummary("Dashboard config read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseDashboardConfigFailedSummary("Dashboard config delete failed: boom"), null, "a phase the door never writes does not parse");
  assert.equal(parseDashboardConfigFailedSummary(connectorFailureSummary("read", "boom")), null, "a connector-failed line never parses as a dashboard-config-failed line");
  assert.deepEqual(parseDashboardConfigFailedSummary("Dashboard config read failed: boom: with colon"), { phase: "read" }, "a reason carrying a colon still parses from the fixed head");
});

test("dashboard config failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-dashboard-config-failed-history"), "sam-dashboard-config-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-dashboard-config-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "dashboard-config-failed-history"], "the argv rides observe dashboard-config-failed-history");
});
