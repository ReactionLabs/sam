import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { addChannel } from "./channels.js";
import { bindingProfileBlocker, listBindings, setBinding } from "./bindings.js";

// The profile gate for the channel bind door: every
// profile-naming creation door reads the profile registry
// through a ONE source in its owning module before writing
// anything - but CLI `channels bind --profile` carried a
// one-off inline check in cli.ts with its own refusal text
// and no fold correction, so a folded name ("Second Shift"
// for "second-shift") was refused with only the bare list
// while every sibling door names the correction.
// bindingProfileBlocker in bindings.ts is now the ONE
// source carrying the refusal text: the CLI bind door
// throws it before setting anything. setBinding itself
// stays permissive by design (a profile removed after a
// binding names it keeps its stored binding; the CLI is
// its only caller), so it is NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-binding-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("binding profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(bindingProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(bindingProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("binding profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      bindingProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in channel binding. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      bindingProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in channel binding. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      bindingProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in channel binding. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("binding profile gate: an ambiguous fold names no correction", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    register(root, "second_shift");
    assert.equal(
      bindingProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in channel binding. Valid profiles: sam, second-shift, second_shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("binding profile gate: the door's check sets nothing for a bogus profile", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    const blocker = bindingProfileBlocker(root, "Second Shift");
    assert.ok(blocker);
    // The door throws this text before calling setBinding;
    // pin that the check alone leaves no binding behind.
    assert.deepEqual(listBindings(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("binding profile gate: a registered profile passes the gate and binds", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(bindingProfileBlocker(root, "second-shift"), null);
    const channel = addChannel(root, "telegram", "Dip Telegram", "sam", "SAM_CHANNEL_TG_MAIN", []);
    const binding = setBinding(root, { channelId: channel.id, peer: null, profile: "second-shift" });
    assert.equal(binding.profile, "second-shift");
    assert.equal(listBindings(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
