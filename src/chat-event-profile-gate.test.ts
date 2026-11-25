import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore, chatEventProfileBlocker } from "./chats.js";

// The profile gate for the chat event door: every
// profile-naming creation, queue, propose, and
// standing-instruction door reads the profile registry
// before writing anything, and the managed-chat doors
// are ownership-checked inside their seam, but CLI
// `chats event --agent` passed the raw agent name into
// ChatStore.addEvent, which checks only the name's
// shape - recording a team event in a real chat's
// thread (the dashboard renders team events as bubbles)
// attributed to an agent that does not exist, even
// though the door's own --agent description promised a
// registered agent identifier. chatEventProfileBlocker
// is now the ONE source carrying the refusal text: the
// CLI event door throws it before recording anything.
// ChatStore.addEvent itself stays permissive by design
// (a profile removed after an event names it leaves the
// event with its stored attribution, and the internal
// writers - the team runtime's "sam" and its standing
// members, the orchestration lane's "sam" - name their
// agent by construction), so it is NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-chat-event-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("chat event profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(chatEventProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(chatEventProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat event profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      chatEventProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in chat event detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      chatEventProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in chat event detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      chatEventProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in chat event detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat event profile gate: the door's check records nothing for a bogus agent", () => {
  const root = fresh();
  try {
    const db = new ChatStore(root);
    let chatId: string;
    try {
      chatId = db.create("Event chat", null).id;
    } finally { db.close(); }
    const blocker = chatEventProfileBlocker(root, "nosuchagent");
    assert.ok(blocker);
    // The door throws this text before calling addEvent;
    // pin that the check alone leaves the thread empty.
    const check = new ChatStore(root);
    try { assert.equal(check.events(chatId).length, 0); } finally { check.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat event profile gate: a registered agent passes the check and its event really records", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(chatEventProfileBlocker(root, "second-shift"), null);
    const db = new ChatStore(root);
    try {
      const chat = db.create("Event chat", null);
      const event = db.addEvent(chat.id, "second-shift", "message", "Reporting in");
      assert.equal(event.agent, "second-shift");
      assert.equal(db.events(chat.id).length, 1);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat event profile gate: addEvent stays permissive - an event may name a profile removed later", () => {
  const root = fresh();
  try {
    const db = new ChatStore(root);
    try {
      const chat = db.create("Event chat", null);
      const event = db.addEvent(chat.id, "trading", "message", "Legacy attribution");
      assert.equal(event.agent, "trading");
      assert.equal(db.events(chat.id).length, 1);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
