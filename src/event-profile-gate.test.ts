import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { bindEvent, eventBindings, eventProfileBlocker } from "./events.js";

// The profile gate for the event bind door: every
// profile-naming creation door reads the profile registry
// through a ONE source in its owning module before writing
// anything - but CLI `events bind <profile>` carried a
// one-off inline check in cli.ts whose refusal was the bare
// "Unknown profile: X", naming no registry and offering no
// fold correction, so a folded name ("Second Shift" for
// "second-shift") was refused with nothing to act on while
// every sibling door names the correction.
// eventProfileBlocker in events.ts is now the ONE source
// carrying the refusal text: the CLI bind door throws it
// before binding anything. bindEvent itself stays
// permissive by design (a profile removed after a binding
// names it keeps its stored binding; the CLI is its only
// creation caller), so it is NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-event-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("event profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(eventProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(eventProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      eventProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in event binding. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      eventProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in event binding. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      eventProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in event binding. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event profile gate: an ambiguous fold names no correction", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    register(root, "second_shift");
    assert.equal(
      eventProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in event binding. Valid profiles: sam, second-shift, second_shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event profile gate: the door's check binds nothing for a bogus profile", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    const blocker = eventProfileBlocker(root, "Second Shift");
    assert.ok(blocker);
    // The door throws this text before calling bindEvent;
    // pin that the check alone leaves no binding behind.
    assert.deepEqual(eventBindings(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event profile gate: a registered profile passes the gate and binds", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(eventProfileBlocker(root, "second-shift"), null);
    const row = bindEvent(root, { name: "lead-arrived", profile: "second-shift", secretEnv: "SAM_EVENT_TEST_SECRET" });
    assert.equal(row.profile, "second-shift");
    assert.equal(eventBindings(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
