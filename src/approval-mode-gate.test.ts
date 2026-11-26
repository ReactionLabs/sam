import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalModeBlocker, loadApprovalPolicy, saveApprovalPolicy, APPROVAL_MODES } from "./approval-policy.js";

// The approval-mode gate: the approval mode is a registry
// name (APPROVAL_MODES: manual, smart, off) that two doors
// resolved through their own inline checks - saveApprovalPolicy
// itself and the CLI `approvals set-mode` door - each
// improvising the identical "Invalid approval mode" refusal
// with no fold correction, so a folded name ("Manual",
// "SMART") dead-ended with nothing to act on.
// approvalModeBlocker in approval-policy.ts is now the ONE
// source carrying the refusal text, and saveApprovalPolicy
// throws it before anything is saved. parsePolicy and the
// migrated loader stay permissive by design (a bad stored
// mode fails closed to manual), so neither is gated here.

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "sam-approval-mode-gate-"));
}

test("approval mode gate: an exact mode reads no blocker", () => {
  assert.equal(approvalModeBlocker("manual"), null);
  assert.equal(approvalModeBlocker("smart"), null);
  assert.equal(approvalModeBlocker("off"), null);
  for (const mode of APPROVAL_MODES) assert.equal(approvalModeBlocker(mode), null);
});

test("approval mode gate: an unknown mode names the modes, no correction", () => {
  const blocker = approvalModeBlocker("yolo")!;
  assert.equal(blocker, "Invalid approval mode \"yolo\". Modes: manual, smart, off");
  const root = fresh();
  try {
    assert.throws(() => saveApprovalPolicy(root, { mode: "yolo" as never }), (e: unknown) => e instanceof Error && e.message === blocker);
    assert.equal(loadApprovalPolicy(root).mode, "manual");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approval mode gate: a folded name is refused with the correction", () => {
  assert.match(approvalModeBlocker("Manual")!, /Did you mean "manual"\?$/);
  assert.match(approvalModeBlocker("SMART")!, /Did you mean "smart"\?$/);
  assert.match(approvalModeBlocker("off ")!, /Did you mean "off"\?$/);
  const root = fresh();
  try {
    assert.throws(() => saveApprovalPolicy(root, { mode: "Manual" as never }), (e: unknown) => e instanceof Error && e.message === approvalModeBlocker("Manual"));
    assert.equal(loadApprovalPolicy(root).mode, "manual");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approval mode gate: a non-string value refuses naming the registry, no correction", () => {
  assert.equal(approvalModeBlocker(undefined), "Invalid approval mode \"undefined\". Modes: manual, smart, off");
  assert.equal(approvalModeBlocker(""), "Invalid approval mode \"\". Modes: manual, smart, off");
});

test("approval mode gate: an exact mode still saves through saveApprovalPolicy", () => {
  const root = fresh();
  try {
    const policy = saveApprovalPolicy(root, { mode: "smart", autoKinds: ["note"] });
    assert.equal(policy.mode, "smart");
    assert.equal(loadApprovalPolicy(root).mode, "smart");
    assert.equal(approvalModeBlocker(policy.mode), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
