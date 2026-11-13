import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listActions, proposeAction } from "./actions.js";
import { readActivity, recordActivity } from "./activity.js";
import { addChannel } from "./channels.js";
import { setCodeRoot } from "./code.js";
import { listCodingTasks, updateCodingTask } from "./coding.js";
import { runSelfAudit } from "./self-audit.js";
import {
  SELF_WORK_PROTECTED_FILES, advanceSelfWork, buildSelfWorkSpec, classifyDefect, installSelfWork,
  listSelfWorkFixes, queueSelfWorkFix, rankDefects, readSelfWork, reconcileSelfWorkFixes,
  runSelfWork, selfWorkFixSpecText, selfWorkFixViews, selfWorkStatus, selfWorkText,
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

test("self-work: known defects seed beside the ledger at count 1 - real classes outrank them, a quiet ledger specs one", () => {
  const root = fresh();
  const codeRoot = fresh();
  try {
    seedLedger(root);
    writeFileSync(join(codeRoot, "package.json"), JSON.stringify({ name: "x", scripts: { build: "true", test: "true" } }));
    setCodeRoot(root, codeRoot);
    runSelfAudit(root, {});
    const ranked = rankDefects(root);
    const known = ranked.find(r => r.key === "known:engine-binary-symlink");
    assert.ok(known);
    assert.equal(known.count, 1);
    assert.equal(known.source, "known");
    assert.equal(ranked[ranked.length - 1].key, "known:engine-binary-symlink");
    assert.equal(ranked[0].source, "ledger");
    // A single fresh ledger class (count 1, seen today) still
    // outranks the seeded defect (count 1, recorded 2026-11-11).
    const root2 = fresh();
    try {
      recordActivity(root2, "dip", "tool-budget", "Tool budget exhausted: 6/6 calls used");
      const ranked2 = rankDefects(root2);
      assert.equal(ranked2[0].key, "tool-budget");
      assert.equal(ranked2[1].key, "known:engine-binary-symlink");
    } finally { rmSync(root2, { recursive: true, force: true }); }
    // A quiet ledger: the known defect is the spec, with its
    // own template - the guard tension named, never hidden.
    const root3 = fresh();
    const codeRoot3 = fresh();
    try {
      writeFileSync(join(codeRoot3, "package.json"), JSON.stringify({ name: "x", scripts: { build: "true", test: "true" } }));
      setCodeRoot(root3, codeRoot3);
      runSelfAudit(root3, {});
      const run = buildSelfWorkSpec(root3);
      assert.ok(run.spec);
      assert.equal(run.spec.defectKey, "known:engine-binary-symlink");
      assert.equal(run.spec.source, "known");
      assert.deepEqual(run.spec.files, ["engine.ts", "engine-connect.ts"]);
      assert.equal(run.spec.ownerOnly, false);
      assert.equal(run.spec.blockedBy, null);
      assert.match(run.spec.endGoal, /symlink/);
      assert.ok(run.spec.notDone.some(d => /win-path guard/.test(d)));
      assert.match(selfWorkFixSpecText(run.spec), /known defect seeded beside the ledger/);
    } finally { rmSync(root3, { recursive: true, force: true }); rmSync(codeRoot3, { recursive: true, force: true }); }
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

test("self-work: a run records through the store, ledgers counts only, and an empty ledger specs the seeded known defect", () => {
  const root = fresh();
  try {
    const empty = runSelfWork(root);
    assert.ok(empty.spec);
    assert.equal(empty.spec.defectKey, "known:engine-binary-symlink");
    assert.equal(empty.spec.source, "known");
    assert.equal(empty.ranked.length, 1);
    assert.equal(empty.ranked[0].source, "known");
    assert.match(selfWorkText(empty), /known defect, seeded/);
    assert.match(selfWorkText(empty), /Source: the known-defect registry/);
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

test("self-work: an unchanged top class reuses its spec id across runs; growth mints a fresh one", () => {
  const root = fresh();
  const codeRoot = fresh();
  try {
    seedLedger(root);
    writeFileSync(join(codeRoot, "package.json"), JSON.stringify({ name: "x", scripts: { build: "true", test: "true" } }));
    setCodeRoot(root, codeRoot);
    runSelfAudit(root, {});
    const first = runSelfWork(root);
    assert.ok(first.spec);
    const second = runSelfWork(root);
    assert.ok(second.spec);
    // Same key, same count, same last sighting: the SAME spec,
    // re-issued - not a new record the bridge could queue again.
    assert.equal(second.spec.id, first.spec.id);
    assert.equal(second.spec.defectKey, "tool-budget");
    assert.equal(second.spec.count, 3);
    // Growth: one more occurrence of the top class mints a
    // fresh spec at the new count, speccable exactly once more.
    recordActivity(root, "dip", "tool-budget", "Tool budget exhausted: 6/6 calls used (sam_read_skill)");
    const third = runSelfWork(root);
    assert.ok(third.spec);
    assert.notEqual(third.spec.id, first.spec.id);
    assert.equal(third.spec.count, 4);
    const fourth = runSelfWork(root);
    assert.ok(fourth.spec);
    assert.equal(fourth.spec.id, third.spec.id);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(codeRoot, { recursive: true, force: true }); }
});

test("self-work: a reused spec's block is rebuilt fresh - a code root designated since unblocks the same spec", () => {
  const root = fresh();
  const codeRoot = fresh();
  try {
    seedLedger(root);
    runSelfAudit(root, {});
    const blocked = runSelfWork(root);
    assert.ok(blocked.spec);
    assert.match(blocked.spec.blockedBy ?? "", /no designated code root/);
    writeFileSync(join(codeRoot, "package.json"), JSON.stringify({ name: "x", scripts: { build: "true", test: "true" } }));
    setCodeRoot(root, codeRoot);
    runSelfAudit(root, {});
    const cleared = runSelfWork(root);
    assert.ok(cleared.spec);
    assert.equal(cleared.spec.id, blocked.spec.id);
    assert.equal(cleared.spec.blockedBy, null);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(codeRoot, { recursive: true, force: true }); }
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

// SELF-WORK step 2: the work bridge. The recorded spec - and
// only the recorded spec - queues as a coding task; an
// owner-only spec (the hard boundary) and a blocked spec
// refuse; one fix flies at a time; a done fix's branch lands
// only as a git-push proposal on the ONE gate; and every
// terminal fix earns exactly one digest line.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

function workableRoot(): { root: string; codeRootDir: string } {
  const root = fresh();
  const codeRootDir = fresh();
  seedLedger(root);
  writeFileSync(join(codeRootDir, "package.json"), JSON.stringify({ name: "x", scripts: { build: "true", test: "true" } }));
  setCodeRoot(root, codeRootDir);
  runSelfAudit(root, {});
  runSelfWork(root);
  return { root, codeRootDir };
}

test("self-work work: queue refuses with no recorded run, an owner-only spec, and a blocked spec - and queues nothing", () => {
  const root = fresh();
  try {
    assert.throws(() => queueSelfWorkFix(root), /No self-work spec has been recorded/);
    assert.deepEqual(listSelfWorkFixes(root), []);
    // Owner-only: the gate-executor class, whose likely file is protected.
    runSelfAudit(root, {});
    recordActivity(root, "sam", "failed", "heartbeat: Invalid profile 'Second Shift'");
    recordActivity(root, "sam", "failed", "heartbeat: Invalid profile 'Second Shift'");
    runSelfWork(root);
    assert.throws(() => queueSelfWorkFix(root), /OWNER-ONLY/);
    assert.deepEqual(listCodingTasks(root), []);
    assert.deepEqual(listSelfWorkFixes(root), []);
    // Blocked: a hands spec whose audit reads no code root.
    const root2 = fresh();
    try {
      runSelfAudit(root2, {});
      recordActivity(root2, "dip", "tool-budget", "Tool budget exhausted: 6/6 calls used");
      runSelfWork(root2);
      assert.throws(() => queueSelfWorkFix(root2), /is blocked: .*no designated code root/);
      assert.deepEqual(listCodingTasks(root2), []);
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-work work: a workable spec queues a coding task carrying the three-part spec; one fix flies at a time", () => {
  const { root, codeRootDir } = workableRoot();
  try {
    const fix = queueSelfWorkFix(root);
    assert.equal(fix.defectKey, "tool-budget");
    assert.equal(fix.proposalId, null);
    assert.equal(fix.digest, null);
    const tasks = listCodingTasks(root);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, fix.taskId);
    assert.equal(tasks[0].chatId, fix.chatId);
    assert.equal(tasks[0].status, "queued");
    assert.match(tasks[0].spec, /End goal:/);
    assert.match(tasks[0].spec, /Done looks like:/);
    assert.match(tasks[0].spec, /Not done:/);
    assert.match(tasks[0].spec, /src\/budgets\.ts/);
    assert.match(tasks[0].spec, /never push/);
    const queuedLines = readActivity(root, 100).filter(l => l.kind === "self-work-fix");
    assert.equal(queuedLines.length, 1);
    assert.match(queuedLines[0].summary, /fix queued/);
    // A second queue refuses (already worked / in flight), and an
    // advance names the in-flight fix instead of queueing another.
    assert.throws(() => queueSelfWorkFix(root), /already in flight/);
    const adv = advanceSelfWork(root);
    assert.equal(adv.queued, null);
    assert.match(adv.queueNote ?? "", /already in flight/);
    assert.equal(adv.fixes.length, 1);
    assert.equal(adv.fixes[0].digest, null);
    // Reconcile leaves an in-flight task exactly as it is.
    const after = reconcileSelfWorkFixes(root);
    assert.equal(after[0].digest, null);
    assert.deepEqual(listActions(root), []);
    const views = selfWorkFixViews(root);
    assert.equal(views[0].taskStatus, "queued");
    assert.equal(selfWorkStatus(root).fixes.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(codeRootDir, { recursive: true, force: true }); }
});

test("self-work work: a done fix on a branch earns its git-push proposal and exactly one digest; an existing proposal is adopted", () => {
  const root = fresh();
  const repo = fresh();
  const origin = fresh();
  try {
    seedLedger(root);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { build: "true", test: "true" } }));
    git(repo, "add", "package.json");
    git(repo, "commit", "-qm", "init");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    git(repo, "remote", "add", "origin", origin);
    const branch = "sam/selfwork-fix-07372cda";
    git(repo, "branch", branch);
    setCodeRoot(root, repo);
    runSelfAudit(root, {});
    runSelfWork(root);
    const fix = queueSelfWorkFix(root);
    // The owner (or a manual coding push) already proposed this
    // branch: reconcile must adopt that card, never duplicate it.
    const manual = proposeAction(root, { actor: "sam", kind: "git-push", title: "Push " + branch, detail: JSON.stringify({ branch }), chatId: fix.chatId });
    const sha = git(repo, "rev-parse", "main");
    updateCodingTask(root, fix.taskId, {
      status: "done", verification: "verified",
      changes: [{ path: "src/budgets.ts", created: false, addedLines: 4, removedLines: 1 }],
      git: { mode: "branch", branch, baseSha: sha, commits: [{ sha, iteration: 1, paths: ["src/budgets.ts"], at: new Date().toISOString() }], pending: [], error: null },
    });
    const fixes = reconcileSelfWorkFixes(root);
    assert.equal(fixes.length, 1);
    assert.equal(fixes[0].proposalId, manual.id);
    const proposals = listActions(root).filter(a => a.kind === "git-push");
    assert.equal(proposals.length, 1);
    assert.ok(fixes[0].digest);
    assert.match(fixes[0].digest, /Self-fix .* \(tool-budget x3\): done - 1 file\(s\) changed on sam\/selfwork-fix-07372cda, 1 local commit\(s\); git-push proposal/);
    assert.match(fixes[0].digest, /waits on the owner's approval - nothing lands without it/);
    const digestLines = readActivity(root, 100).filter(l => l.kind === "self-work-fix" && /Self-fix/.test(l.summary));
    assert.equal(digestLines.length, 1);
    // A second reconcile changes nothing: same digest, still one proposal.
    const again = reconcileSelfWorkFixes(root);
    assert.equal(again[0].digest, fixes[0].digest);
    assert.equal(listActions(root).filter(a => a.kind === "git-push").length, 1);
    // The run text and the status carry the digest line.
    const run = readSelfWork(root);
    assert.ok(run);
    assert.match(selfWorkText(run, { fixes: selfWorkFixViews(root) }), /Self-fix .*tool-budget/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); rmSync(origin, { recursive: true, force: true }); }
});

test("self-work work: a worked spec stays worked across later runs until its class recurs", () => {
  const { root, codeRootDir } = workableRoot();
  try {
    const fix = queueSelfWorkFix(root);
    updateCodingTask(root, fix.taskId, { status: "blocked", result: "Iterations exhausted with the work unverified." });
    reconcileSelfWorkFixes(root);
    // The daily loop runs again over an unchanged ledger: the
    // spec is re-issued under the same id, and the bridge
    // refuses it as already worked instead of queueing a twin.
    const rerun = runSelfWork(root);
    assert.ok(rerun.spec);
    assert.equal(rerun.spec.id, fix.specId);
    assert.throws(() => queueSelfWorkFix(root), /already has a fix record/);
    assert.equal(listCodingTasks(root).length, 1);
    // The class recurs past its specced count: a fresh spec
    // mints and queues as new work.
    recordActivity(root, "dip", "tool-budget", "Tool budget exhausted: 6/6 calls used (sam_read_skill)");
    const grown = runSelfWork(root);
    assert.ok(grown.spec);
    assert.notEqual(grown.spec.id, fix.specId);
    const fix2 = queueSelfWorkFix(root);
    assert.equal(fix2.specId, grown.spec.id);
    assert.equal(listCodingTasks(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(codeRootDir, { recursive: true, force: true }); }
});

test("self-work work: a blocked fix earns a digest naming the block and no proposal is created", () => {
  const { root, codeRootDir } = workableRoot();
  try {
    const fix = queueSelfWorkFix(root);
    updateCodingTask(root, fix.taskId, { status: "blocked", result: "Iterations exhausted with the work unverified - the changes are in the code root but are NOT verified." });
    const fixes = reconcileSelfWorkFixes(root);
    assert.equal(fixes[0].proposalId, null);
    assert.ok(fixes[0].digest);
    assert.match(fixes[0].digest, /: blocked - Iterations exhausted/);
    assert.deepEqual(listActions(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(codeRootDir, { recursive: true, force: true }); }
});
