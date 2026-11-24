import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listActions } from "./actions.js";
import { readActivity } from "./activity.js";
import { delegateBinary, delegateNotInstalledReason, listDelegations, proposeDelegation, validateDelegateDetail } from "./coding-operatives.js";
import { proposeAction } from "./actions.js";

// The proposal-time binary gate for delegations: validateDelegateSpec
// checked the adapter name, the branch, the prompt, the repo's
// existence, its git-ness, and its HEAD - but never that the
// operative's CLI binary exists, while the approved run spawns
// exactly that binary and can only fail when it is absent (spawn
// ENOENT, exit code null, delegation failed). The engine kind
// refuses not-installed at proposal time for this exact reason
// ("a card that cannot execute is never shown"); the delegate
// gate now reads the same precondition through delegateBinary,
// which resolves the binary exactly as adapterLaunch would
// spawn it, and throws delegateNotInstalledReason, the ONE
// source, before any card or delegation record is created.
// Fixtures use REAL git in temp dirs and fake adapter binaries.

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sam-delegate-gate-repo-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "gate@example.com"]);
  git(dir, ["config", "user.name", "Gate Test"]);
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sam-delegate-gate-"));
  const source = repo();
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, "fake-codex");
  writeFileSync(fake, "#!/bin/sh\necho hi\n", { mode: 0o700 });
  chmodSync(fake, 0o700);
  return {
    root, source, fake,
    emptyEnv: { PATH: join(root, "no-bin-here") } as NodeJS.ProcessEnv,
    cleanup() { rmSync(root, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true }); },
  };
}
const SPEC = { actor: "sam", adapter: "codex", branch: "sam/gated-job", prompt: "do the thing", timeoutMs: 5_000 };

test("delegate gate: no operative binary refuses at proposal time, in the ONE reason's words, and creates nothing", () => {
  const f = fixture();
  try {
    let err = "";
    try {
      proposeDelegation(f.root, { ...SPEC, repo: f.source }, (detail, title) => proposeAction(f.root, { actor: "sam", kind: "delegate", title, detail }), f.emptyEnv);
    } catch (e) { err = (e as Error).message; }
    assert.equal(err, delegateNotInstalledReason("codex"));
    assert.deepEqual(listDelegations(f.root), []);
    assert.deepEqual(listActions(f.root), []);
    assert.equal(readActivity(f.root).some(a => a.kind === "delegate-proposed"), false);
    // The gate's own validation door (the ONE gate's proposal
    // check rides validateDelegateDetail) throws the same words.
    let detailErr = "";
    try {
      validateDelegateDetail(JSON.stringify({ adapter: "codex", repo: f.source, branch: "sam/gated-job", prompt: "do the thing" }), f.emptyEnv);
    } catch (e) { detailErr = (e as Error).message; }
    assert.equal(detailErr, err);
  } finally { f.cleanup(); }
});

test("delegate gate: the claude-code refusal names its own env vars, not codex's", () => {
  const f = fixture();
  try {
    assert.equal(delegateBinary("claude-code", f.emptyEnv), null);
    assert.match(delegateNotInstalledReason("claude-code"), /SAM_CLAUDE_BIN/);
    assert.match(delegateNotInstalledReason("claude-code"), /SAM_ENGINE_BIN/);
    assert.throws(
      () => validateDelegateDetail(JSON.stringify({ adapter: "claude-code", repo: f.source, branch: "sam/gated-job", prompt: "do the thing" }), f.emptyEnv),
      (e: unknown) => (e as Error).message === delegateNotInstalledReason("claude-code"),
    );
  } finally { f.cleanup(); }
});

test("delegate gate: an env-named binary that is not a file does not satisfy the gate", () => {
  const f = fixture();
  try {
    const env = { PATH: f.emptyEnv.PATH, SAM_CODEX_BIN: join(f.root, "missing-binary") } as NodeJS.ProcessEnv;
    assert.equal(delegateBinary("codex", env), null);
    assert.throws(
      () => validateDelegateDetail(JSON.stringify({ adapter: "codex", repo: f.source, branch: "sam/gated-job", prompt: "do the thing" }), env),
      (e: unknown) => (e as Error).message === delegateNotInstalledReason("codex"),
    );
  } finally { f.cleanup(); }
});

test("delegate gate: a named fake binary satisfies the gate and the same spec proposes - the gate is a read, not a latch", () => {
  const f = fixture();
  try {
    const env = { PATH: f.emptyEnv.PATH, SAM_CODEX_BIN: f.fake } as NodeJS.ProcessEnv;
    assert.equal(delegateBinary("codex", env), f.fake);
    const job = proposeDelegation(f.root, { ...SPEC, repo: f.source }, (detail, title) => proposeAction(f.root, { actor: "sam", kind: "delegate", title, detail }), env);
    assert.equal(job.status, "pending");
    assert.equal(listDelegations(f.root).length, 1);
    assert.equal(listActions(f.root).filter(a => a.kind === "delegate" && a.status === "pending").length, 1);
  } finally { f.cleanup(); }
});

test("delegate gate: a binary found on PATH satisfies the gate with no env name set", () => {
  const f = fixture();
  try {
    const binDir = join(f.root, "pathbin");
    mkdirSync(binDir, { recursive: true });
    const onPath = join(binDir, "codex");
    writeFileSync(onPath, "#!/bin/sh\necho hi\n", { mode: 0o700 });
    chmodSync(onPath, 0o700);
    const env = { PATH: binDir } as NodeJS.ProcessEnv;
    assert.equal(delegateBinary("codex", env), onPath);
    const spec = validateDelegateDetail(JSON.stringify({ adapter: "codex", repo: f.source, branch: "sam/gated-job", prompt: "do the thing" }), env);
    assert.equal(spec.adapter, "codex");
  } finally { f.cleanup(); }
});

test("delegate gate: the binary check fires after the HEAD check - a commit-less repo keeps its own refusal", () => {
  const f = fixture();
  try {
    const bare = mkdtempSync(join(tmpdir(), "sam-delegate-gate-bare-"));
    git(bare, ["init", "-b", "main"]);
    try {
      assert.throws(
        () => validateDelegateDetail(JSON.stringify({ adapter: "codex", repo: bare, branch: "sam/gated-job", prompt: "do the thing" }), f.emptyEnv),
        /no commits yet/,
      );
    } finally { rmSync(bare, { recursive: true, force: true }); }
  } finally { f.cleanup(); }
});
