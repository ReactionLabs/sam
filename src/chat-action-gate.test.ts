import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatActionBlocker, chatActions } from "./chat-manage.js";
import { executeOwnToolAsync } from "./own-tools.js";
import { ChatStore } from "./chats.js";

// The chat action gate: the action is a registry name
// (chatActions in chat-manage.ts: list, create, rename,
// pin, unpin, branch, archive, unarchive, organize,
// search) that the model names into the sam_manage_chats
// tool, whose dispatch in own-tools.ts is the ONE seam
// every chat-management action rides. The dispatch
// refused an unknown action with the bare "Unknown chat
// action: X" - echoing the value but naming none of the
// ten actions and offering no fold correction, so a
// folded action dead-ended. chatActionBlocker in
// chat-manage.ts is now the ONE source carrying the
// refusal text. Stored chat data is unchanged: actions
// are never stored, so nothing reads them back.

test("chat action gate: every exact action reads no blocker, and the registry names the ten actions", () => {
  for (const action of chatActions) assert.equal(chatActionBlocker(action), null, action);
  assert.deepEqual([...chatActions], ["list", "create", "rename", "pin", "unpin", "branch", "archive", "unarchive", "organize", "search"]);
});

test("chat action gate: an unknown action echoes the value and names the actions, no correction", () => {
  assert.equal(
    chatActionBlocker("delete"),
    "Unknown chat action \"delete\". Actions: list, create, rename, pin, unpin, branch, archive, unarchive, organize, search",
  );
  assert.equal(
    chatActionBlocker("tidy"),
    "Unknown chat action \"tidy\". Actions: list, create, rename, pin, unpin, branch, archive, unarchive, organize, search",
  );
});

test("chat action gate: a folded action is refused with the correction", () => {
  assert.match(chatActionBlocker("List")!, /Did you mean "list"\?$/);
  assert.match(chatActionBlocker("RE-NAME")!, /Did you mean "rename"\?$/);
  assert.match(chatActionBlocker("un_archive")!, /Did you mean "unarchive"\?$/);
  assert.match(chatActionBlocker("Organize")!, /Did you mean "organize"\?$/);
});

test("chat action gate: a non-string or empty value refuses naming the actions, no correction", () => {
  assert.match(chatActionBlocker(42)!, /^Unknown chat action "42"\. Actions:/);
  assert.doesNotMatch(chatActionBlocker(42)!, /Did you mean/);
  assert.match(chatActionBlocker("")!, /^Unknown chat action ""\. Actions:/);
  assert.doesNotMatch(chatActionBlocker("")!, /Did you mean/);
  assert.match(chatActionBlocker(undefined)!, /^Unknown chat action "undefined"\. Actions:/);
  assert.doesNotMatch(chatActionBlocker(undefined)!, /Did you mean/);
});

test("chat action gate: the sam_manage_chats dispatch refuses a folded action with the correction and touches no chat, and an exact action runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-action-gate-"));
  try {
    const folded = await executeOwnToolAsync(root, "sam", "sam_manage_chats", { action: "List" }) as { error?: string };
    assert.match(folded.error ?? "", /Did you mean "list"\?$/);
    const unknown = await executeOwnToolAsync(root, "sam", "sam_manage_chats", { action: "delete" }) as { error?: string };
    assert.equal(unknown.error, "Unknown chat action \"delete\". Actions: list, create, rename, pin, unpin, branch, archive, unarchive, organize, search");
    const store = new ChatStore(root);
    try { assert.equal(store.list({ includeArchived: true }).length, 0); } finally { store.close(); }
    const listed = await executeOwnToolAsync(root, "sam", "sam_manage_chats", { action: "list" }) as { chats?: unknown[] };
    assert.deepEqual(listed.chats, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
