import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { proposeAction, decideAction, listActions, settleAutoApprovals } from "./actions.js";
import { saveApprovalPolicy, classifyProposal, approvalAutoVia } from "./approval-policy.js";
import { proposeDelegation, listDelegations, getDelegation, cancelDelegation, adapterArgv, redactOperativeOutput, delegationKillArmed } from "./coding-operatives.js";
import { OperativeRegistry } from "./operatives.js";
import { AssignmentLeases } from "./assignment-leases.js";
import { ChatStore } from "./chats.js";
import { readActivity } from "./activity.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sam-op-repo-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "operative@example.com"]);
  git(dir, ["config", "user.name", "Operative Test"]);
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}
function fakeBin(dir: string, body: string): string {
  const file = join(dir, "fake-adapter.sh");
  writeFileSync(file, body, { mode: 0o700 });
  chmodSync(file, 0o700);
  return file;
}

test("adapter argv is a fixed exec/print invocation and never a push", () => {
  const codex = adapterArgv("codex", "fix the bug");
  const claude = adapterArgv("claude-code", "fix the bug");
  assert.deepEqual(codex.slice(0, 4), ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write"]);
  assert.equal(codex.at(-1), "fix the bug");
  assert.deepEqual(claude, ["-p", "fix the bug", "--output-format", "text", "--permission-mode", "acceptEdits"]);
  assert.ok(!codex.join(" ").includes("push") && !claude.join(" ").includes("push"));
  assert.equal(redactOperativeOutput("token=sk-supersecretvalue and Bearer abc.def"), "token=[redacted] and Bearer [redacted]");
});

test("delegate cards the owner and only the approval starts the fake operative", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-delegate-"));
  const source = repo();
  const bin = fakeBin(root, "#!/bin/sh\necho hello-from-adapter\necho 'sk-supersecretvalue'\necho worked > note.txt\n");
  const saved = process.env.SAM_CODEX_BIN;
  const savedKey = process.env.CODEX_API_KEY;
  process.env.SAM_CODEX_BIN = bin;
  process.env.CODEX_API_KEY = "sk-should-not-be-stored";
  try {
    const db = new ChatStore(root);
    const chat = db.create("Operative report");
    db.close();
    assert.equal(classifyProposal("delegate", null).risk, "consequential");
    assert.throws(() => saveApprovalPolicy(root, { mode: "smart", autoKinds: ["delegate"] }), /cannot auto-approve consequential/);
    saveApprovalPolicy(root, { mode: "off", autoKinds: [] });
    assert.equal(approvalAutoVia({ mode: "off", autoKinds: [], updatedAt: null }, "delegate", null), null);
    const job = proposeDelegation(root, { actor: "sam", adapter: "codex", repo: source, branch: "sam/operative-demo", prompt: "write a note", chatId: chat.id, timeoutMs: 10_000 }, (detail, title) => proposeAction(root, { actor: "sam", kind: "delegate", title, detail, chatId: chat.id }));
    assert.equal(job.status, "pending");
    assert.equal(existsSync(join(source, "note.txt")), false);
    const settled = await settleAutoApprovals(root, job.actionId ?? undefined);
    assert.equal(settled.length, 0, "off mode still cannot start a delegation");
    assert.equal(getDelegation(root, job.id)?.status, "pending");
    const decided = await decideAction(root, job.actionId!, true);
    assert.equal(decided.status, "done");
    assert.match(decided.result ?? "", /branch sam\/operative-demo/);
    assert.match(decided.result ?? "", /Not pushed/);
    const finished = getDelegation(root, job.id)!;
    assert.equal(finished.status, "done");
    assert.equal(finished.exitCode, 0);
    assert.match(finished.diffStat ?? "", /note\.txt/);
    assert.equal(finished.testResult, "not-run: no package.json");
    assert.equal(finished.auth.key, "present");
    assert.equal(finished.auth.keyEnv, "CODEX_API_KEY");
    const stored = readFileSync(join(root, ".sam", "delegations.json"), "utf8");
    assert.ok(!stored.includes("sk-should-not-be-stored"));
    assert.ok(!stored.includes("sk-supersecretvalue"));
    const activity = readActivity(root, 30).map(l => l.summary).join("\n");
    assert.match(activity, /hello-from-adapter/);
    assert.ok(!activity.includes("sk-supersecretvalue"));
    assert.ok(!activity.includes("sk-should-not-be-stored"));
    const log = readFileSync(join(root, ".sam", "delegations", job.id + ".log"), "utf8");
    assert.match(log, /hello-from-adapter/);
    assert.ok(!log.includes("sk-supersecretvalue"));
    const check = new ChatStore(root);
    const messages = check.messages(chat.id);
    check.close();
    assert.match(messages.map(m => m.content).join("\n"), /sam\/operative-demo/);
    const reg = new OperativeRegistry(join(root, ".sam", "missions.db"));
    const operative = reg.list().find(o => o.adapter === "codex");
    reg.close();
    assert.ok(operative);
    assert.equal(operative?.capabilities.includes("code"), true);
    assert.equal(operative?.active_assignments, 0);
    const leases = new AssignmentLeases(join(root, ".sam", "missions.db"));
    const active = operative ? leases.active(operative.id) : [];
    leases.close();
    assert.equal(active.length, 0);
    const branch = execFileSync("git", ["-C", source, "branch", "--list", "sam/operative-demo"], { encoding: "utf8" });
    assert.match(branch, /sam\/operative-demo/);
    assert.equal(listActions(root).filter(a => a.kind === "delegate" && a.status === "pending").length, 0);
  } finally {
    if (saved === undefined) delete process.env.SAM_CODEX_BIN; else process.env.SAM_CODEX_BIN = saved;
    if (savedKey === undefined) delete process.env.CODEX_API_KEY; else process.env.CODEX_API_KEY = savedKey;
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("main is refused, a timeout kills the process, and cancel stops a running operative", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-delegate-kill-"));
  const source = repo();
  const bin = fakeBin(root, "#!/bin/sh\nsleep 30\n");
  const saved = process.env.SAM_CLAUDE_BIN;
  process.env.SAM_CLAUDE_BIN = bin;
  try {
    assert.throws(() => proposeDelegation(root, { adapter: "claude-code", repo: source, branch: "main", prompt: "nope", timeoutMs: 5_000 }, () => ({ id: "x" })), /never main/);
    const slow = proposeDelegation(root, { adapter: "claude-code", repo: source, branch: "sam/slow-job", prompt: "wait", timeoutMs: 1_000 }, (detail, title) => proposeAction(root, { actor: "sam", kind: "delegate", title, detail }));
    const timed = await decideAction(root, slow.actionId!, true);
    assert.equal(timed.status, "failed");
    assert.equal(getDelegation(root, slow.id)?.timedOut, true);
    const hanging = proposeDelegation(root, { adapter: "claude-code", repo: source, branch: "sam/cancel-job", prompt: "wait more", timeoutMs: 60_000 }, (detail, title) => proposeAction(root, { actor: "sam", kind: "delegate", title, detail }));
    const running = decideAction(root, hanging.actionId!, true);
    const started = Date.now();
    while (!delegationKillArmed(hanging.id)) {
      if (Date.now() - started > 8_000) throw new Error("operative did not start (" + (getDelegation(root, hanging.id)?.status ?? "missing") + ")");
      await new Promise(r => setTimeout(r, 20));
    }
    const cancelled = cancelDelegation(root, hanging.id);
    assert.equal(cancelled.status, "cancelled");
    const decided = await running;
    assert.equal(decided.status, "failed");
    assert.equal(getDelegation(root, hanging.id)?.status, "cancelled");
  } finally {
    if (saved === undefined) delete process.env.SAM_CLAUDE_BIN; else process.env.SAM_CLAUDE_BIN = saved;
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test("CLI delegate creates a card and does not run the binary; status lists it", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-delegate-cli-"));
  const source = repo();
  const bin = fakeBin(root, "#!/bin/sh\necho should-not-run > ran.txt\n");
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const env = { PATH: "/usr/bin:/bin", SAM_CODEX_BIN: bin };
  try {
    const created = spawnSync(process.execPath, [cli, "--workspace", root, "--json", "delegate", "codex", "--repo", source, "--branch", "feature/by-hand", "--prompt", "add a line", "--timeout", "5000"], { encoding: "utf8", env });
    assert.equal(created.status, 0, created.stderr);
    const body = JSON.parse(created.stdout);
    assert.equal(body.status, "pending_owner_approval");
    assert.equal(body.adapter, "codex");
    assert.equal(existsSync(join(source, "ran.txt")), false);
    const listed = spawnSync(process.execPath, [cli, "--workspace", root, "--json", "delegate", "status"], { encoding: "utf8", env });
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout)[0].id, body.delegation);
    const ops = spawnSync(process.execPath, [cli, "--workspace", root, "--json", "operative", "status"], { encoding: "utf8", env });
    assert.equal(ops.status, 0, ops.stderr);
    assert.equal(JSON.parse(ops.stdout)[0].adapter, "codex");
    assert.equal(listDelegations(root)[0].status, "pending");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});
