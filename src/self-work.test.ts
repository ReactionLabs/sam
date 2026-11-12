import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { addChannel } from "./channels.js";
import { setCodeRoot } from "./code.js";
import { runSelfAudit } from "./self-audit.js";
import {
  SELF_WORK_PROTECTED_FILES, buildSelfWorkSpec, classifyDefect, installSelfWork,
  rankDefects, readSelfWork, runSelfWork, selfWorkStatus, selfWorkText,
} from "./self-work.js";

// SELF-WORK step 1: the spec picker. The ledger is the defect
// queue - ranking is deterministic (count, then most recent,
// then key), the spec is the fleet three-part shape grounded in
// the recorded self-audit, a spec touching the gate/policy/
// allowlist machinery is stamped owner-only, a spec whose fix
// needs a code root the audit cannot see is stamped blocked,
// and a run records to the one-row SQLite store with one
// counts-only ledger line. A pure read creates nothing.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-self-work-")); }

function seedLedger(root: string): void {
  recordActivity(root, "trading", "tool-budget", "Tool budget exhausted: 6/6 calls used (sam_load_tools); not executed: mcp_stack_health");
  recordActivity(root, "trading", "tool-budget", "Turn step limit reached: 1 calls used (sam_load_tools) - the call budget (4) was NOT reached");
  recordActivity(root, "dip", "tool-budget", "Tool budget exhausted: 5/6 calls used (sam_read_skill)");
  recordActivity(root, "trading", "heartbeat-failed", "Heartbeat 'stack watch' failed: Unsafe model output");
  recordActivity(root, "trading", "heartbeat-failed", "Heartbeat 'stack watch' failed: Model connector request timed out");
  recordActivity(root, "sam", "turn", "Answered in chat abc");
  recordActivity(root, "sam", "proposal", "Proposed law: something");
}

test("self-work: classification is deterministic - kind first, then the summary's own shape", () => {
  const line = (kind: string, summary: string) => ({ at: "2026-11-12T00:00:00.000Z", actor: "sam", kind, summary });
  assert.equal(classifyDefect(line("tool-budget", "Turn step limit reached: 1 calls"))?.key, "tool-budget");
  assert.equal(classifyDefect(line("turn-failed", "Turn failed in chat abcdefgh (chat): Unsafe model output"))?.key, "turn-failed:unsafe-output");
  assert.equal(classifyDefect(line("turn-failed", "Turn failed in chat abcdefgh (chat): Empty model response"))?.key, "turn-failed:empty-response");
  assert.equal(classifyDefect(line("turn-failed", "Turn failed in chat abcdefgh (chat): Model connector request timed out"))?.key, "turn-failed:timeout");
  assert.equal(classifyDefect(line("heartbeat-failed", "Heartbeat 'stack watch' failed: x"))?.key, "heartbeat-failed:stack-watch");
  assert.equal(classifyDefect(line("failed", "skill: Install x skill - HTTP 404"))?.key, "skill-install-failure");
  assert.equal(classifyDefect(line("failed", "heartbeat: Invalid profile"))?.key, "action-failed");
  assert.equal(classifyDefect(line("turn", "Answered in chat abc")), null);
  assert.equal(classifyDefect(line("stack-watch", "Stack watch (deterministic): ...")), null);
});

test("self-work: ranking counts the ledger and the top spec is the three-part shape for the top class", () => {
  const root = fresh();
  const codeRoot = fresh();
  try {
    seedLedger(root);
    writeFileSync(join(codeRoot, "package.json"), JSON.stringify({ name: "x", scripts: { build: "true", test: "true" } }));
    setCodeRoot(root, codeRoot);
    runSelfAudit(root, {});
    const ranked = rankDefects(root);
    assert.equal(ranked[0].key, "tool-budget");
    assert.equal(ranked[0].count, 3);
    assert.equal(ranked[1].key, "heartbeat-failed:stack-watch");
    assert.equal(ranked[1].count, 2);
    const run = buildSelfWorkSpec(root);
    assert.ok(run.spec);
    assert.equal(run.spec.defectKey, "tool-budget");
    assert.equal(run.spec.count, 3);
    assert.match(run.spec.endGoal, /tool budget/);
    assert.ok(run.spec.doneLooksLike.length >= 3);
    assert.ok(run.spec.notDone.some(d => /approval gate/.test(d)));
    assert.deepEqual(run.spec.files, ["budgets.ts", "own-tools.ts", "connector-chat.ts"]);
    assert.equal(run.spec.ownerOnly, false);
    assert.equal(run.spec.blockedBy, null);
    assert.ok(run.auditAt);
    // Building alone records nothing.
    assert.equal(readSelfWork(root), null);
    assert.equal(existsSync(join(root, ".sam", "self-work.db")), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(codeRoot, { recursive: true, force: true }); }
});

test("self-work: no audit recorded - the spec is stamped blocked naming step 0, never dressed as workable", () => {
  const root = fresh();
  try {
    seedLedger(root);
    const run = buildSelfWorkSpec(root);
    assert.ok(run.spec);
    assert.match(run.spec.blockedBy ?? "", /self-audit run/);
    assert.equal(run.auditAt, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-work: an audit with no code root blocks a hands spec; an owner-only class is stamped, never queued shape", () => {
  const root = fresh();
  try {
    runSelfAudit(root, {});
    recordActivity(root, "dip", "tool-budget", "Tool budget exhausted: 6/6 calls used");
    const run = buildSelfWorkSpec(root);
    assert.ok(run.spec);
    assert.match(run.spec.blockedBy ?? "", /no designated code root/);
    // The gate-executor class: its likely file is protected.
    const root2 = fresh();
    try {
      runSelfAudit(root2, {});
      recordActivity(root2, "sam", "failed", "heartbeat: Invalid profile 'Second Shift'");
      recordActivity(root2, "sam", "failed", "heartbeat: Invalid profile 'Second Shift'");
      const run2 = buildSelfWorkSpec(root2);
      assert.ok(run2.spec);
      assert.equal(run2.spec.defectKey, "action-failed");
      assert.equal(run2.spec.ownerOnly, true);
      assert.ok(SELF_WORK_PROTECTED_FILES.includes("actions.ts"));
      assert.ok(run2.spec.files.includes("actions.ts"));
      const text = selfWorkText(run2);
      assert.match(text, /OWNER-ONLY/);
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-work: a run records through the store, ledgers counts only, and an empty ledger specs nothing", () => {
  const root = fresh();
  try {
    const empty = runSelfWork(root);
    assert.equal(empty.spec, null);
    assert.deepEqual(empty.ranked, []);
    assert.match(selfWorkText(empty), /No ledgered defect classes/);
    assert.deepEqual(readSelfWork(root), empty);
    seedLedger(root);
    const run = runSelfWork(root);
    assert.ok(run.spec);
    assert.deepEqual(readSelfWork(root), run);
    assert.equal(existsSync(join(root, ".sam", "self-work.db")), true);
    assert.equal(existsSync(join(root, ".sam", "self-work.json")), false);
    const lines = readActivity(root, 50).filter(l => l.kind === "self-work");
    assert.equal(lines.length, 2);
    assert.match(lines[1].summary, /tool-budget x3/);
    const text = selfWorkText(run);
    assert.match(text, /Defect queue/);
    assert.match(text, /End goal:/);
    assert.match(text, /Done looks like:/);
    assert.match(text, /Not done:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-work: a legacy self-work.json imports once and is renamed; a malformed one imports nothing and stays", () => {
  const root = fresh();
  try {
    seedLedger(root);
    const legacy = buildSelfWorkSpec(root, null, new Date("2026-11-12T00:00:00.000Z"));
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "self-work.json"), JSON.stringify(legacy));
    assert.deepEqual(readSelfWork(root), legacy);
    assert.equal(existsSync(join(root, ".sam", "self-work.json")), false);
    assert.equal(existsSync(join(root, ".sam", "self-work.json.migrated")), true);
    const root2 = fresh();
    try {
      mkdirSync(join(root2, ".sam"), { recursive: true });
      writeFileSync(join(root2, ".sam", "self-work.json"), "{ not json");
      assert.equal(readSelfWork(root2), null);
      assert.equal(readFileSync(join(root2, ".sam", "self-work.json"), "utf8"), "{ not json");
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-work: install creates the one standing script job, refuses a second, and refuses an unknown channel", () => {
  const root = fresh();
  try {
    assert.equal(selfWorkStatus(root).installed, false);
    assert.throws(() => installSelfWork(root, { channelId: "nope" }), /Unknown channel/);
    const channel = addChannel(root, "telegram", "SAM Telegram", "dip", "SAM_CHANNEL_TG_TEST");
    const job = installSelfWork(root, { channelId: channel.id });
    assert.equal(job.name, "self-work");
    assert.equal(job.mode, "script");
    assert.equal(job.script, "sam-self-work");
    assert.equal(job.profile, "sam");
    assert.equal(job.channelId, channel.id);
    assert.equal(job.timezone, "America/New_York");
    assert.equal(selfWorkStatus(root).installed, true);
    assert.throws(() => installSelfWork(root), /already installed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-work: a pure read on an empty install creates nothing, not even the state directory", () => {
  const root = fresh();
  try {
    assert.equal(readSelfWork(root), null);
    assert.equal(selfWorkStatus(root).lastRun, null);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
