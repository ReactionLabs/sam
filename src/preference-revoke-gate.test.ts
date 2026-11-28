import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreferenceStore, findPreference, preferenceRevokeBlocker, type Preference } from "./preferences.js";

// The preference gate for the preferences revoke door:
// preferences are listed by id, but `sam preferences
// revoke <id>` rode PreferenceStore.revoke alone and
// carried no description, so an unknown id - or a real
// id typed folded (upper-case, or without its hyphens) -
// silently returned {revoked:false}, naming nothing, at
// the door that kills standing LAW: a revoke the owner
// believes landed leaves the law in force in every
// prompt, and one that never existed reads exactly the
// same; an already-revoked id read the same false again.
// The id IS the key, so the registry the blocker names
// is the preferences themselves, each described ONLY by
// id, profile, kind, and status - a preference's
// statement is the owner's own words and never enters a
// refusal. The CLI revoke door now resolves through
// findPreference (throwing preferenceRevokeBlocker, the
// ONE source over the preferences registry alone for
// this door, before anything is revoked) and revokes by
// the resolved id; PreferenceStore.revoke keeps its
// boolean contract (false on a miss) for internal
// callers - the store seam stays permissive by design.

function fresh(): { root: string; first: Preference; second: Preference } {
  const root = mkdtempSync(join(tmpdir(), "sam-preference-revoke-gate-"));
  const store = new PreferenceStore(root);
  try {
    const first = store.note("sam", "Always answer in metric units", "rule", "test");
    const second = store.note("trading", "short answers", "like", "test");
    return { root, first, second };
  } finally { store.close(); }
}

function registry(root: string): string {
  const store = new PreferenceStore(root);
  try {
    return store.list().map(p => p.id + " (profile " + p.profile + ", kind " + p.kind + ", status " + p.status + ")").join(", ");
  } finally { store.close(); }
}

test("preference revoke gate: an exact live id reads no blocker and revokes by the resolved id", () => {
  const { root, first } = fresh();
  try {
    assert.equal(preferenceRevokeBlocker(root, first.id), null);
    const resolved = findPreference(root, first.id);
    assert.equal(resolved.id, first.id);
    const store = new PreferenceStore(root);
    try {
      assert.equal(store.revoke(resolved.id), true);
      assert.equal(store.get(first.id)?.status, "revoked");
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preference revoke gate: a folded id is refused with the correction, revokes nothing, and names no statement", () => {
  const { root, first } = fresh();
  try {
    const folded = first.id.toUpperCase();
    const blocker = preferenceRevokeBlocker(root, folded)!;
    assert.equal(
      blocker,
      "Preference not found: \"" + folded + "\". Preferences: " + registry(root)
        + ". Did you mean \"" + first.id + "\"?",
    );
    assert.doesNotMatch(blocker, /metric units|short answers/);
    assert.throws(() => findPreference(root, folded), (e: unknown) => e instanceof Error && e.message === blocker);
    const store = new PreferenceStore(root);
    try { assert.equal(store.get(first.id)?.status, "law"); } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preference revoke gate: a hyphen-less folded id corrects the same way", () => {
  const { root, second } = fresh();
  try {
    const folded = second.id.replace(/-/g, "");
    const blocker = preferenceRevokeBlocker(root, folded)!;
    assert.match(blocker, new RegExp("\\. Did you mean \"" + second.id + "\"\\?$"));
    const store = new PreferenceStore(root);
    try { assert.equal(store.get(second.id)?.status, "noted"); } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preference revoke gate: an unknown id names the registry with no correction and no statement", () => {
  const { root } = fresh();
  try {
    const ghost = "123e4567-e89b-12d3-a456-426614174000";
    const blocker = preferenceRevokeBlocker(root, ghost)!;
    assert.equal(blocker, "Preference not found: \"" + ghost + "\". Preferences: " + registry(root));
    assert.doesNotMatch(blocker, /metric units|short answers/);
    assert.throws(() => findPreference(root, ghost));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preference revoke gate: an empty registry names none registered", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-preference-revoke-gate-"));
  try {
    assert.equal(
      preferenceRevokeBlocker(root, "123e4567-e89b-12d3-a456-426614174000"),
      "Preference not found: \"123e4567-e89b-12d3-a456-426614174000\". Preferences: none registered",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preference revoke gate: an already-revoked id refuses naming that state, distinct from a miss", () => {
  const { root, first } = fresh();
  try {
    const store = new PreferenceStore(root);
    try { assert.equal(store.revoke(first.id), true); } finally { store.close(); }
    const blocker = preferenceRevokeBlocker(root, first.id)!;
    assert.equal(blocker, "Preference \"" + first.id + "\" is already revoked. Preferences: " + registry(root));
    assert.doesNotMatch(blocker, /metric units|short answers/);
    assert.throws(() => findPreference(root, first.id), (e: unknown) => e instanceof Error && e.message === blocker);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preference revoke gate: the store seam keeps its boolean contract", () => {
  const { root, first } = fresh();
  try {
    const store = new PreferenceStore(root);
    try {
      assert.equal(store.revoke("nope"), false);
      assert.equal(store.revoke(first.id), true);
      assert.equal(store.revoke(first.id), false);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
