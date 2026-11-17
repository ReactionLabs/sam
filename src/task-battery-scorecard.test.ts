import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskBattery, taskBatteryText, TASK_BATTERY_SCRIPT } from "./task-battery.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The task battery's daily-measurement wiring (2026-11-17,
// mirroring the eval battery's 13:04 fix): the scorecard text
// is a script job's stdout and is P3-diffed on its facts, so it
// carries no clock or duration reading - not the run stamp,
// not a case's durationMs, not the cold-chat evidence's own
// measured milliseconds. The recorded record keeps them all.
// Two consecutive runs at the same score produce byte-identical
// text P3 judges the same news; a score change still changes
// the text. And sam-task-battery is on the Phase C script
// allowlist, riding the real CLI battery door.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-task-battery-scorecard-")); }

test("task battery scorecard: no clock or duration in the text, held runs are byte-identical and P3-equivalent", async () => {
  const root = fresh();
  try {
    const first = await runTaskBattery(root);
    assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(first.cases.every(c => typeof c.durationMs === "number"), "the record keeps the durations");
    const firstText = taskBatteryText(first);
    assert.doesNotMatch(firstText, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no run stamp in the text");
    assert.doesNotMatch(firstText, /\d+ms\b/, "no duration reading in the text");
    assert.match(firstText, /within the timed bound/, "the cold-chat evidence keeps its meaning without its milliseconds");

    const second = await runTaskBattery(root);
    const secondText = taskBatteryText(second);
    assert.equal(secondText, firstText, "two consecutive runs at the same score produce identical text");
    const prior = { hash: heartbeatOutputHash(firstText), sig: heartbeatFactSignatureString(firstText) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(secondText), heartbeatFactSignatureString(secondText)),
      true,
      "P3 judges a held task battery the same news",
    );

    const weaker = { ...second, overall: { passed: second.overall.passed - 1, total: second.overall.total } };
    assert.notEqual(taskBatteryText(weaker), secondText, "a score change still changes the text");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task battery scorecard: sam-task-battery is allowlisted and rides the battery CLI door", () => {
  assert.ok(scriptCommandNames().includes(TASK_BATTERY_SCRIPT));
  const argv = scriptArgv(fresh(), TASK_BATTERY_SCRIPT);
  assert.equal(argv[0], process.execPath);
  assert.ok(argv.some(a => a.endsWith("cli.js")));
  assert.ok(argv.includes("battery") && argv.includes("run"));
});
