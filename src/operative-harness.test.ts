import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatStore } from "./chats.js";
import { drainEngineTasks, listEngineTasks } from "./engine.js";
import type { GoldfishRecord } from "./goldfish.js";

// The coding operative has never run live: the real engine is
// Claude Code, and that binary will not start a task until the
// owner has logged in. This harness is a regular file (not a
// symlink) that speaks the fixed argv SAM already spawns. The
// engine-probe file test is left untouched; the stub is found
// because SAM_ENGINE_BIN names that regular file.
//
// The proving run is the whole gate: propose, owner approval,
// a real subprocess of the stub, SAM's own record/verify/review/
// commit, and the summary posted back into the chat. No login
// is performed and no credential exists.

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const fixtureSrc = join(repoRoot, "fixtures", "fake-engine.mjs");
const PASS_REVIEW: GoldfishRecord = { verdict: "PASS", summary: "clean", findings: [], at: "2026-11-12T00:00:00.000Z", spec: "s", model: "stub", changeCount: 1, changeHashes: [], malformed: false };
const SPEC = ["WRITE hello.txt", "hello from the engine", "END", "Add hello.txt"].join("\n");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { encoding: "utf8" }).trim();
}

function placeEngine(dir: string): string {
  const bin = join(dir, "fake-engine");
  writeFileSync(bin, readFileSync(fixtureSrc));
  chmodSync(bin, 0o755);
  const stat = lstatSync(bin);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  return bin;
}

function sam(root: string, env: NodeJS.ProcessEnv, args: string[]): unknown {
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "--workspace", root, "--json", ...args], { encoding: "utf8", env });
  assert.equal(run.status, 0, (run.stdout ?? "") + (run.stderr ?? ""));
  return JSON.parse(run.stdout);
}

test("fake engine speaks the fixed argv, reports signed out, and refuses login", () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-fake-engine-"));
  try {
    const bin = placeEngine(dir);
    const work = join(dir, "work");
    mkdirSync(work);
    const status = spawnSync(bin, ["auth", "status"], { encoding: "utf8" });
    assert.equal(status.status, 0);
    assert.deepEqual(JSON.parse(status.stdout), { loggedIn: false });
    const login = spawnSync(bin, ["auth", "login"], { encoding: "utf8" });
    assert.equal(login.status, 2);
    assert.match(login.stderr, /refused/);
    const bad = spawnSync(bin, ["-p", "WRITE hello.txt\nhi\nEND\n", "--output-format", "json"], { encoding: "utf8", cwd: work });
    assert.notEqual(bad.status, 0);
    assert.equal(existsSync(join(work, "hello.txt")), false);
    const escape = spawnSync(bin, ["-p", "WRITE ../escape.txt\nhi\nEND\n", "--output-format", "text", "--permission-mode", "acceptEdits"], { encoding: "utf8", cwd: work });
    assert.equal(escape.status, 2);
    assert.equal(existsSync(join(dir, "escape.txt")), false);
    const run = spawnSync(bin, ["-p", SPEC, "--output-format", "text", "--permission-mode", "acceptEdits"], { encoding: "utf8", cwd: work });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /engine: wrote hello\.txt/);
    assert.equal(readFileSync(join(work, "hello.txt"), "utf8"), "hello from the engine\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a gated coding task runs against the fake engine from proposal to result, with no login", async () => {
  const base = mkdtempSync(join(tmpdir(), "sam-operative-"));
  const home = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(0)\"" } }));
  writeFileSync(join(proj, "tracked.txt"), "original\n");
  git(proj, "init", "-q");
  git(proj, "add", "package.json", "tracked.txt");
  git(proj, "commit", "-q", "-m", "initial");
  const bin = placeEngine(base);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", SAM_ENGINE_BIN: bin };
  try {
    assert.equal(existsSync(join(home, ".sam", "codex-tokens.json")), false);
    const rooted = sam(home, env, ["code", "set-root", proj]) as { root: string };
    assert.equal(rooted.root, proj);
    const chat = sam(home, env, ["chats", "new", "Desk"]) as { id: string };
    const proposed = sam(home, env, ["engine", "propose", "--chat", chat.id, "--spec", SPEC]) as { status: string; id: string; kind: string };
    assert.equal(proposed.status, "pending_owner_approval");
    assert.equal(proposed.kind, "engine");
    assert.equal(listEngineTasks(home).length, 0);
    const approved = sam(home, env, ["actions", "approve", proposed.id]) as { status: string; result: string | null };
    assert.equal(approved.status, "done");
    assert.match(approved.result ?? "", /Engine run queued/);
    const queued = listEngineTasks(home);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].status, "queued");
    const drained = await drainEngineTasks(home, { env, review: async () => PASS_REVIEW });
    assert.deepEqual(drained.ran, [queued[0].id]);
    const done = listEngineTasks(home)[0];
    assert.equal(done.status, "done");
    assert.equal(done.exitCode, 0);
    assert.match(done.output ?? "", /engine: wrote hello\.txt/);
    assert.equal(done.verification, "verified");
    assert.match(done.review ?? "", /^PASS/);
    assert.deepEqual(done.changes, ["hello.txt"]);
    assert.equal(done.git?.mode, "branch");
    assert.equal(done.git?.pending.length, 0);
    assert.equal(done.git?.commits.length, 1);
    assert.match(git(proj, "show", "HEAD:hello.txt"), /hello from the engine/);
    assert.equal(git(proj, "status", "--porcelain"), "");
    const db = new ChatStore(home);
    try {
      const messages = db.messages(chat.id);
      assert.match(messages[messages.length - 1].content, /Engine run done/);
    } finally { db.close(); }
    assert.equal(existsSync(join(home, ".sam", "codex-tokens.json")), false);
    assert.equal(existsSync(join(home, ".sam", "engine-connection.json")), false);
    assert.equal(existsSync(join(home, ".sam", "claude-tokens.json")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
