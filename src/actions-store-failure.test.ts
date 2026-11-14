import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import {
  actionStoreFailureSummary, decideAction, isActionStoreLedgered,
  listActions, proposeAction,
} from "./actions.js";
import { classifyDefect } from "./self-work.js";

// Action store failure visibility (gap found 2026-11-14,
// hourly run 17:04): the action store (.sam/actions.db) is
// the ONE approval gate's own store - listActions rides the
// dashboard status build, the CLI actions views,
// decideAction, and settleAutoApprovals; insertAction is
// proposeAction's write; updateAction is every decision's
// write - and every touch opened the store raw: a dead
// actions.db threw into whichever catch wrapped the call,
// none naming the store, so the gate itself could be blind
// and uncountable. Each touch now ledgers ONE
// action-store-failed line (phase read / write) and rethrows
// exactly, tagged; every caller's handling is unchanged and
// reads still fail closed (never folded as no proposals,
// which would hide pending cards the owner must decide).
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-actions-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "action-store-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "actions.db"), { force: true });
  mkdirSync(join(root, ".sam", "actions.db"), { recursive: true });
}

test("action-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(actionStoreFailureSummary("read", "unable to open\n  database   file"), "Action store read failed: unable to open database file");
  assert.equal(actionStoreFailureSummary("write", "disk gone"), "Action store write failed: disk gone");
  assert.equal(actionStoreFailureSummary("read", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "action-store-failed", summary: actionStoreFailureSummary(phase, "boom") }),
      { key: "action-store-failed:" + phase, label: "action store failures (" + phase + " step)" },
    );
  }
});

test("action-store-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", async () => {
  const root = scratch();
  try {
    const healthy = proposeAction(root, { actor: "sam", kind: "note", title: "Remember the gate secret", detail: "The gate detail nobody may leak" });
    plantDeadStore(root);

    assert.throws(() => listActions(root), (e: unknown) => isActionStoreLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Action store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "action-store-failed:read", label: "action store failures (read step)" });

    await assert.rejects(() => decideAction(root, healthy.id, true), (e: unknown) => isActionStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "the decision's read touch ledgers exactly one more line, never two for one touch");
    assert.ok(lines[1].summary.startsWith("Action store read failed: "), lines[1].summary);

    assert.throws(
      () => proposeAction(root, { actor: "sam", kind: "note", title: "Another gated title", detail: "Another secret detail" }),
      (e: unknown) => isActionStoreLedgered(e),
    );
    lines = failedLines(root);
    assert.equal(lines.length, 3, "the proposal's insert touch ledgers exactly one more line");
    assert.ok(lines[2].summary.startsWith("Action store write failed: "), lines[2].summary);
    assert.deepEqual(classifyDefect(lines[2]), { key: "action-store-failed:write", label: "action store failures (write step)" });

    assert.ok(!JSON.stringify(lines).includes("Remember the gate secret"), "no proposal title ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("gate detail nobody may leak"), "no proposal detail ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("Another gated title"), "no second proposal title ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("action-store-failed: an absent store reads as no proposals, and nothing is created or ledgered", async () => {
  const root = scratch();
  try {
    assert.deepEqual(listActions(root), []);
    await assert.rejects(() => decideAction(root, "nope", true), /Unknown action/);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam", "actions.db")), false, "a pure read creates no store");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing at all");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("action-store-failed: validation errors and the never-list refusal are not store failures and ledger nothing", () => {
  const root = scratch();
  try {
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "bogus", title: "T", detail: "D" }), /Invalid action kind/);
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "note", title: "  ", detail: "D" }), /Invalid action title/);
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "note", title: "T", detail: "  " }), /Invalid action detail/);
    assert.throws(() => proposeAction(root, { actor: "Bad Actor", kind: "note", title: "T", detail: "D" }), /Invalid actor/);
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "note", title: "Cleanup", detail: "rm -rf /" }), /never-list/);
    assert.equal(failedLines(root).length, 0);
    assert.deepEqual(listActions(root), [], "a refused proposal never becomes a card");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("action-store-failed: a healthy store proposes, lists, and decides with zero failure lines", async () => {
  const root = scratch();
  try {
    const p = proposeAction(root, { actor: "sam", kind: "note", title: "Remember this", detail: "A helpful fact" });
    assert.equal(listActions(root).length, 1);
    const decided = await decideAction(root, p.id, true);
    assert.equal(decided.status, "done");
    assert.equal(listActions(root)[0].status, "done");
    assert.equal(failedLines(root).length, 0);
    assert.equal(readActivity(root, 100, { kind: "failed" }).length, 0, "the healthy execution ledgers no execution failure either");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
