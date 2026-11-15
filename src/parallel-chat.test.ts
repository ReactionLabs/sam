import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listActions } from "./actions.js";
import { saveApprovalPolicy } from "./approval-policy.js";
import { ChatStore } from "./chats.js";
import { setCodeRoot } from "./code.js";
import type { EngineRunner } from "./engine.js";
import { executeOwnToolAsync, ownToolsFor } from "./own-tools.js";
import { drainParallelJobs, getParallelJob, proposeParallelPush } from "./parallel-coding.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-parallel-chat-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  const bare = join(base, "origin.git");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(bare, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(0)\"" } }));
  writeFileSync(join(proj, "README.md"), "# proj\n");
  git(proj, "init", "-q");
  git(proj, "add", "package.json", "README.md");
  git(proj, "commit", "-q", "-m", "initial");
  git(bare, "init", "--bare", "-q");
  const db = new ChatStore(sam);
  let chatId = "";
  try { chatId = db.create("Desk").id; } finally { db.close(); }
  setCodeRoot(sam, proj);
  return { base, sam, proj, bare, chatId, cleanup() { rmSync(base, { recursive: true, force: true }); } };
}

function directiveEngine(): EngineRunner {
  return async (_binary, args, cwd) => {
    const prompt = args.join("\n");
    for (const m of prompt.matchAll(/WRITE (\S+) :: ([^\n]*)/g)) {
      const target = join(cwd, m[1]);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, m[2] + "\n");
    }
    return { exitCode: 0, output: "engine ok" };
  };
}

function withEngine<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.SAM_ENGINE_BIN;
  process.env.SAM_ENGINE_BIN = process.execPath;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.SAM_ENGINE_BIN;
    else process.env.SAM_ENGINE_BIN = prev;
  });
}

test("sam_parallel_task queues the existing machinery and posts one consolidated chat message", async () => {
  const f = fixture();
  try {
    await withEngine(async () => {
      const names = ownToolsFor(f.sam).map(t => (t as { function: { name: string } }).function.name);
      assert.ok(names.includes("sam_parallel_task"));
      const queued = await executeOwnToolAsync(f.sam, "sam", "sam_parallel_task", {
        spec: "Add two files in parallel.",
        slices: [
          { name: "one", task: "WRITE one.txt :: one", files: ["one.txt"] },
          { name: "two", task: "WRITE two.txt :: two", files: ["two.txt"] },
        ],
        push: true,
        branch: "main",
      }, undefined, f.chatId) as { status?: string; id?: string; note?: string };
      assert.equal(queued.status, "queued");
      assert.match(queued.note ?? "", /ONE message/);
      assert.match(queued.note ?? "", /Nothing was pushed/);
      assert.equal(listActions(f.sam).length, 0, "a push flag on queue does not open a push");
      const job = getParallelJob(f.sam, queued.id ?? "");
      assert.equal(job?.status, "queued");
      assert.equal(job?.slices.length, 2);
      await drainParallelJobs(f.sam, { runEngine: directiveEngine(), env: { SAM_ENGINE_BIN: process.execPath } });
      const done = getParallelJob(f.sam, queued.id ?? "");
      assert.equal(done?.status, "done");
      const db = new ChatStore(f.sam);
      let assistants: Array<{ role: string; content: string }> = [];
      try { assistants = db.messages(f.chatId).filter(m => m.role === "assistant"); } finally { db.close(); }
      assert.equal(assistants.length, 1, "the drain posts one consolidated message");
      assert.match(assistants[0].content, /Slices/);
      assert.match(assistants[0].content, /one:/);
      assert.match(assistants[0].content, /two:/);
      assert.match(assistants[0].content, /Verification:/);
      assert.match(assistants[0].content, /Parallel job done/);
      const visitorDb = new ChatStore(f.sam);
      let visitor = "";
      try { visitor = visitorDb.create("Web", "sam", { visitor: true }).id; } finally { visitorDb.close(); }
      const refused = await executeOwnToolAsync(f.sam, "sam", "sam_parallel_task", { spec: "x", slices: [{ name: "a", task: "t" }] }, undefined, visitor) as { error?: string };
      assert.match(refused.error ?? "", /Visitors cannot/);
    });
  } finally { f.cleanup(); }
});

test("sam_parallel_task cannot bypass the push gate, including when approval mode is off", async () => {
  const f = fixture();
  try {
    await withEngine(async () => {
      const queued = await executeOwnToolAsync(f.sam, "sam", "sam_parallel_task", {
        spec: "Add one file.",
        slices: [{ name: "one", task: "WRITE one.txt :: one", files: ["one.txt"] }],
      }, undefined, f.chatId) as { id: string };
      assert.throws(() => proposeParallelPush(f.sam, queued.id), /not a finished job/);
      assert.equal(listActions(f.sam).length, 0);
      await drainParallelJobs(f.sam, { runEngine: directiveEngine(), env: { SAM_ENGINE_BIN: process.execPath } });
      git(f.proj, "remote", "add", "origin", f.bare);
      saveApprovalPolicy(f.sam, { mode: "off", autoKinds: [] });
      const early = await executeOwnToolAsync(f.sam, "sam", "sam_parallel_task", { action: "push-now", jobId: queued.id, branch: "main", bypass: true }, undefined, f.chatId) as { error?: string };
      assert.match(early.error ?? "", /Unknown parallel action/);
      assert.equal(listActions(f.sam).length, 0);
      const pushed = await executeOwnToolAsync(f.sam, "sam", "sam_parallel_task", {
        action: "push", jobId: queued.id, branch: "main", bypass: true, pushNow: true, force: true,
      }, undefined, f.chatId) as { status?: string; branch?: string; id?: string };
      assert.equal(pushed.status, "pending_owner_approval");
      const job = getParallelJob(f.sam, queued.id);
      assert.equal(pushed.branch, job?.branch);
      assert.notEqual(pushed.branch, "main");
      const proposals = listActions(f.sam).filter(a => a.kind === "git-push");
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0].status, "pending");
      assert.equal(JSON.parse(proposals[0].detail).branch, job?.branch);
      const remoteBranches = git(f.bare, "branch", "--list");
      assert.equal(remoteBranches.includes(job?.branch ?? "missing"), false, "the bare origin did not receive the branch");
      const again = await executeOwnToolAsync(f.sam, "sam", "sam_parallel_task", { action: "push", jobId: queued.id }, undefined, f.chatId) as { status?: string };
      assert.equal(again.status, "pending_owner_approval");
      assert.equal(listActions(f.sam).filter(a => a.status === "pending" && a.kind === "git-push").length, 2);
      assert.equal(git(f.bare, "branch", "--list").includes(job?.branch ?? "missing"), false);
    });
  } finally { f.cleanup(); }
});
