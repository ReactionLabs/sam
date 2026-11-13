import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cancelDelegation, getDelegation, listDelegations, proposeDelegation, updateDelegation, type Delegation } from "./coding-operatives.js";

// State convergence (UNIFICATION item 4, thirty-fourth store):
// the delegations registry migrated from whole-file
// delegations.json rewrites to one-row-per-record SQLite
// (.sam/delegations.db). These tests pin the migration
// contract: legacy files import in order with every field
// intact, are renamed (never deleted), a malformed file
// imports nothing and stays put, a pure read creates nothing,
// single-row mutations cannot lose each other, and a cancel
// over a migrated legacy record persists in the DB.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-delegations-store-")); }
function git(cwd: string, args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sam-delegations-repo-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "operative@example.com"]);
  git(dir, ["config", "user.name", "Operative Test"]);
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}

function legacyJob(id: string, branch: string, extra: Partial<Delegation> = {}): Delegation {
  return {
    id, actionId: "action-" + id, adapter: "codex", repo: "/tmp/repo", branch, prompt: "do the thing",
    actor: "sam", chatId: null, operativeId: "op-1", leaseId: null, status: "pending",
    timeoutMs: 60_000, createdAt: "2026-11-01T00:00:00.000Z", startedAt: null, finishedAt: null,
    exitCode: null, timedOut: false, diffStat: null, testResult: null, worktree: null, summary: null,
    auth: { binEnv: "SAM_CODEX_BIN", keyEnv: "CODEX_API_KEY", key: "absent" }, ...extra,
  };
}

test("delegations store: a legacy delegations.json imports in order, fields intact, file renamed not deleted", () => {
  const root = fresh();
  const source = repo();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const first = legacyJob("del-1", "sam/first");
    const second = legacyJob("del-2", "sam/second", { status: "done", exitCode: 0, summary: "Delegation done", finishedAt: "2026-11-01T00:05:00.000Z" });
    writeFileSync(join(root, ".sam", "delegations.json"), JSON.stringify([first, second], null, 2));
    const items = listDelegations(root);
    assert.deepEqual(items.map(d => d.id), ["del-1", "del-2"]);
    assert.deepEqual(items[0], first);
    assert.deepEqual(items[1], second);
    // The id-or-actionId lookup rides the migrated rows.
    assert.equal(getDelegation(root, "action-del-2")?.id, "del-2");
    assert.equal(existsSync(join(root, ".sam", "delegations.db")), true);
    assert.equal(existsSync(join(root, ".sam", "delegations.json")), false);
    assert.equal(existsSync(join(root, ".sam", "delegations.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "delegations.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    // New proposals ride the DB and never recreate the JSON file.
    const added = proposeDelegation(root, { actor: "sam", adapter: "codex", repo: source, branch: "sam/third", prompt: "third job", timeoutMs: 5_000 }, () => ({ id: "action-del-3" }));
    assert.deepEqual(listDelegations(root).map(d => d.id), ["del-1", "del-2", added.id]);
    assert.equal(getDelegation(root, "action-del-3")?.id, added.id);
    assert.equal(existsSync(join(root, ".sam", "delegations.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true }); }
});

test("delegations store: a malformed or non-array legacy file imports nothing and is left in place", () => {
  const root = fresh();
  const source = repo();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "delegations.json"), "{ not json");
    assert.deepEqual(listDelegations(root), []);
    assert.equal(existsSync(join(root, ".sam", "delegations.json")), true);
    assert.equal(existsSync(join(root, ".sam", "delegations.json.migrated")), false);
    writeFileSync(join(root, ".sam", "delegations.json"), JSON.stringify({ nope: true }));
    assert.deepEqual(listDelegations(root), []);
    assert.equal(existsSync(join(root, ".sam", "delegations.json.migrated")), false);
    // A proposal over the unimportable file rides the DB only.
    const added = proposeDelegation(root, { actor: "sam", adapter: "codex", repo: source, branch: "sam/over-malformed", prompt: "over malformed", timeoutMs: 5_000 }, () => ({ id: "action-over" }));
    assert.equal(getDelegation(root, added.id)?.status, "pending");
    assert.equal(existsSync(join(root, ".sam", "delegations.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true }); }
});

test("delegations store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(listDelegations(root), []);
    assert.equal(getDelegation(root, "nope"), null);
    assert.equal(updateDelegation(root, "nope", { status: "done" }), null);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("delegations store: interleaved proposals and a single-row update all survive (no whole-file lost update)", () => {
  const root = fresh();
  const source = repo();
  try {
    const a = proposeDelegation(root, { actor: "sam", adapter: "codex", repo: source, branch: "sam/alpha", prompt: "alpha", timeoutMs: 5_000 }, () => ({ id: "action-alpha" }));
    const b = proposeDelegation(root, { actor: "sam", adapter: "codex", repo: source, branch: "sam/beta", prompt: "beta", timeoutMs: 5_000 }, () => ({ id: "action-beta" }));
    const patched = updateDelegation(root, a.id, { summary: "alpha corrected" });
    assert.equal(patched?.summary, "alpha corrected");
    assert.equal(patched?.id, a.id);
    assert.equal(updateDelegation(root, "ghost", { summary: "x" }), null);
    const items = listDelegations(root);
    assert.deepEqual(items.map(d => d.id), [a.id, b.id]);
    assert.equal(items[0].summary, "alpha corrected");
    assert.equal(items[1].branch, "sam/beta");
    assert.equal(getDelegation(root, "action-beta")?.id, b.id);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true }); }
});

test("delegations store: a cancel over a migrated legacy record persists in the DB", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const pending = legacyJob("del-cancel", "sam/cancel-me");
    writeFileSync(join(root, ".sam", "delegations.json"), JSON.stringify([pending], null, 2));
    const cancelled = cancelDelegation(root, "del-cancel");
    assert.equal(cancelled.status, "cancelled");
    // The cancellation is the DB row's state, not a file rewrite:
    // a second read returns it and a second cancel refuses.
    assert.equal(getDelegation(root, "del-cancel")?.status, "cancelled");
    assert.throws(() => cancelDelegation(root, "del-cancel"), /already cancelled/);
    assert.equal(existsSync(join(root, ".sam", "delegations.json")), false);
    assert.equal(existsSync(join(root, ".sam", "delegations.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
