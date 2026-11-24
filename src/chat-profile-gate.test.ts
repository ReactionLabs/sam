import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore, chatProfileBlocker } from "./chats.js";

// The profile gate for chat creation doors: the dashboard
// door validates the profile registry before creating a
// chat (an agent outside the registry is refused), but the
// terminal doors - CLI `chats new --profile` and
// `sam tui --profile` - passed the raw profile into
// ChatStore.create, which checks only the name's shape,
// minting a chat bound to nobody whose turns resolve no
// registered profile and run unscoped. chatProfileBlocker
// is now the ONE source carrying the refusal text: the CLI
// door throws it before creating anything and the TUI
// refuses with it before opening its Terminal chat. The
// store itself stays permissive by design (a profile
// removed after a chat names it leaves the chat with its
// stored binding), so ChatStore.create is NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-chat-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("chat profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(chatProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(chatProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      chatProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in chat detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      chatProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in chat detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      chatProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in chat detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat profile gate: the CLI door's check creates nothing for a bogus profile", () => {
  const root = fresh();
  try {
    const blocker = chatProfileBlocker(root, "nosuchprofile");
    assert.ok(blocker);
    // The CLI door throws this text before calling create;
    // pin that the check alone leaves the chat list empty.
    const db = new ChatStore(root);
    try { assert.equal(db.list().length, 0); } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat profile gate: a registered profile passes the check and the chat is created bound to it", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.equal(chatProfileBlocker(root, "second-shift"), null);
    const db = new ChatStore(root);
    try {
      const chat = db.create("Scoped chat", "second-shift");
      assert.equal(chat.agent_name, "second-shift");
      assert.equal(db.list().length, 1);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat profile gate: the store stays permissive - a chat may name a profile removed later", () => {
  const root = fresh();
  try {
    const db = new ChatStore(root);
    try {
      const chat = db.create("Legacy chat", "trading");
      assert.equal(chat.agent_name, "trading");
      assert.equal(db.list().length, 1);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
