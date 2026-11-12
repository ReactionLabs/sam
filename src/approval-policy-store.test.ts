import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApprovalPolicy, readApprovalPolicyStore, saveApprovalPolicy, type ApprovalPolicy } from "./approval-policy.js";
import { listActions, proposeAction, settleAutoApprovals } from "./actions.js";

// State convergence (UNIFICATION item 4, twenty-seventh store):
// the approval policy migrated from whole-file
// approval-policy.json rewrites (a torn write silently reverted
// the ONE gate's posture to manual) to a one-row SQLite
// singleton. These tests pin the migration contract: a legacy
// file imports normalized with every field intact, is renamed
// (never deleted), a malformed / non-object / invalid-mode file
// imports nothing and stays put while reading fail-closed to
// manual, a pure read creates nothing, patch saves merge through
// the DB as single-row UPSERTs, and the gate itself settles
// through the migrated store.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-approval-policy-store-")); }

const LEGACY: ApprovalPolicy = { mode: "smart", autoKinds: ["skill"], updatedAt: "2026-11-10T13:10:26.492Z" };

test("approval policy store: a legacy approval-policy.json imports intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "approval-policy.json"), JSON.stringify(LEGACY, null, 2));
    assert.deepEqual(loadApprovalPolicy(root), LEGACY);
    assert.deepEqual(readApprovalPolicyStore(root), LEGACY);
    assert.equal(existsSync(join(root, ".sam", "approval-policy.db")), true);
    assert.equal(existsSync(join(root, ".sam", "approval-policy.json")), false);
    assert.equal(existsSync(join(root, ".sam", "approval-policy.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "approval-policy.json.migrated"), "utf8")) as ApprovalPolicy;
    assert.deepEqual(kept, LEGACY);
    // A save after migration rides the DB; no JSON is recreated.
    const saved = saveApprovalPolicy(root, { autoKinds: ["skill", "note"] });
    assert.equal(saved.mode, "smart");
    assert.deepEqual(loadApprovalPolicy(root).autoKinds, ["skill", "note"]);
    assert.equal(existsSync(join(root, ".sam", "approval-policy.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approval policy store: import normalizes through the old read shape (invalid kinds filtered, duplicates removed)", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "approval-policy.json"), JSON.stringify({ mode: "smart", autoKinds: ["note", "BAD KIND!", "note", "skill", 7], updatedAt: 42 }));
    assert.deepEqual(loadApprovalPolicy(root), { mode: "smart", autoKinds: ["note", "skill"], updatedAt: null });
    assert.equal(existsSync(join(root, ".sam", "approval-policy.json.migrated")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approval policy store: malformed, non-object, and invalid-mode legacy files import nothing, stay in place, and read fail-closed to manual", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    for (const payload of ["{ not json", JSON.stringify(["not", "an", "object"]), JSON.stringify({ mode: "yolo", autoKinds: ["note"], updatedAt: "2026-11-10T13:10:26.492Z" })]) {
      writeFileSync(join(root, ".sam", "approval-policy.json"), payload);
      assert.deepEqual(loadApprovalPolicy(root), { mode: "manual", autoKinds: [], updatedAt: null }, payload);
      assert.equal(existsSync(join(root, ".sam", "approval-policy.json")), true);
      assert.equal(existsSync(join(root, ".sam", "approval-policy.json.migrated")), false);
    }
    // A save over an unimportable legacy file still lands in the DB;
    // the file itself is left exactly as found.
    const saved = saveApprovalPolicy(root, { mode: "smart", autoKinds: ["note"] });
    assert.equal(saved.mode, "smart");
    assert.equal(loadApprovalPolicy(root).mode, "smart");
    assert.equal(existsSync(join(root, ".sam", "approval-policy.json")), true);
    assert.equal(existsSync(join(root, ".sam", "approval-policy.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approval policy store: a pure read on an empty install creates nothing, and a refused save creates nothing either", () => {
  const root = fresh();
  try {
    assert.deepEqual(loadApprovalPolicy(root), { mode: "manual", autoKinds: [], updatedAt: null });
    assert.deepEqual(readApprovalPolicyStore(root), { mode: "manual", autoKinds: [], updatedAt: null });
    assert.throws(() => saveApprovalPolicy(root, { mode: "smart", autoKinds: ["law"] }), /Smart mode cannot auto-approve consequential/);
    assert.equal(existsSync(join(root, ".sam", "approval-policy.db")), false);
    assert.equal(existsSync(join(root, ".sam", "approval-policy.json")), false);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approval policy store: patch saves merge through the DB (mode patch keeps the auto list, list patch keeps the mode)", () => {
  const root = fresh();
  try {
    saveApprovalPolicy(root, { mode: "smart", autoKinds: ["note", "skill"] });
    const repatched = saveApprovalPolicy(root, { autoKinds: ["note"] });
    assert.equal(repatched.mode, "smart");
    assert.deepEqual(repatched.autoKinds, ["note"]);
    assert.ok(typeof repatched.updatedAt === "string" && repatched.updatedAt.length > 0);
    const off = saveApprovalPolicy(root, { mode: "off" });
    assert.equal(off.mode, "off");
    assert.deepEqual(loadApprovalPolicy(root).autoKinds, ["note"]);
    assert.equal(loadApprovalPolicy(root).mode, "off");
    assert.equal(existsSync(join(root, ".sam", "approval-policy.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approval policy store: the ONE gate settles through the migrated store (a legacy smart policy auto-executes a listed note)", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "approval-policy.json"), JSON.stringify({ mode: "smart", autoKinds: ["note"], updatedAt: "2026-11-10T13:10:26.492Z" }, null, 2));
    const note = proposeAction(root, { actor: "sam", kind: "note", title: "Save", detail: "The launch date is March 3" });
    const law = proposeAction(root, { actor: "sam", kind: "law", title: "Rule", detail: "Always confirm first" });
    const settled = await settleAutoApprovals(root);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].id, note.id);
    assert.equal(settled[0].decidedBy, "auto:smart");
    assert.equal(listActions(root).find(x => x.id === law.id)?.status, "pending");
    assert.equal(existsSync(join(root, ".sam", "approval-policy.json.migrated")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
