import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAction, listActions, proposeAction } from "./actions.js";
import { readActivity } from "./activity.js";
import { ChatStore } from "./chats.js";
import { createDraft, draftShapeBlocker, listDrafts } from "./drafts.js";
import { upsertContact } from "./contacts.js";

// The proposal-time execution gate for kinds say and draft:
// neither kind had any proposal-time validation - the detail
// was parsed only at execution, where ChatStore.add refuses a
// missing chat or blank text and createDraft refuses on shape
// alone, so a malformed detail was a dead card. draftShape
// Blocker is the ONE source for the draft shape rules; the
// say gate parses the JSON shape and reads the named chat
// back. The no-drafts contact fence is deliberately NOT
// gated: it stays an execution-time refusal by design.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-say-draft-gate-")); }

function makeChat(root: string): string {
  const chats = new ChatStore(root);
  try { return chats.create("Gate chat", "sam").id; } finally { chats.close(); }
}

test("draft gate: a shape-breaking detail refuses at proposal in the ONE source's words and creates nothing", () => {
  const root = fresh();
  try {
    const detail = JSON.stringify({ to: "Rick Ruiz", channel: "pigeon", body: "hi" });
    const blocker = draftShapeBlocker({ to: "Rick Ruiz", channel: "pigeon", body: "hi" });
    assert.equal(blocker, "Invalid draft channel");
    let err = "";
    try { proposeAction(root, { actor: "sam", kind: "draft", title: "Bad channel", detail }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert.equal(err, blocker);
    assert.equal(listActions(root).length, 0);
    assert.equal(readActivity(root).filter(l => l.kind === "proposal").length, 0);
    assert.deepEqual(listDrafts(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft gate: the refusal is byte-identical at proposal and at the store write", () => {
  const root = fresh();
  try {
    let proposed = "";
    try { proposeAction(root, { actor: "sam", kind: "draft", title: "No body", detail: JSON.stringify({ to: "Rick Ruiz", body: "  " }) }); } catch (e) { proposed = e instanceof Error ? e.message : String(e); }
    let direct = "";
    try { createDraft(root, { actor: "sam", to: "Rick Ruiz", body: "  " }); } catch (e) { direct = e instanceof Error ? e.message : String(e); }
    assert.equal(proposed, "Invalid draft body");
    assert.equal(proposed, direct);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft gate: a non-JSON detail and an over-long subject refuse at proposal; a valid detail proposes and executes", async () => {
  const root = fresh();
  try {
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "draft", title: "Plain", detail: "just text" }), /Invalid draft detail/);
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "draft", title: "Long subject", detail: JSON.stringify({ to: "Rick Ruiz", subject: "s".repeat(201), body: "hi" }) }), /Invalid draft subject/);
    const p = proposeAction(root, { actor: "sam", kind: "draft", title: "Good", detail: JSON.stringify({ to: "Rick Ruiz", channel: "EMAIL", body: "Thanks." }) });
    assert.equal(p.status, "pending");
    const decided = await decideAction(root, p.id, true);
    assert.equal(decided.status, "done");
    assert.equal(listDrafts(root).length, 1);
    assert.equal(listDrafts(root)[0].channel, "email");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft gate: the no-drafts fence is NOT gated - the proposal pends and the refusal lands at execution, by design", async () => {
  const root = fresh();
  try {
    upsertContact(root, { name: "Do Not Write", note: "Owner handles her personally", noDraft: true });
    const p = proposeAction(root, { actor: "sam", kind: "draft", title: "Note", detail: JSON.stringify({ to: "Do Not Write", channel: "email", body: "hello" }) });
    assert.equal(p.status, "pending");
    const decided = await decideAction(root, p.id, true);
    assert.equal(decided.status, "failed");
    assert.match(decided.result ?? "", /no-drafts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("say gate: a non-JSON detail, a blank text, and a missing chat refuse at proposal and create nothing", () => {
  const root = fresh();
  try {
    const chatId = makeChat(root);
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "say", title: "Plain", detail: "Send the update to the group." }), /Invalid say detail/);
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "say", title: "Blank", detail: JSON.stringify({ chatId, text: "  " }) }), /Invalid say text/);
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "say", title: "Ghost", detail: JSON.stringify({ chatId: "no-such-chat", text: "hi" }) }), /Chat not found/);
    assert.equal(listActions(root).length, 0);
    assert.equal(readActivity(root).filter(l => l.kind === "proposal").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("say gate: a valid detail proposes and executes into the named chat", async () => {
  const root = fresh();
  try {
    const chatId = makeChat(root);
    const p = proposeAction(root, { actor: "sam", kind: "say", title: "Post it", detail: JSON.stringify({ chatId, text: "The update is live." }) });
    assert.equal(p.status, "pending");
    const decided = await decideAction(root, p.id, true);
    assert.equal(decided.status, "done");
    const chats = new ChatStore(root);
    try {
      const msgs = chats.messages(chatId);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].content, "The update is live.");
      assert.equal(msgs[0].role, "assistant");
    } finally { chats.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
