import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readActivity } from "./activity.js";
import {
  COLD_CHAT_ANSWER, COLD_CHAT_QUESTION, TASK_BATTERY_CASE_IDS, TASK_BATTERY_VERSION,
  answerColdQuestion, listTaskBatteryRuns, readTaskBattery, recordTaskBattery, resolveLiveRun,
  runTaskBattery, scoreBuildLane, scoreColdChat, scoreDoNotStore, scoreMultiFile, scoreResearch,
  taskBatteryText, type TaskBatteryRun,
} from "./task-battery.js";

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-task-battery-home-")); }

test("task battery: scorers pass a real success and fail a miss, and the build lane's unsafe-output is a fail", () => {
  const research = scoreResearch({
    sourcesText: "The launch window is Tuesday [1].\n\nSources:\n[1] notes/brief.md",
    cited: 1,
    laneVerdict: "verified",
    laneResult: "The launch window is Tuesday per notes/brief.md [1].",
  });
  assert.equal(research.passed, true);
  assert.equal(scoreResearch({ sourcesText: "no list", cited: 0, laneVerdict: "unverified", laneResult: "from memory" }).passed, false);

  const files = scoreMultiFile({
    files: ["alpha.ts", "beta.ts"],
    contentsMatch: true,
    gateBefore: { closable: false, state: "unverified" },
    gateAfter: { closable: true, state: "verified" },
  });
  assert.equal(files.passed, true);
  assert.equal(scoreMultiFile({
    files: ["alpha.ts"],
    contentsMatch: true,
    gateBefore: { closable: false, state: "unverified" },
    gateAfter: { closable: true, state: "verified" },
  }).passed, false);

  const measured = scoreBuildLane({
    researchVerdict: "verified",
    buildStatus: "failed",
    buildVerdict: null,
    buildBlocker: "Unsafe model output",
    buildAttempts: 2,
    jobStatus: "partial",
  });
  assert.equal(measured.passed, false);
  assert.match(measured.evidence, /MEASURED/);
  assert.match(measured.evidence, /Unsafe model output/);
  assert.match(measured.evidence, /research lane verified/);
  const landed = scoreBuildLane({
    researchVerdict: "verified",
    buildStatus: "done",
    buildVerdict: "verified",
    buildBlocker: null,
    buildAttempts: 1,
    jobStatus: "done",
  });
  assert.equal(landed.passed, true);
  assert.doesNotMatch(landed.evidence, /recorded as a fail/);

  assert.equal(scoreDoNotStore({ suppressionCreated: true, secretRefused: true, otherStored: true, secretPresent: false }).passed, true);
  assert.equal(scoreDoNotStore({ suppressionCreated: true, secretRefused: false, otherStored: true, secretPresent: true }).passed, false);

  assert.equal(scoreColdChat({ priorMessages: 0, answer: COLD_CHAT_ANSWER, durationMs: 1, storedAnswer: COLD_CHAT_ANSWER }).passed, true);
  assert.equal(scoreColdChat({ priorMessages: 3, answer: COLD_CHAT_ANSWER, durationMs: 1, storedAnswer: COLD_CHAT_ANSWER }).passed, false);
  assert.equal(scoreColdChat({ priorMessages: 0, answer: "I think 4, because reasoning", durationMs: 1, storedAnswer: "I think 4, because reasoning" }).passed, false);
  assert.equal(answerColdQuestion(COLD_CHAT_QUESTION), COLD_CHAT_ANSWER);
  assert.equal(answerColdQuestion("What is the harbor gate code?"), "");
});

test("task battery: harness run scores the five fixed cases on a scratch home and stores the result by version", async () => {
  const root = fresh();
  const sentinel = join(root, "sentinel.txt");
  writeFileSync(sentinel, "keep\n");
  try {
    assert.equal(readTaskBattery(root), null);
    assert.equal(existsSync(join(root, ".sam")), false);
    const run = await runTaskBattery(root);
    assert.equal(run.version, TASK_BATTERY_VERSION);
    assert.equal(run.execution, "harness");
    assert.equal(run.liveRun, "not-requested");
    assert.equal(run.overall.total, TASK_BATTERY_CASE_IDS.length);
    assert.deepEqual(run.cases.map(c => c.id), [...TASK_BATTERY_CASE_IDS]);
    assert.equal(run.cases.every(c => c.execution === "harness"), true);

    const byId = new Map(run.cases.map(c => [c.id, c]));
    assert.equal(byId.get("research-citations")?.passed, true);
    assert.match(byId.get("research-citations")?.evidence ?? "", /notes\/brief\.md/);
    assert.equal(byId.get("multi-file-coding")?.passed, true);
    assert.match(byId.get("multi-file-coding")?.evidence ?? "", /alpha\.ts/);
    assert.equal(byId.get("memory-do-not-store")?.passed, true);
    assert.equal(byId.get("cold-chat-simple")?.passed, true);
    assert.match(byId.get("cold-chat-simple")?.evidence ?? "", /0 prior messages/);
    assert.match(byId.get("cold-chat-simple")?.evidence ?? "", /ms/);

    const build = byId.get("orchestration-build-lane");
    assert.equal(build?.passed, false, "the build lane is a measured fail, not a hidden pass");
    assert.match(build?.evidence ?? "", /Unsafe model output/);
    assert.match(build?.evidence ?? "", /MEASURED/);
    assert.match(build?.evidence ?? "", /research lane verified/);
    assert.equal(run.overall.passed, 4);

    assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
    assert.equal(existsSync(join(root, ".sam", "missions.db")), false, "the scorecard home's memory store was not opened");
    assert.equal(existsSync(join(root, ".sam", "orchestration.db")), false);
    assert.equal(existsSync(join(root, ".sam", "task-battery.db")), true);

    const stored = readTaskBattery(root);
    assert.equal(stored?.at, run.at);
    assert.equal(stored?.overall.passed, 4);
    const text = taskBatteryText(run);
    assert.match(text, new RegExp("Task battery " + TASK_BATTERY_VERSION));
    assert.match(text, /orchestration-build-lane: FAIL/);
    assert.match(text, /pending Dip's keys/);
    assert.match(text, /No request was sent/);

    const lines = readActivity(root, 20).filter(l => l.kind === "task-battery");
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /4\/5 passed, live not-requested, 1 finding/);
    assert.ok(!lines[0].summary.includes("harbor"), "the ledger line carries no suppression needle");

    const again = await runTaskBattery(root, { live: true, env: {} });
    assert.equal(again.liveRun, "pending-keys");
    assert.equal(again.cases.find(c => c.id === "orchestration-build-lane")?.passed, false);
    assert.match(again.note, /pending Dip's keys/);
    assert.match(again.note, /not a pass/);
    const history = listTaskBatteryRuns(root, TASK_BATTERY_VERSION);
    assert.equal(history.length, 2);
    assert.equal(history[0].liveRun, "not-requested");
    assert.equal(history[1].liveRun, "pending-keys");
    assert.equal(readTaskBattery(root)?.liveRun, "pending-keys");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task battery: runs are stored by version and a later version does not replace an earlier one", () => {
  const root = fresh();
  try {
    const older: TaskBatteryRun = {
      version: "s4.0",
      at: "2026-11-01T00:00:00.000Z",
      execution: "harness",
      liveRun: "not-requested",
      overall: { passed: 1, total: 5 },
      cases: [],
      note: "fixture",
    };
    recordTaskBattery(root, older);
    const current: TaskBatteryRun = { ...older, version: TASK_BATTERY_VERSION, at: "2026-11-15T00:00:00.000Z", overall: { passed: 4, total: 5 } };
    recordTaskBattery(root, current);
    recordTaskBattery(root, { ...current, at: "2026-11-15T01:00:00.000Z", overall: { passed: 5, total: 5 } });
    assert.equal(readTaskBattery(root, "s4.0")?.overall.passed, 1);
    assert.equal(readTaskBattery(root, TASK_BATTERY_VERSION)?.overall.passed, 5);
    assert.equal(listTaskBatteryRuns(root).length, 3);
    assert.equal(listTaskBatteryRuns(root, "s4.0").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task battery: a configured key is not sent, and a missing key is pending", () => {
  assert.equal(resolveLiveRun(false, {}), "not-requested");
  assert.equal(resolveLiveRun(true, {}), "pending-keys");
  assert.equal(resolveLiveRun(true, { SAM_MODEL_API_KEY: "present-but-unused" }), "pending-ruling");
  assert.equal(resolveLiveRun(false, { SAM_MODEL_API_KEY: "present-but-unused" }), "not-requested");
});

test("task battery: sam battery prints the scorecard and show reads it back", async () => {
  const root = fresh();
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "--workspace", root, ...args], { encoding: "utf8" });
  try {
    const first = run("battery");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, new RegExp("Task battery " + TASK_BATTERY_VERSION));
    assert.match(first.stdout, /orchestration-build-lane: FAIL/);
    assert.match(first.stdout, /Unsafe model output/);
    assert.match(first.stdout, /research-citations: PASS/);
    assert.match(first.stdout, /cold-chat-simple: PASS/);
    const shown = run("battery", "show");
    assert.equal(shown.status, 0, shown.stderr);
    const shownRun = JSON.parse(shown.stdout) as { liveRun: string; version: string; overall: { passed: number } };
    assert.equal(shownRun.version, TASK_BATTERY_VERSION);
    assert.equal(shownRun.liveRun, "not-requested");
    assert.equal(shownRun.overall.passed, 4);
    const json = run("--json", "battery", "versions");
    assert.equal(json.status, 0, json.stderr);
    const versions = JSON.parse(json.stdout) as string[];
    assert.deepEqual(versions, [TASK_BATTERY_VERSION]);
    const live = run("battery", "--live");
    assert.equal(live.status, 0, live.stderr);
    assert.match(live.stdout, /live: pending-keys/);
    assert.match(live.stdout, /No request was sent/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
