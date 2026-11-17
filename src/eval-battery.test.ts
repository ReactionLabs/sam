import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { buildEvalBattery, evalBatteryText, EVAL_TASK_TOTAL, readEvalBattery, runEvalBattery } from "./eval-battery.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";

// HARNESS INTELLIGENCE item 4: the behavior eval battery. The
// 27 tasks run the REAL machinery in scratch state (the stack
// watch's counters, recall and note tiers, the ONE gate's
// policy functions, the verification ledger, the code store,
// the senses/engine probes, the door guard pack), a run
// records to the one-row SQLite store with a verdict against
// the previous run and one counts-only ledger line, a pure
// read creates nothing, and a legacy JSON record imports once
// and is renamed, never deleted.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-eval-battery-")); }

test("eval-battery: all 27 realistic tasks pass on the current harness", async () => {
  const root = fresh();
  try {
    const battery = await buildEvalBattery(null);
    assert.equal(battery.overall.total, EVAL_TASK_TOTAL);
    assert.equal(battery.findings.length, 0, JSON.stringify(battery.findings));
    assert.equal(battery.overall.passed, EVAL_TASK_TOTAL);
    assert.equal(battery.categories.length, 6);
    assert.equal(battery.verdict, "first-run");
    assert.equal(battery.previous, null);
    const perCategory = Object.fromEntries(battery.categories.map(c => [c.id, c.passed + "/" + c.total]));
    assert.deepEqual(perCategory, { inquiries: "4/4", memory: "9/9", gate: "6/6", coding: "3/3", limits: "4/4", answers: "1/1" });
    assert.match(evalBatteryText(battery), /Findings: none/);
    assert.match(evalBatteryText(battery), /verdict: first-run/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("eval-battery: a run records to SQLite, the next run holds against it, and the ledger carries counts and verdict only", async () => {
  const root = fresh();
  try {
    assert.equal(readEvalBattery(root), null);
    assert.equal(existsSync(join(root, ".sam")), false);
    const first = await runEvalBattery(root);
    assert.equal(first.verdict, "first-run");
    assert.equal(readEvalBattery(root)?.overall.passed, EVAL_TASK_TOTAL);
    assert.equal(existsSync(join(root, ".sam", "eval-battery.db")), true);
    assert.equal(existsSync(join(root, ".sam", "eval-battery.json")), false);
    const second = await runEvalBattery(root);
    assert.equal(second.verdict, "held");
    assert.deepEqual(second.previous, { at: first.at, passed: first.overall.passed, total: first.overall.total });
    const lines = readActivity(root, 50).filter(l => l.kind === "eval-battery");
    assert.equal(lines.length, 2);
    assert.match(lines[0].summary, /Eval battery recorded: 27\/27 tasks, verdict first-run/);
    assert.match(lines[1].summary, /verdict held \(was 27\/27\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("eval-battery: a regression against the previous run reads regressed and names the ship gate", async () => {
  const root = fresh();
  try {
    const strong = await buildEvalBattery(null);
    const weak = { ...strong, overall: { passed: strong.overall.passed - 2, total: strong.overall.total } };
    const battery = await buildEvalBattery(weak);
    assert.equal(battery.verdict, "improved");
    const down = await buildEvalBattery({ ...strong, overall: { passed: strong.overall.total, total: strong.overall.total }, at: strong.at, categories: strong.categories, findings: [], previous: null, verdict: "first-run" });
    assert.equal(down.verdict, "held");
    const regressedText = evalBatteryText({ ...battery, verdict: "regressed" });
    assert.match(regressedText, /SHIP GATE: this battery REGRESSED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("eval-battery: the scorecard text carries no clock reading, so a scheduled run at a held score is P3-silent", async () => {
  const root = fresh();
  try {
    const first = await runEvalBattery(root);
    // The record keeps both stamps; the text (the script job's
    // stdout, P3-diffed on its facts) keeps neither - a fresh
    // ISO stamp is a new date fact every run and would read as
    // changed daily at an identical score.
    assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch(evalBatteryText(first), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    const second = await runEvalBattery(root);
    assert.equal(second.verdict, "held");
    assert.ok(second.previous);
    assert.match(second.previous.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch(evalBatteryText(second), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    const third = await runEvalBattery(root);
    assert.equal(third.verdict, "held");
    // Two consecutive held runs at the same score produce the
    // identical scorecard, and P3 judges them the same news.
    assert.equal(evalBatteryText(third), evalBatteryText(second));
    const prior = { hash: heartbeatOutputHash(evalBatteryText(second)), sig: heartbeatFactSignatureString(evalBatteryText(second)) };
    assert.equal(heartbeatOutputsEquivalent(prior, heartbeatOutputHash(evalBatteryText(third)), heartbeatFactSignatureString(evalBatteryText(third))), true);
    // A score change still changes the text: the silence is
    // earned by the facts, not by blanking the scorecard.
    const weaker = { ...third, overall: { passed: third.overall.passed - 1, total: third.overall.total }, verdict: "regressed" as const };
    assert.notEqual(evalBatteryText(weaker), evalBatteryText(third));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("eval-battery: a legacy JSON record imports once and is renamed, never deleted; malformed legacy imports nothing", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacy = await buildEvalBattery(null);
    writeFileSync(join(root, ".sam", "eval-battery.json"), JSON.stringify(legacy));
    const read = readEvalBattery(root);
    assert.equal(read?.at, legacy.at);
    assert.equal(existsSync(join(root, ".sam", "eval-battery.json")), false);
    assert.equal(existsSync(join(root, ".sam", "eval-battery.json.migrated")), true);
    const root2 = fresh();
    try {
      mkdirSync(join(root2, ".sam"), { recursive: true });
      writeFileSync(join(root2, ".sam", "eval-battery.json"), "{nope");
      assert.equal(readEvalBattery(root2), null);
      assert.equal(existsSync(join(root2, ".sam", "eval-battery.json")), true);
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("eval-battery: the battery's stateful tasks run in scratch - the install's own stores stay untouched", async () => {
  const root = fresh();
  try {
    await buildEvalBattery(null);
    assert.equal(existsSync(join(root, ".sam")), false, "building the battery creates nothing in the target root");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
