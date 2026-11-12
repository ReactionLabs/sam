import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { setCodeRoot } from "./code.js";
import { drainEngineTasks, engineArgv, engineRunBinary, engineStatus, listEngineTasks, queueEngineTask, selectedEngineProvider, updateEngineTask, validateEngineDetail, type EngineTask } from "./engine.js";
import { setEngineProvider } from "./engine-connect.js";
import type { GoldfishRecord } from "./goldfish.js";

// Provider-selectable engine RUNS (2026-11-12, the follow-on the
// 16:04 Codex config build recorded): the C6 run rides the SAME
// provider selection the config layer records. The queued task
// snapshots the provider (the provider the owner approved is the
// provider that runs), each provider resolves its own binary and
// spawns its own fixed argv, and every refusal / summary names
// the provider instead of assuming Claude Code.

const PASS_REVIEW: GoldfishRecord = { verdict: "PASS", summary: "clean", findings: [], at: new Date().toISOString(), spec: "s", model: "stub", changeCount: 1, changeHashes: [], malformed: false };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

function fakeBinary(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, name);
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  return bin;
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-engine-provider-run-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  const binDir = join(base, "bin");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(0)\"" } }));
  writeFileSync(join(proj, "tracked.txt"), "original\n");
  git(proj, "init", "-q");
  git(proj, "add", "package.json", "tracked.txt");
  git(proj, "commit", "-q", "-m", "initial");
  const codex = fakeBinary(binDir, "codex");
  const claude = fakeBinary(binDir, "claude");
  const db = new ChatStore(sam);
  let chatId: string;
  try { chatId = db.create("Desk", "trading").id; } finally { db.close(); }
  setCodeRoot(sam, proj);
  const prevCodex = process.env.SAM_CODEX_BIN;
  const prevEngine = process.env.SAM_ENGINE_BIN;
  return {
    base, sam, proj, chatId, codex, claude,
    cleanup() {
      if (prevCodex === undefined) delete process.env.SAM_CODEX_BIN; else process.env.SAM_CODEX_BIN = prevCodex;
      if (prevEngine === undefined) delete process.env.SAM_ENGINE_BIN; else process.env.SAM_ENGINE_BIN = prevEngine;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test("selection: the run layer reads the config choice read-only - default claude-code, a pure read creates nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-engine-provider-read-"));
  try {
    assert.equal(selectedEngineProvider(root), "claude-code");
    assert.equal(existsSync(join(root, ".sam", "engine-connection.db")), false, "a pure read creates no store");
    setEngineProvider(root, "codex");
    assert.equal(selectedEngineProvider(root), "codex");
    setEngineProvider(root, "claude-code");
    assert.equal(selectedEngineProvider(root), "claude-code");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("binary + argv: each provider resolves its own binary and spawns its own fixed argv", () => {
  const f = fixture();
  try {
    assert.equal(engineRunBinary("codex", { SAM_CODEX_BIN: f.codex }), f.codex);
    assert.equal(engineRunBinary("codex", { PATH: join(f.base, "bin") }), f.codex);
    assert.equal(engineRunBinary("codex", { PATH: "/nonexistent-dir" }), null);
    assert.equal(engineRunBinary("claude-code", { SAM_ENGINE_BIN: f.claude, PATH: "" }), f.claude);

    const task = { spec: "Do the thing" } as EngineTask;
    assert.deepEqual(engineArgv(task, "claude-code").slice(0, 1), ["-p"]);
    assert.ok(engineArgv(task, "claude-code")[1].startsWith("Do the thing"));
    assert.deepEqual(engineArgv(task, "claude-code").slice(2), ["--output-format", "text", "--permission-mode", "acceptEdits"]);
    const codexArgv = engineArgv(task, "codex");
    assert.deepEqual(codexArgv.slice(0, 5), ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--"]);
    assert.ok(codexArgv[5].startsWith("Do the thing"));
    // The task's own snapshot is the default when no provider is named.
    assert.deepEqual(engineArgv({ ...task, provider: "codex" } as EngineTask).slice(0, 1), ["exec"]);
    assert.deepEqual(engineArgv({ ...task, provider: null } as EngineTask).slice(0, 1), ["-p"]);
  } finally { f.cleanup(); }
});

test("validation: the SELECTED provider's binary is the bar - a Claude install does not satisfy a Codex selection", () => {
  const f = fixture();
  try {
    setEngineProvider(f.sam, "codex");
    // Claude is installed (SAM_ENGINE_BIN) but Codex is nowhere: refuse, naming Codex.
    assert.throws(
      () => validateEngineDetail(f.sam, JSON.stringify({ task: "do it" }), { SAM_ENGINE_BIN: f.claude, PATH: "/nonexistent-dir" }),
      /Codex.*not installed/,
    );
    const ok = validateEngineDetail(f.sam, JSON.stringify({ task: "do it" }), { SAM_CODEX_BIN: f.codex });
    assert.equal(ok.provider, "codex");
    // Status reads through the selected provider too.
    const status = engineStatus(f.sam, { SAM_CODEX_BIN: f.codex });
    assert.equal(status.provider, "codex");
    assert.equal(status.installed, true);
    assert.equal(status.binary, f.codex);
  } finally { f.cleanup(); }
});

test("snapshot: a run queued under Codex still runs Codex after the selection switches back to Claude Code", async () => {
  const f = fixture();
  try {
    process.env.SAM_CODEX_BIN = f.codex;
    process.env.SAM_ENGINE_BIN = f.claude;
    setEngineProvider(f.sam, "codex");
    const task = queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Add hello.txt" });
    assert.equal(task.provider, "codex");
    // The owner changes their mind about the CONFIG choice after approval.
    setEngineProvider(f.sam, "claude-code");
    assert.equal(selectedEngineProvider(f.sam), "claude-code");

    const seen: Array<{ binary: string; args: string[] }> = [];
    const result = await drainEngineTasks(f.sam, {
      env: { SAM_CODEX_BIN: f.codex, SAM_ENGINE_BIN: f.claude, PATH: process.env.PATH },
      runEngine: async (binary, args, cwd) => {
        seen.push({ binary, args });
        writeFileSync(join(cwd, "hello.txt"), "hello from codex\n");
        return { exitCode: 0, output: "codex: work complete" };
      },
      review: async () => PASS_REVIEW,
    });
    assert.deepEqual(result.ran, [task.id]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].binary, f.codex, "the drain spawns the snapshotted provider's binary");
    assert.deepEqual(seen[0].args.slice(0, 5), ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--"]);
    const done = listEngineTasks(f.sam)[0];
    assert.equal(done.status, "done");
    assert.equal(done.provider, "codex");
    assert.deepEqual(done.changes, ["hello.txt"]);
    // The summary posted into the chat names the engine that ran.
    const db = new ChatStore(f.sam);
    try {
      const messages = db.messages(f.chatId);
      assert.match(messages[messages.length - 1].content, /Engine: Codex/);
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

test("legacy: a task with no provider snapshot resolves the current selection at drain and is stamped with it", async () => {
  const f = fixture();
  try {
    process.env.SAM_CODEX_BIN = f.codex;
    process.env.SAM_ENGINE_BIN = f.claude;
    // Queued under the default (claude-code), then re-stamped as a
    // legacy record (no snapshot) the way a pre-provider task reads.
    const task = queueEngineTask(f.sam, { actor: "trading", chatId: f.chatId, spec: "Add legacy.txt" });
    updateEngineTask(f.sam, task.id, { provider: null });
    setEngineProvider(f.sam, "codex");

    const seen: Array<{ binary: string; args: string[] }> = [];
    const result = await drainEngineTasks(f.sam, {
      env: { SAM_CODEX_BIN: f.codex, SAM_ENGINE_BIN: f.claude, PATH: process.env.PATH },
      runEngine: async (binary, args, cwd) => {
        seen.push({ binary, args });
        writeFileSync(join(cwd, "legacy.txt"), "legacy\n");
        return { exitCode: 0, output: "ok" };
      },
      review: async () => PASS_REVIEW,
    });
    assert.deepEqual(result.ran, [task.id]);
    assert.equal(seen[0].binary, f.codex);
    assert.equal(listEngineTasks(f.sam)[0].provider, "codex", "the resolved provider is stamped onto the record");
  } finally { f.cleanup(); }
});
