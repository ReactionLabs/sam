import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { relayProfileBlocker, relayTargetsForProfile } from "./relay.js";

// The profile gate for the relay door: every profile-naming
// door reads the profile registry through a ONE source in
// its owning module carrying the refusal text with a fold
// correction - but the CLI relay --profile door refused
// with the bare "Unknown profile: X", naming no registry
// and offering no correction. relayProfileBlocker in
// relay.ts is now the ONE source carrying the refusal
// text, and the CLI relay door throws it before any route
// is resolved or any model call is spent.
// relayTargetsForProfile stays permissive by design - its
// by-construction caller names the speaking chat's own
// profile - and is NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-relay-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("relay profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(relayProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(relayProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relay profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      relayProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in relay detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      relayProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in relay detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      relayProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in relay detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relay profile gate: an ambiguous fold names no correction", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    register(root, "second_shift");
    assert.equal(
      relayProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in relay detail. Valid profiles: sam, second-shift, second_shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relay profile gate: relayTargetsForProfile stays permissive for a by-construction caller", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.doesNotThrow(() => relayTargetsForProfile(root, "Second Shift", null, {}));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relay profile gate: a registered profile passes the blocker and its targets resolve without throwing", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(relayProfileBlocker(root, "second-shift"), null);
    assert.doesNotThrow(() => relayTargetsForProfile(root, "second-shift", null, {}));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
