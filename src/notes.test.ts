import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyNote, saveNote } from "./notes.js";
import { executeOwnTool, ownToolsFor } from "./own-tools.js";
import { MemoryStore } from "./memory.js";
import { ChatStore } from "./chats.js";
import { listActions, decideAction } from "./actions.js";
import { readActivity } from "./activity.js";

function freshRoot(): string { return mkdtempSync(join(tmpdir(), "sam-notes-")); }
function records(root: string, scope?: string) {
  const store = new MemoryStore(join(root, ".sam", "missions.db"));
  try { return store.list(undefined, scope ? [scope] : undefined); } finally { store.close(); }
}

test("notes: the classifier gates hard changes and frees helpful ones", () => {
  // Soft: the ruled-free classes.
  for (const soft of [
    "The cortado at the corner cafe worked well for the morning meeting",
    "Project context: the stack watch chat is where the frozen-stack reports land",
    "The backup drill on 2026-11-09 found 10 chats and 2 preferences",
    "Trying the cheap tier for the poll first worked better than the main model",
  ]) assert.equal(classifyNote(soft).tier, "soft", soft);
  // Hard: supersession language.
  assert.equal(classifyNote("The lead count replaces the earlier figure").tier, "hard");
  assert.equal(classifyNote("Use the new door link instead of the old one").tier, "hard");
  assert.equal(classifyNote("That address is no longer current").tier, "hard");
  // Hard: identity / addressing - the live Tyler case.
  assert.match(classifyNote("Call the owner Tyler").reason ?? "", /addressed/);
  assert.equal(classifyNote("The owner goes by dip").tier, "hard");
  // Hard: law-like phrasing.
  assert.equal(classifyNote("Always confirm the total before quoting it").tier, "hard");
  assert.equal(classifyNote("Never quote a page size as a total").tier, "hard");
  // Hard: an explicit supersedes target, whatever the wording.
  const named = classifyNote("A perfectly mild observation", { supersedes: "rec-1" });
  assert.equal(named.tier, "hard");
  assert.match(named.reason ?? "", /supersedes/);
});

test("notes: a soft note saves immediately, scoped, ledgered, and revocable", () => {
  const root = freshRoot();
  try {
    const db = new ChatStore(root); db.createAgent("trading", "T."); db.close();
    const r = saveNote(root, { actor: "trading", content: "The stack froze on 2026-11-04 and the counts held all week" });
    assert.equal(r.status, "saved");
    if (r.status !== "saved") return;
    assert.equal(r.record.scope, "profile:trading");
    assert.equal(r.record.source, "sam-saved");
    // Reachable under the profile's own scope, invisible to another's list.
    assert.equal(records(root, "profile:trading").length, 1);
    assert.equal(records(root, "profile:other").length, 0);
    // Ledgered (the dashboard activity surface carries the line).
    const lines = readActivity(root, 10, { kind: "note-saved" });
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /Saved note/);
    // Owner-revocable: archiving retires it from recall.
    const store = new MemoryStore(join(root, ".sam", "missions.db"));
    try { assert.equal(store.archive(r.record.id), true); } finally { store.close(); }
    assert.equal(records(root, "profile:trading").length, 0);
    // No proposal was created for a soft save.
    assert.equal(listActions(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("notes: a hard note routes through the ONE gate and saves only on approval", async () => {
  const root = freshRoot();
  try {
    const r = saveNote(root, { actor: "sam", content: "Call the owner Tyler" });
    assert.equal(r.status, "pending_owner_approval");
    if (r.status !== "pending_owner_approval") return;
    assert.match(r.reason, /addressed/);
    // Nothing in memory yet; exactly one pending note proposal exists.
    assert.equal(records(root).length, 0);
    const pending = listActions(root).filter(a => a.status === "pending" && a.kind === "note");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, r.proposal.id);
    assert.equal(readActivity(root, 10, { kind: "note-gated" }).length, 1);
    // Approval executes through the existing executor: the note lands
    // as an owner-approved record at core scope.
    const decided = await decideAction(root, r.proposal.id, true);
    assert.equal(decided.status, "done");
    const saved = records(root, "core");
    assert.equal(saved.length, 1);
    assert.match(saved[0].content, /Call the owner Tyler/);
    assert.match(saved[0].source, /owner-approved action/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("notes: the chat tool saves soft, gates hard, and refuses visitors", () => {
  const root = freshRoot();
  try {
    const db = new ChatStore(root);
    const ownerChat = db.create("owner chat");
    const visitorChat = db.create("visitor chat", null, { visitor: true });
    db.close();
    const soft = executeOwnTool(root, "sam", "sam_save_note", { content: "The morning brief draft landed well with the shorter shape" }, ownerChat.id) as { status: string; note: string };
    assert.equal(soft.status, "saved");
    assert.match(soft.note, /never silent/);
    const hard = executeOwnTool(root, "sam", "sam_save_note", { content: "Always open with the lead count" }, ownerChat.id) as { status: string; reason: string; note: string };
    assert.equal(hard.status, "pending_owner_approval");
    assert.match(hard.note, /NOT saved directly/);
    const visitor = executeOwnTool(root, "sam", "sam_save_note", { content: "A mild fact from a customer" }, visitorChat.id) as { error: string };
    assert.match(visitor.error, /Visitors cannot save notes/);
    assert.equal(records(root).length, 1);
    // The tool is offered on every chat turn.
    const names = ownToolsFor(root).map(t => (t as { function: { name: string } }).function.name);
    assert.ok(names.includes("sam_save_note"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("notes: validation refuses empty, oversize, and bad kinds before any write", () => {
  const root = freshRoot();
  try {
    assert.throws(() => saveNote(root, { actor: "sam", content: "  " }), /Invalid note content/);
    assert.throws(() => saveNote(root, { actor: "sam", content: "x".repeat(2001) }), /Invalid note content/);
    assert.throws(() => saveNote(root, { actor: "sam", content: "fine", kind: "law" }), /Invalid note kind/);
    assert.equal(records(root).length, 0);
    assert.equal(listActions(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
