import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import {
  approvalPolicyFailureSummary, isApprovalPolicyLedgered,
  loadApprovalPolicy, readApprovalPolicyStore, saveApprovalPolicy,
} from "./approval-policy.js";
import { settleAutoApprovals } from "./actions.js";
import { openDatabase } from "./sqlite.js";
import { classifyDefect } from "./self-work.js";

// Approval-policy store failure visibility (gap found
// 2026-11-14, hourly run 18:04): the approval policy store
// (.sam/approval-policy.db) is the ONE gate's own posture -
// loadApprovalPolicy rides settleAutoApprovals, the status
// payload, the self-audit, and the CLI mode view;
// saveApprovalPolicy is the operator's write door - and
// every touch opened the store raw: a dead store threw into
// whichever catch wrapped the call, none naming the store,
// so the gate's posture itself could be blind and
// uncountable (and folding a dead store to manual would
// silently revert the owner's chosen posture). Each touch
// now ledgers ONE approval-policy-failed line (phase read /
// write) and rethrows exactly, tagged; every caller's
// handling is unchanged and reads still fail closed.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-approval-policy-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "approval-policy-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "approval-policy.db"), { force: true });
  mkdirSync(join(root, ".sam", "approval-policy.db"), { recursive: true });
}

test("approval-policy-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(approvalPolicyFailureSummary("read", "unable to open\n  database   file"), "Approval policy read failed: unable to open database file");
  assert.equal(approvalPolicyFailureSummary("write", "disk gone"), "Approval policy write failed: disk gone");
  assert.equal(approvalPolicyFailureSummary("read", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "approval-policy-failed", summary: approvalPolicyFailureSummary(phase, "boom") }),
      { key: "approval-policy-failed:" + phase, label: "approval policy store failures (" + phase + " step)" },
    );
  }
});

test("approval-policy-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", async () => {
  const root = scratch();
  try {
    saveApprovalPolicy(root, { mode: "smart", autoKinds: ["note"] });
    plantDeadStore(root);

    assert.throws(() => loadApprovalPolicy(root), (e: unknown) => isApprovalPolicyLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Approval policy read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "approval-policy-failed:read", label: "approval policy store failures (read step)" });

    // The gate's settle rides the same read door: one touch,
    // one more read line, never a fold to manual.
    await assert.rejects(() => settleAutoApprovals(root), (e: unknown) => isApprovalPolicyLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "the settle's read touch ledgers exactly one more line");
    assert.ok(lines[1].summary.startsWith("Approval policy read failed: "), lines[1].summary);

    // A save on a dead store dies at its internal current-
    // policy read: exactly one read line, no second write
    // line for the same touch.
    assert.throws(() => saveApprovalPolicy(root, { mode: "off" }), (e: unknown) => isApprovalPolicyLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3, "the save's internal read ledgers exactly one more line, never two for one touch");
    assert.ok(lines[2].summary.startsWith("Approval policy read failed: "), lines[2].summary);

    assert.ok(!JSON.stringify(lines).includes("smart"), "no policy content ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approval-policy-failed: a write that dies after a healthy read ledgers exactly one write line", () => {
  const root = scratch();
  try {
    saveApprovalPolicy(root, { mode: "smart", autoKinds: ["note"] });
    const raw = openDatabase(join(root, ".sam", "approval-policy.db"));
    try {
      raw.exec("CREATE TRIGGER planted_save_fail_ins BEFORE INSERT ON approval_policy BEGIN SELECT RAISE(ABORT, 'planted save failure'); END;");
      raw.exec("CREATE TRIGGER planted_save_fail_upd BEFORE UPDATE ON approval_policy BEGIN SELECT RAISE(ABORT, 'planted save failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => saveApprovalPolicy(root, { mode: "off" }), (e: unknown) => isApprovalPolicyLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the healthy read ledgers nothing; the dying write ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Approval policy write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted save failure"), "the verbatim reason rides the line");
    assert.deepEqual(classifyDefect(lines[0]), { key: "approval-policy-failed:write", label: "approval policy store failures (write step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approval-policy-failed: an absent store reads the manual default, and nothing is created or ledgered", () => {
  const root = scratch();
  try {
    assert.deepEqual(loadApprovalPolicy(root), { mode: "manual", autoKinds: [], updatedAt: null });
    assert.deepEqual(readApprovalPolicyStore(root), { mode: "manual", autoKinds: [], updatedAt: null });
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam", "approval-policy.db")), false, "a pure read creates no store");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing at all");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approval-policy-failed: validation errors are not store failures and ledger nothing", () => {
  const root = scratch();
  try {
    assert.throws(() => saveApprovalPolicy(root, { mode: "yolo" as never }), /Invalid approval mode/);
    assert.throws(() => saveApprovalPolicy(root, { mode: "smart", autoKinds: ["law"] }), /Smart mode cannot auto-approve consequential/);
    assert.equal(failedLines(root).length, 0);
    assert.equal(existsSync(join(root, ".sam", "approval-policy.db")), false, "a refused save creates no store");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approval-policy-failed: a torn row payload and a malformed legacy file still read forgiving to manual, with no line", () => {
  const root = scratch();
  try {
    saveApprovalPolicy(root, { mode: "smart", autoKinds: ["note"] });
    const raw = openDatabase(join(root, ".sam", "approval-policy.db"));
    try { raw.prepare("UPDATE approval_policy SET data = ? WHERE id = 1").run("not json"); } finally { raw.close(); }
    assert.deepEqual(loadApprovalPolicy(root), { mode: "manual", autoKinds: [], updatedAt: null });
    assert.equal(failedLines(root).length, 0, "a forgiving parse is not a store failure");
  } finally { rmSync(root, { recursive: true, force: true }); }

  const legacy = scratch();
  try {
    mkdirSync(join(legacy, ".sam"), { recursive: true });
    writeFileSync(join(legacy, ".sam", "approval-policy.json"), "{ not json");
    assert.deepEqual(loadApprovalPolicy(legacy), { mode: "manual", autoKinds: [], updatedAt: null });
    assert.equal(existsSync(join(legacy, ".sam", "approval-policy.json")), true, "the malformed file is left in place");
    assert.equal(failedLines(legacy).length, 0, "a silent legacy import failure is not a store failure");
  } finally { rmSync(legacy, { recursive: true, force: true }); }
});

test("approval-policy-failed: a healthy policy saves and reads back with zero failure lines", () => {
  const root = scratch();
  try {
    const saved = saveApprovalPolicy(root, { mode: "smart", autoKinds: ["note", "skill"] });
    assert.equal(saved.mode, "smart");
    assert.deepEqual(loadApprovalPolicy(root).autoKinds.sort(), ["note", "skill"]);
    assert.deepEqual(readApprovalPolicyStore(root).mode, "smart");
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
