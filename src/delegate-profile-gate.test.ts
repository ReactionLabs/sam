import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { listActions, proposeAction } from "./actions.js";
import { delegateProfileBlocker, listDelegations } from "./coding-operatives.js";

// The profile gate for the delegate PROPOSE door (the
// gate-level actor audit, after the engine and generic
// actions propose doors): every queue door and both earlier
// propose doors read the profile registry before creating
// anything, but CLI `delegate --actor` passed the raw actor
// into proposeDelegation, whose callback proposeAction
// checks only the name's shape - minting a pending approval
// card bound to nobody: the card sits on the ONE gate under
// a phantom actor, its delegate-proposed ledger line carries
// that same actor, and on approval the operative's work
// runs under that actor. delegateProfileBlocker is now the
// ONE source carrying the refusal text: the CLI door throws
// it before proposing anything. proposeDelegation itself
// stays permissive by design (a profile removed after a
// delegation names it keeps its stored actor, and the
// approved execution path carries the card's stored actor),
// so it is NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-delegate-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("delegate profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(delegateProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(delegateProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("delegate profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      delegateProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in delegate detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      delegateProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in delegate detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      delegateProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in delegate detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("delegate profile gate: the CLI door's check proposes nothing for a bogus profile", () => {
  const root = fresh();
  try {
    const blocker = delegateProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    // The CLI door throws this text before calling
    // proposeDelegation; pin that the check alone leaves
    // no delegation and no card behind.
    assert.equal(listDelegations(root).length, 0);
    assert.equal(listActions(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A delegate card's detail is validated at proposal time
// (real repo, installed operative binary), so the two
// card tests below build that fixture: a temp git repo and
// a fake codex binary named through SAM_CODEX_BIN.
function delegateFixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-delegate-profile-gate-card-"));
  const root = join(base, "home");
  const repoDir = join(base, "repo");
  const binDir = join(base, "bin");
  mkdirSync(root, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "gate@example.com"]);
  git(["config", "user.name", "Gate Test"]);
  writeFileSync(join(repoDir, "README.md"), "base\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "base"]);
  const fake = join(binDir, "fake-codex");
  writeFileSync(fake, "#!/bin/sh\necho hi\n", { mode: 0o700 });
  chmodSync(fake, 0o700);
  const prev = process.env.SAM_CODEX_BIN;
  process.env.SAM_CODEX_BIN = fake;
  return {
    root, repoDir,
    detail: JSON.stringify({ adapter: "codex", repo: repoDir, branch: "sam/test", prompt: "Do the thing", timeoutMs: 120000 }),
    cleanup() {
      if (prev === undefined) delete process.env.SAM_CODEX_BIN; else process.env.SAM_CODEX_BIN = prev;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test("delegate profile gate: a registered profile passes the check and the card is proposed bound to it", () => {
  const f = delegateFixture();
  try {
    register(f.root, "second-shift");
    assert.equal(delegateProfileBlocker(f.root, "second-shift"), null);
    const a = proposeAction(f.root, { actor: "second-shift", kind: "delegate", title: "Delegate to codex on sam/test", detail: f.detail });
    assert.equal(a.actor, "second-shift");
    assert.equal(a.status, "pending");
    assert.equal(listActions(f.root).length, 1);
  } finally { f.cleanup(); }
});

test("delegate profile gate: proposeAction stays permissive - a card may name a profile removed later", () => {
  const f = delegateFixture();
  try {
    const a = proposeAction(f.root, { actor: "trading", kind: "delegate", title: "Delegate to codex on sam/test", detail: f.detail });
    assert.equal(a.actor, "trading");
    assert.equal(listActions(f.root).length, 1);
  } finally { f.cleanup(); }
});
