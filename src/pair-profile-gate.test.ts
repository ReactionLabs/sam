import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { pairProfileBlocker, validatePairDetail } from "./connector-pairing.js";
import { connectors } from "./connectors.js";
import { setVaultCredential } from "./vault.js";

// The profile gate for the pair door: every profile-naming
// door reads the profile registry through a ONE source in
// its owning module carrying the refusal text with a fold
// correction - but validatePairSpec checked the pair
// detail's profile inline and refused with the bare list,
// so a folded name ("Second Shift" for "second-shift")
// was refused with nothing to act on while every sibling
// door names the correction. pairProfileBlocker in
// connector-pairing.ts is now the ONE source carrying the
// refusal text, and validatePairSpec throws it, so the
// ONE gate's proposal validation, the gate's executor,
// and the operator CLI `sam pair` door all refuse in the
// same words before anything is registered, bound, or
// pinned. pairConnector's execution-time re-validation
// and rollback semantics are untouched.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-pair-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("pair profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(pairProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(pairProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pair profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      pairProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in pair detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      pairProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in pair detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      pairProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in pair detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pair profile gate: an ambiguous fold names no correction", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    register(root, "second_shift");
    assert.equal(
      pairProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in pair detail. Valid profiles: sam, second-shift, second_shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pair profile gate: validatePairDetail throws the ONE source's words and registers nothing", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    setVaultCredential(root, "operator", "bridge-key", "pair-gate-secret", { purpose: "Pair gate test" });
    assert.throws(
      () => validatePairDetail(root, JSON.stringify({ name: "Bridge", url: "http://127.0.0.1:8765/mcp", vaultKey: "bridge-key", profile: "Second Shift" })),
      (e: unknown) => e instanceof Error && e.message === "Unknown profile \"Second Shift\" in pair detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.deepEqual(connectors(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pair profile gate: a registered profile passes validation through the same door", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    setVaultCredential(root, "operator", "bridge-key", "pair-gate-secret", { purpose: "Pair gate test" });
    const clean = validatePairDetail(root, JSON.stringify({ name: "Bridge", url: "http://127.0.0.1:8765/mcp", vaultKey: "bridge-key", profile: "second-shift" }));
    assert.equal(clean.profile, "second-shift");
    assert.deepEqual(connectors(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
