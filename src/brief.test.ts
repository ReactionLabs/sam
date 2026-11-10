import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefStatus, buildBrief, installBrief, senseItemLines } from "./brief.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";
import { addHeartbeatJob, heartbeatJobs } from "./heartbeat.js";
import { proposeAction } from "./actions.js";
import { readActivity } from "./activity.js";
import { executeOwnToolAsync, OWN_TOOLS } from "./own-tools.js";
import { CORE_OWN_TOOLS } from "./tool-tiers.js";
import { ChatStore } from "./chats.js";
import type { SenseRunner } from "./senses.js";

// Phase E item 3: the morning brief. Fixtures use a fake senses
// reader binary on disk (so sensesBinary resolves it) with an
// injected runner returning canned reader JSON per sense, so the
// brief's assembly is asserted exactly with no model and no
// network.

const NOW = new Date("2026-11-10T13:00:00.000Z"); // 08:00 EST

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-brief-"));
  const root = join(base, "home");
  const binDir = join(base, "bin");
  mkdirSync(root, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const gog = join(binDir, "gog");
  writeFileSync(gog, "#!/bin/sh\nexit 0\n");
  chmodSync(gog, 0o755);
  return { base, root, env: { SAM_GOG_BIN: gog, PATH: binDir } as NodeJS.ProcessEnv };
}

const cannedRunner: SenseRunner = async (_file, args) => {
  if (args[0] === "calendar") return { exitCode: 0, output: JSON.stringify([{ summary: "Dentist appointment", start: { dateTime: "2026-11-10T14:00:00Z" } }, { summary: "School pickup", start: "2026-11-10T20:00:00Z" }]) };
  if (args[0] === "gmail") return { exitCode: 0, output: JSON.stringify([{ subject: "Rent receipt", from: "landlord@example.com" }]) };
  return { exitCode: 1, output: "" };
};

test("brief: reader items become plain title/time/sender lines, capped with a more-tail", () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ summary: "Event " + String(i + 1) }));
  const { lines, total } = senseItemLines(JSON.stringify(items));
  assert.equal(total, 7);
  assert.equal(lines.length, 6);
  assert.equal(lines[0], "Event 1");
  assert.equal(lines[5], "and 2 more");
  const nested = senseItemLines(JSON.stringify([{ summary: "Dentist", start: { dateTime: "2026-11-10T14:00:00Z" } }]));
  assert.deepEqual(nested.lines, ["2026-11-10T14:00:00Z - Dentist"]);
  const text = senseItemLines("first line\nsecond line\n");
  assert.deepEqual(text, { lines: ["first line", "second line"], total: 2 });
  assert.deepEqual(senseItemLines("  "), { lines: [], total: 0 });
});

test("brief: the assembled brief carries every section with the day's facts", async () => {
  const f = fixture();
  try {
    addHeartbeatJob(f.root, "stack watch", 30, "trading", "Watch the stack");
    mkdirSync(join(f.root, ".sam"), { recursive: true });
    appendFileSync(join(f.root, ".sam", "heartbeats.jsonl"), JSON.stringify({ at: "2026-11-10T12:30:00.000Z", type: "job-unchanged", name: "stack watch", profile: "trading" }) + "\n");
    proposeAction(f.root, { actor: "sam", kind: "note", title: "Save a fact", detail: "A helpful fact" });
    const brief = await buildBrief(f.root, { now: NOW, env: f.env, runner: cannedRunner });
    const byName = Object.fromEntries(brief.sections.map(s => [s.name, s]));
    assert.equal(byName["Today"].state, "ok");
    assert.ok(byName["Today"].lines.some(l => l.includes("Dentist appointment")));
    assert.equal(byName["Mail"].state, "ok");
    assert.ok(byName["Mail"].lines.some(l => l.includes("Rent receipt") && l.includes("landlord@example.com")));
    assert.equal(byName["Needs you"].state, "ok");
    assert.ok(byName["Needs you"].lines.some(l => l.includes("1 approval waiting") && l.includes("note")));
    assert.ok(byName["Watches"].lines.some(l => l.includes("stack watch: unchanged as of 12:30 UTC")));
    assert.equal(byName["Work queues"].state, "empty");
    assert.match(brief.text, /^Morning brief - Tuesday, November 10, 2026/);
    assert.ok(!brief.text.includes("**"), "the brief is plain style: no markdown emphasis");
    const briefLines = readActivity(f.root, 50).filter(a => a.kind === "brief");
    assert.equal(briefLines.length, 1);
    assert.ok(!briefLines[0].summary.includes("Dentist"), "the brief ledger line carries section states, never content");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("brief: with no reader installed the sense sections say so plainly and the rest still assembles", async () => {
  const f = fixture();
  try {
    const brief = await buildBrief(f.root, { now: NOW, env: { PATH: "" } as NodeJS.ProcessEnv });
    const byName = Object.fromEntries(brief.sections.map(s => [s.name, s]));
    assert.equal(byName["Today"].state, "unavailable");
    assert.match(byName["Today"].lines[0], /senses reader is not installed/);
    assert.equal(byName["Mail"].state, "unavailable");
    assert.equal(byName["Needs you"].state, "empty");
    assert.match(byName["Needs you"].lines[0], /Nothing is waiting on you/);
    assert.equal(byName["Watches"].state, "empty");
    assert.equal(brief.sections.length, 5, "no section is silently dropped");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("brief: install creates ONE daily wall-clock script job on the Phase C surface, and sam-brief is an allowlisted script", () => {
  const f = fixture();
  try {
    assert.ok(scriptCommandNames().includes("sam-brief"));
    assert.deepEqual(scriptArgv(f.root, "sam-brief").slice(-2), ["brief", "today"]);
    assert.equal(briefStatus(f.root).installed, false);
    const job = installBrief(f.root, {});
    assert.equal(job.mode, "script");
    assert.equal(job.script, "sam-brief");
    assert.equal(job.profile, "sam");
    assert.equal(job.cron, "0 8 * * *");
    assert.equal(job.timezone, "America/New_York");
    assert.equal(job.channelId, null);
    assert.equal(briefStatus(f.root).installed, true);
    assert.equal(heartbeatJobs(f.root).length, 1);
    assert.throws(() => installBrief(f.root, {}), /already installed/);
    assert.throws(() => installBrief(f.root, { channelId: "nope" }), /already installed/, "the duplicate check fires before channel validation");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("brief: an unknown install channel refuses naming the registry", () => {
  const f = fixture();
  try {
    assert.throws(() => installBrief(f.root, { channelId: "nope" }), /Unknown channel 'nope'/);
    assert.equal(briefStatus(f.root).installed, false);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("brief: sam_brief is a deferred-tier core-only own tool - scoped actors and visitors refused", async () => {
  const f = fixture();
  try {
    assert.ok(OWN_TOOLS.some(t => (t as { function: { name: string } }).function.name === "sam_brief"));
    assert.ok(!CORE_OWN_TOOLS.includes("sam_brief"), "the brief rides the deferred tier like the senses; the upfront core is full");
    const scoped = await executeOwnToolAsync(f.root, "trading", "sam_brief", {}) as { error?: string };
    assert.match(scoped.error ?? "", /core profile/);
    const db = new ChatStore(f.root);
    let visitorId = "";
    try { visitorId = db.create("Door", null, { visitor: true }).id; } finally { db.close(); }
    const visitor = await executeOwnToolAsync(f.root, "sam", "sam_brief", {}, undefined, visitorId) as { error?: string };
    assert.match(visitor.error ?? "", /[Vv]isitors cannot/);
    const core = await executeOwnToolAsync(f.root, "sam", "sam_brief", {}) as { text?: string; sections?: unknown[] };
    assert.match(core.text ?? "", /^Morning brief - /);
    assert.equal(core.sections?.length, 5);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
