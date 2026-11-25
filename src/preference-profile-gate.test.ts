import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { PreferenceStore, preferenceProfileBlocker } from "./preferences.js";

// The profile gate for the preference creation door: every other
// profile-naming creation door reads the profile registry
// before creating anything, but CLI `preferences add <profile>`
// passed the raw profile into PreferenceStore.note, which checks
// only the name's shape, minting a standing LAW bound to nobody -
// law is read back only through lawsFor(a real profile), so a
// bogus profile's law is never injected and governs no one.
// preferenceProfileBlocker is now the ONE source carrying the
// refusal text: the CLI door throws it before opening the store
// or creating anything. The store itself stays permissive by
// design (a profile removed after a preference names it leaves
// the record with its stored binding, and internal callers name
// a profile by construction), so PreferenceStore.note is NOT
// gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-preference-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("preference profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(preferenceProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(preferenceProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preference profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      preferenceProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in preference detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      preferenceProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in preference detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      preferenceProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in preference detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preference profile gate: the CLI door's check creates nothing for a bogus profile", () => {
  const root = fresh();
  try {
    const blocker = preferenceProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    // The CLI door throws this text before calling note;
    // pin that the check alone leaves the preference list empty.
    const store = new PreferenceStore(root);
    try { assert.equal(store.list().length, 0); } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preference profile gate: a registered profile passes the check and the law is stored bound to it", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(preferenceProfileBlocker(root, "second-shift"), null);
    const store = new PreferenceStore(root);
    try {
      const pref = store.note("second-shift", "Always cite the source", "rule", "operator");
      assert.equal(pref.profile, "second-shift");
      assert.equal(pref.status, "law");
      assert.equal(store.lawsFor("second-shift").length, 1);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preference profile gate: the store stays permissive - a preference may name a profile removed later", () => {
  const root = fresh();
  try {
    const store = new PreferenceStore(root);
    try {
      const pref = store.note("trading", "Never chase a move", "rule", "operator");
      assert.equal(pref.profile, "trading");
      assert.equal(store.list("trading").length, 1);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
