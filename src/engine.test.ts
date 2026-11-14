import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { codeWrites, setCodeRoot } from "./code.js";
import { verificationStatus } from "./verification.js";
import { defaultEngineRunner, drainEngineTasks, engineArgv, engineBinary, engineStatus, listEngineTasks, queueEngineTask, validateEngineDetail, type EngineTask } from "./engine.js";
import { installFakeEngine } from "./fake-engine.js";
import { decideAction, listActions, proposeAction } from "./actions.js";
import { classifyProposal, saveApprovalPolicy } from "./approval-policy.js";
import type { GoldfishRecord } from "./goldfish.js";

// Phase D item 6 (coder C6): the managed coding-engine runtime.
// Fixtures use REAL git and a REAL fake engine binary (a Node
// script SAM_ENGINE_BIN points at; on win32 that path is a .cmd
// shim that launches the same script), so the fixed-argv spawn,
// the branch sandbox, the change recording, and the commit are
// all exercised as behavior, not as mocks of themselves. The
// drain's verify step runs the fixture's real npm scripts through C2.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

const PASS_REVIEW: GoldfishRecord = { verdict: "PASS", summary: "clean", findings: [], at: new Date().toISOString(), spec: "s", model: "stub", changeCount: 1, changeHashes: [], malformed: false };

function fixture(opts: { gitInit?: boolean; testScript?: string } = {}) {
  const base = mkdtempSync(join(tmpdir(), "sam-engine-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  const binDir = join(base, "bin");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "node -e \"process.exit(0)\"", test: opts.testScript ?? "node -e \"process.exit(0)\"" } }));
  writeFileSync(join(proj, "tracked.txt"), "original\n");
  if (opts.gitInit !== false) {
    git(proj, "init", "-q");
    git(proj, "add", "package.json", "tracked.txt");
    git(proj, "commit", "-q", "-m", "initial");
  }
  // The fake engine: ignores its argv, runs the Node work file the
  // test staged (engine-work.mjs), and exits 0. Windows cannot exec
  // a shell script, so the entrypoint is a .cmd shim there.
  const fake = installFakeEngine(binDir, { workFile: join(base, "engine-work.mjs"), projectDir: proj });
  const db = new ChatStore(sam);
  let chatId: string;
  try { chatId = db.create("Desk", "trading").id; } finally { db.close(); }
  setCodeRoot(sam, proj);
  const prev = process.env.SAM_ENGINE_BIN;
  process.env.SAM_ENGINE_BIN = fake;
  return {
    base, sam, proj, chatId, fake,
    cleanup() {
      if (prev === undefined) delete process.env.SAM_ENGINE_BIN; else process.env.SAM_ENGINE_BIN = prev;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function engineScript(f: { base: string }, body: string) {
  writeFileSync(join(f.base, "engine-work.mjs"), body);
}

test("the default runner closes the child's stdin: a stdin-reading engine gets EOF at spawn, not a timeout", async () => {
  // Regression for the 2026-11-14 live defect: execFile leaves the
  // child's stdin pipe open, and `codex exec` reads stdin to EOF
  // before starting on its argv prompt, so every real Codex run
  // hung to its timeout. The runner now ends stdin at spawn; a
  // child that reads stdin to end must complete immediately.
  const script = "let n=0; process.stdin.on('data', c => { n += c.length; }); process.stdin.on('end', () => { console.log('eof-after-' + n); });";
  const outcome = await defaultEngineRunner(process.execPath, ["-e", script], process.cwd(), 10_000);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.output, /eof-after-0/);
});

test("binary resolution: SAM_ENGINE_BIN wins, a missing binary reads not-installed cleanly", () => {
  const f = fixture();
  try {
    assert.equal(engineBinary({ SAM_ENGINE_BIN: f.fake, PATH: "" }), f.fake);
    assert.equal(engineBinary({ PATH: "/nonexistent-dir" }), null);
    assert.equal(engineBinary({ SAM_ENGINE_BIN: "/nonexistent/claude", PATH: "/nonexistent-dir" }), null);
    const status = engineStatus(f.sam, { PATH: "/nonexistent-dir" });
    assert.equal(status.installed, false);
    assert.equal(status.binary, null);
    assert.equal(engineStatus(f.sam).installed, true);
  } finally { f.cleanup(); }
});

test("proposal validation refuses what cannot execute: non-git root and no engine name their fixes", () => {
  const f = fixture({ gitInit: false });
  try {
    assert.throws(() => validateEngineDetail(f.sam, JSON.stringify({ task: "do it" })), /not a git repository/);
    assert.throws(() => queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "do it" }), /not a git repository/);
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    assert.throws(() => validateEngineDetail(g.sam, JSON.stringify({ task: "do it" }), { PATH: "/nonexistent-dir" }), /not installed/);
    assert.throws(() => validateEngineDetail(g.sam, JSON.stringify({ task: "" })), /Invalid engine task/);
    assert.throws(() => validateEngineDetail(g.sam, "not json"), /expected JSON/);
    assert.deepEqual(validateEngineDetail(g.sam, JSON.stringify({ task: "do it" })), { task: "do it", chatId: null, provider: "claude-code" });
  } finally { g.cleanup(); }
});

test("the gate: engine is consequential (smart can never auto it), approval queues the run", async () => {
  const f = fixture();
  try {
    assert.equal(classifyProposal("engine", null).risk, "consequential");
    assert.throws(() => saveApprovalPolicy(f.sam, { mode: "smart", autoKinds: ["engine"] }), /cannot auto-approve consequential/);
    const p = proposeAction(f.sam, { actor: "trading", kind: "engine", title: "Engine: add hello", detail: JSON.stringify({ task: "Add a hello file" }), chatId: f.chatId });
    assert.equal(p.status, "pending");
    assert.equal(listEngineTasks(f.sam).length, 0);
    const decided = await decideAction(f.sam, p.id, true);
    assert.equal(decided.status, "done");
    assert.match(decided.result ?? "", /Engine run queued/);
    const tasks = listEngineTasks(f.sam);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, "queued");
    assert.equal(tasks[0].spec, "Add a hello file");
    // A proposal with no chat anywhere refuses at proposal time.
    assert.throws(() => proposeAction(f.sam, { actor: "trading", kind: "engine", title: "No chat", detail: JSON.stringify({ task: "x" }) }), /needs a chat/);
    assert.equal(listActions(f.sam).filter(a => a.kind === "engine").length, 1);
  } finally { f.cleanup(); }
});

test("happy path: the engine runs in the branch sandbox; SAM records, verifies, reviews, and commits its work", async () => {
  const f = fixture();
  try {
    engineScript(f, "import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst proj = process.argv[2];\nwriteFileSync(join(proj, 'hello.txt'), 'hello from the engine\\n');\nwriteFileSync(join(proj, 'tracked.txt'), 'original\\nengine line\\n');\n");
    const task = queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Add hello.txt and extend tracked.txt" });
    const result = await drainEngineTasks(f.sam, { review: async () => PASS_REVIEW });
    assert.deepEqual(result.ran, [task.id]);
    const done = listEngineTasks(f.sam)[0];
    assert.equal(done.status, "done");
    assert.equal(done.verification, "verified");
    assert.match(done.review ?? "", /^PASS/);
    assert.deepEqual(done.changes.sort(), ["hello.txt", "tracked.txt"]);
    assert.equal(done.git?.mode, "branch");
    assert.match(done.git?.branch ?? "", /^sam\//);
    assert.equal(done.git?.commits.length, 1);
    assert.deepEqual(done.git?.pending, []);
    // The commit is real git state on the task branch.
    assert.equal(git(f.proj, "branch", "--show-current"), done.git?.branch);
    assert.match(git(f.proj, "log", "--oneline", "-1"), /sam: Add hello\.txt/);
    assert.match(git(f.proj, "show", "HEAD:hello.txt"), /hello from the engine/);
    assert.equal(git(f.proj, "status", "--porcelain"), "");
    // SAM's own ledgers carry the engine's changes exactly like C1 writes.
    const writes = codeWrites(f.sam, 50);
    assert.deepEqual(writes.map(w => w.path).sort(), ["hello.txt", "tracked.txt"]);
    assert.ok(existsSync(join(f.sam, ".sam", "changes", writes[0].afterHash + ".json")));
    assert.equal(verificationStatus(f.sam).state, "verified");
    // The summary posted back into the originating chat.
    const db = new ChatStore(f.sam);
    try {
      const messages = db.messages(f.chatId);
      const last = messages[messages.length - 1];
      assert.match(last.content, /Engine run done/);
      assert.match(last.content, /Self-review: PASS/);
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

test("an engine change outside the recordable shape (a protected .env) blocks the run, uncommitted", async () => {
  const f = fixture();
  try {
    engineScript(f, "import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst proj = process.argv[2];\nwriteFileSync(join(proj, '.env'), 'TOKEN=abc\\n');\nwriteFileSync(join(proj, 'hello.txt'), 'fine\\n');\n");
    queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Write config files" });
    const result = await drainEngineTasks(f.sam, { review: async () => PASS_REVIEW });
    assert.equal(result.blocked.length, 1);
    const blockedTask = listEngineTasks(f.sam)[0];
    assert.equal(blockedTask.status, "blocked");
    assert.ok(blockedTask.unreviewable.some(p => p.includes(".env")));
    assert.match(blockedTask.result ?? "", /outside the shape SAM can record/);
    assert.equal(git(f.proj, "log", "--oneline").split("\n").length, 1); // only the initial commit
    assert.equal(codeWrites(f.sam, 50).filter(w => w.path === ".env").length, 0);
  } finally { f.cleanup(); }
});

test("a failing engine closes failed with its output; a dirty tree blocks before the engine ever runs", async () => {
  const f = fixture();
  try {
    engineScript(f, "console.error('engine exploded');\nprocess.exit(3);\n");
    // The fake binary exits 0 regardless (it runs the script last);
    // a non-zero exit is exercised through the injected runner.
    const task = queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Boom" });
    const result = await drainEngineTasks(f.sam, { runEngine: async () => ({ exitCode: 3, output: "engine exploded" }) });
    assert.deepEqual(result.failed, [task.id]);
    const failedTask = listEngineTasks(f.sam)[0];
    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.exitCode, 3);
    assert.match(failedTask.output ?? "", /engine exploded/);
    assert.equal(git(f.proj, "log", "--oneline").split("\n").length, 1);
  } finally { f.cleanup(); }

  const g = fixture();
  try {
    writeFileSync(join(g.proj, "owner-draft.txt"), "the owner's uncommitted work\n");
    const task = queueEngineTask(g.sam, { actor: "trading", chatId: g.chatId, spec: "Anything" });
    const result = await drainEngineTasks(g.sam, { runEngine: async () => { throw new Error("the engine must never run on a dirty tree"); } });
    assert.deepEqual(result.blocked, [task.id]);
    assert.match(listEngineTasks(g.sam)[0].result ?? "", /Git discipline refused/);
  } finally { g.cleanup(); }
});

test("verification failure and a review BLOCK both close blocked, never done, with nothing committed", async () => {
  const f = fixture({ testScript: "node -e \"process.exit(1)\"" });
  try {
    engineScript(f, "import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst proj = process.argv[2];\nwriteFileSync(join(proj, 'hello.txt'), 'x\\n');\n");
    queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Add hello" });
    const result = await drainEngineTasks(f.sam, { review: async () => PASS_REVIEW });
    assert.equal(result.blocked.length, 1);
    const t = listEngineTasks(f.sam)[0];
    assert.equal(t.verification, "failed");
    assert.match(t.result ?? "", /did not verify/);
    assert.equal(git(f.proj, "log", "--oneline").split("\n").length, 1);
  } finally { f.cleanup(); }

  const g = fixture();
  try {
    engineScript(g, "import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst proj = process.argv[2];\nwriteFileSync(join(proj, 'hello.txt'), 'x\\n');\n");
    queueEngineTask(g.sam, { actor: "trading", chatId: g.chatId, spec: "Add hello" });
    const block: GoldfishRecord = { ...PASS_REVIEW, verdict: "BLOCK", summary: "the change is wrong" };
    const result = await drainEngineTasks(g.sam, { review: async () => block });
    assert.equal(result.blocked.length, 1);
    const t = listEngineTasks(g.sam)[0];
    assert.match(t.review ?? "", /^BLOCK/);
    assert.equal(git(g.proj, "log", "--oneline").split("\n").length, 1);
    // Review unavailable is also blocked, never done.
    const h = fixture();
    try {
      engineScript(h, "import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst proj = process.argv[2];\nwriteFileSync(join(proj, 'hello.txt'), 'x\\n');\n");
      queueEngineTask(h.sam, { actor: "trading", chatId: h.chatId, spec: "Add hello" });
      const r2 = await drainEngineTasks(h.sam, { review: async () => { throw new Error("no catalog"); } });
      assert.equal(r2.blocked.length, 1);
      assert.match(listEngineTasks(h.sam)[0].review ?? "", /^unavailable/);
    } finally { h.cleanup(); }
  } finally { g.cleanup(); }
});

test("a no-change engine run closes done plainly, and the fixed argv carries only the task text", async () => {
  const f = fixture();
  try {
    engineScript(f, "process.exit(0);\n");
    const task = queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Look around and change nothing" });
    const result = await drainEngineTasks(f.sam, { review: async () => PASS_REVIEW });
    assert.deepEqual(result.ran, [task.id]);
    const done = listEngineTasks(f.sam)[0];
    assert.equal(done.status, "done");
    assert.match(done.result ?? "", /made no changes/);
    const argv = engineArgv(done as EngineTask);
    assert.equal(argv[0], "-p");
    assert.ok(argv[1].startsWith("Look around and change nothing"));
    assert.deepEqual(argv.slice(2), ["--output-format", "text", "--permission-mode", "acceptEdits"]);
  } finally { f.cleanup(); }
});
