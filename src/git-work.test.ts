import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { setCodeRoot, writeCodeFile } from "./code.js";
import { recordVerification } from "./verification.js";
import { drainCodingTasks, listCodingTasks, queueCodingTask } from "./coding.js";
import { commitTaskPaths, isTaskBranch, listTaskBranches, prepareTaskBranch, pushBranch, taskBranchName, validateGitPushDetail } from "./git-work.js";
import { decideAction, listActions, proposeAction } from "./actions.js";
import { classifyProposal, saveApprovalPolicy } from "./approval-policy.js";
import { readActivity } from "./activity.js";

// Phase D item 5 (coder C4): git discipline. Fixtures use REAL git
// in temp dirs - the discipline is git's behavior (branches,
// staging, commits, a bare origin), so a fake would test nothing.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

function fixture(gitInit: boolean) {
  const base = mkdtempSync(join(tmpdir(), "sam-gitwork-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "tsc -p .", test: "node --test" } }));
  writeFileSync(join(proj, "tracked.txt"), "original\n");
  if (gitInit) {
    git(proj, "init", "-q");
    git(proj, "add", "package.json", "tracked.txt");
    git(proj, "commit", "-q", "-m", "initial");
  }
  const db = new ChatStore(sam);
  let chatId: string;
  try { chatId = db.create("Desk", "trading").id; } finally { db.close(); }
  setCodeRoot(sam, proj);
  return { base, sam, proj, chatId };
}

test("branch names: sam/<slug>-<id8>, deterministic, and only that shape ever passes", () => {
  const name = taskBranchName({ id: "12345678-abcd-ef00", title: "Add a Hello File!" });
  assert.equal(name, "sam/add-a-hello-file-12345678");
  assert.equal(taskBranchName({ id: "12345678-abcd-ef00", title: "Add a Hello File!" }), name);
  assert.ok(isTaskBranch(name));
  assert.ok(!isTaskBranch("main"));
  assert.ok(!isTaskBranch("master"));
  assert.ok(!isTaskBranch("sam/"));
  assert.ok(!isTaskBranch("feature/sam/x"));
  assert.ok(!isTaskBranch("sam/Add_Caps"));
});

test("prepare: a non-git code root records mode none - no branch is faked", () => {
  const { base, sam } = fixture(false);
  try {
    const state = prepareTaskBranch(sam, { id: "aaaaaaaa-1", title: "Anything" });
    assert.equal(state.mode, "none");
    assert.equal(state.branch, null);
    assert.deepEqual(listTaskBranches(sam), { repo: null, current: null, branches: [] });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("prepare: a clean repo gets its task branch at HEAD; a dirty tree and an unborn HEAD refuse", () => {
  const { base, sam, proj } = fixture(true);
  try {
    const head = git(proj, "rev-parse", "HEAD");
    const state = prepareTaskBranch(sam, { id: "bbbbbbbb-2", title: "Clean work" });
    assert.equal(state.mode, "branch");
    assert.equal(state.branch, "sam/clean-work-bbbbbbbb");
    assert.equal(state.baseSha, head);
    assert.equal(git(proj, "branch", "--show-current"), state.branch);
    // Resuming the same task reuses its branch.
    const again = prepareTaskBranch(sam, { id: "bbbbbbbb-2", title: "Clean work" });
    assert.equal(again.mode, "branch");
    // A dirty tree refuses a NEW task: the owner's uncommitted work
    // is never swept into a task branch.
    writeFileSync(join(proj, "owner-draft.txt"), "not sam's\n");
    const refused = prepareTaskBranch(sam, { id: "cccccccc-3", title: "Other work" });
    assert.equal(refused.mode, "refused");
    assert.match(refused.error ?? "", /uncommitted changes/);
    assert.equal(git(proj, "branch", "--show-current"), state.branch);
  } finally { rmSync(base, { recursive: true, force: true }); }

  const bare = mkdtempSync(join(tmpdir(), "sam-gitwork-unborn-"));
  try {
    const sam2 = join(bare, "home"); const proj2 = join(bare, "proj");
    mkdirSync(sam2, { recursive: true }); mkdirSync(proj2, { recursive: true });
    git(proj2, "init", "-q");
    setCodeRoot(sam2, proj2);
    const unborn = prepareTaskBranch(sam2, { id: "dddddddd-4", title: "Too early" });
    assert.equal(unborn.mode, "refused");
    assert.match(unborn.error ?? "", /no commits yet/);
  } finally { rmSync(bare, { recursive: true, force: true }); }
});

test("commit: exactly the named paths land on the task branch; a stranger file in the tree is never swept in", () => {
  const { base, sam, proj } = fixture(true);
  try {
    const state = prepareTaskBranch(sam, { id: "eeeeeeee-5", title: "Commit work" });
    assert.equal(state.mode, "branch");
    writeFileSync(join(proj, "src-new.ts"), "export const a = 1;\n");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "hello.ts"), "export const hi = 'hello';\n");
    writeFileSync(join(proj, "owner-mid-task.txt"), "dropped in mid-task\n");
    state.pending = ["src-new.ts", "src/hello.ts"];
    const record = commitTaskPaths(sam, state, [...state.pending], 1, "Commit work");
    assert.ok(record);
    assert.deepEqual(record.paths.sort(), ["src-new.ts", "src/hello.ts"]);
    assert.deepEqual(state.pending, []);
    assert.equal(state.commits.length, 1);
    const log = git(proj, "log", "--oneline", "-1");
    assert.match(log, /sam: Commit work \(iteration 1\)/);
    assert.equal(git(proj, "status", "--porcelain"), "?? owner-mid-task.txt");
    assert.equal(git(proj, "show", "HEAD:src/hello.ts"), "export const hi = 'hello';");
    // A path whose content already matches HEAD stages nothing and
    // counts as covered - no empty commit is created.
    state.pending = ["tracked.txt"];
    const noop = commitTaskPaths(sam, state, ["tracked.txt"], 2, "Commit work");
    assert.equal(noop, null);
    assert.deepEqual(state.pending, []);
    assert.equal(state.commits.length, 1);
    assert.ok(readActivity(sam).some(a => a.kind === "coding-commit"));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

function stubTurn(sam: string, work: () => void) {
  return async (chatId: string, _content: string) => {
    const db = new ChatStore(sam);
    try { db.add(chatId, "user", "work"); } finally { db.close(); }
    work();
    const db2 = new ChatStore(sam);
    try { db2.add(chatId, "assistant", "done"); } finally { db2.close(); }
    return "done";
  };
}
function verifyPass(sam: string) {
  recordVerification(sam, { kind: "build", passed: true, runId: "b-" + Math.random() });
  recordVerification(sam, { kind: "test", passed: true, runId: "t-" + Math.random() });
}
function chatTexts(sam: string, chatId: string): string[] {
  const db = new ChatStore(sam);
  try { return db.messages(chatId).map(m => m.content); } finally { db.close(); }
}

test("the loop: verified work closes done ON its sam/<task> branch with the iteration's writes committed", async () => {
  const { base, sam, proj, chatId } = fixture(true);
  try {
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Create src/hello.ts exporting a greeting" });
    const runTurn = stubTurn(sam, () => { writeCodeFile(sam, "trading", "src/hello.ts", "export const hi = 'hello';\n"); verifyPass(sam); });
    const out = await drainCodingTasks(sam, { runTurn });
    assert.deepEqual(out.ran, [task.id]);
    const done = listCodingTasks(sam)[0];
    assert.equal(done.status, "done");
    assert.equal(done.git?.mode, "branch");
    assert.match(done.git?.branch ?? "", /^sam\/create-src-hello-ts-exporting-a-greeti/);
    assert.equal(done.git?.commits.length, 1);
    assert.deepEqual(done.git?.pending, []);
    assert.equal(git(proj, "branch", "--show-current"), done.git?.branch);
    assert.equal(git(proj, "show", "HEAD:src/hello.ts"), "export const hi = 'hello';");
    assert.equal(git(proj, "status", "--porcelain"), "");
    const texts = chatTexts(sam, chatId);
    assert.match(texts[texts.length - 1], /Git: branch sam\//);
    assert.match(texts[texts.length - 1], /not pushed/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the loop: a tree dirty before the task starts blocks it - no turn runs, nothing is committed or swept", async () => {
  const { base, sam, proj, chatId } = fixture(true);
  try {
    writeFileSync(join(proj, "owner-wip.txt"), "the owner's half-done work\n");
    const branchBefore = git(proj, "branch", "--show-current");
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Create src/hello.ts" });
    let turns = 0;
    const out = await drainCodingTasks(sam, { runTurn: async () => { turns += 1; return "x"; } });
    assert.equal(turns, 0);
    assert.deepEqual(out.blocked, [task.id]);
    const blocked = listCodingTasks(sam)[0];
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.git?.mode, "refused");
    assert.match(blocked.result ?? "", /uncommitted changes/);
    assert.equal(git(proj, "branch", "--show-current"), branchBefore);
    assert.ok(!branchBefore.startsWith("sam/"));
    assert.equal(git(proj, "status", "--porcelain"), "?? owner-wip.txt");
    const texts = chatTexts(sam, chatId);
    assert.match(texts[texts.length - 1], /Coding task blocked \(not done\)/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("git-push gate: only an existing sam/* branch with an origin can be proposed; approval pushes it, and smart mode can never auto it", async () => {
  const { base, sam, proj, chatId } = fixture(true);
  try {
    const origin = join(base, "origin.git");
    execFileSync("git", ["init", "--bare", "-q", origin]);
    git(proj, "remote", "add", "origin", origin);
    const task = queueCodingTask(sam, { actor: "trading", chatId, spec: "Create src/hello.ts exporting a greeting" });
    const runTurn = stubTurn(sam, () => { writeCodeFile(sam, "trading", "src/hello.ts", "export const hi = 'hello';\n"); verifyPass(sam); });
    await drainCodingTasks(sam, { runTurn });
    const branch = listCodingTasks(sam)[0].git?.branch as string;
    assert.ok(branch);

    // Proposal-time validation: main, a missing branch, and junk all refuse.
    assert.throws(() => proposeAction(sam, { actor: "trading", kind: "git-push", title: "Push main", detail: JSON.stringify({ branch: "main" }) }), /only a sam\/<task> branch/);
    assert.throws(() => proposeAction(sam, { actor: "trading", kind: "git-push", title: "Push ghost", detail: JSON.stringify({ branch: "sam/ghost-00000000" }) }), /does not exist/);
    assert.throws(() => validateGitPushDetail(sam, "not json"), /expected JSON/);
    // Consequential classification: smart mode refuses the kind at set time.
    assert.equal(classifyProposal("git-push", null).risk, "consequential");
    assert.throws(() => saveApprovalPolicy(sam, { mode: "smart", autoKinds: ["git-push"] }), /cannot auto-approve consequential/);
    // pushBranch itself refuses a non-task branch even if called directly.
    await assert.rejects(() => pushBranch(sam, "main"), /only a sam\/<task> branch/);

    const proposal = proposeAction(sam, { actor: "trading", kind: "git-push", title: "Push " + branch, detail: JSON.stringify({ branch }), chatId });
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.risk, "consequential");
    const decided = await decideAction(sam, proposal.id, true);
    assert.equal(decided.status, "done");
    assert.match(decided.result ?? "", /Pushed branch/);
    const remoteRef = execFileSync("git", ["--git-dir", origin, "rev-parse", "refs/heads/" + branch], { encoding: "utf8" }).trim();
    assert.equal(remoteRef, git(proj, "rev-parse", "HEAD"));
    assert.ok(readActivity(sam).some(a => a.kind === "git-push"));
    assert.ok(existsSync(join(proj, "src", "hello.ts")));
    assert.equal(listActions(sam).filter(a => a.kind === "git-push").length, 1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
