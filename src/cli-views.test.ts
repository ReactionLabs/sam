import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { proposeAction } from "./actions.js";
import { recordActivity } from "./activity.js";
import { activityView, actionsView, chatView, statusSnapshot } from "./cli-views.js";

test("cli views: activity filters, chat view carries its cards, status shows the pending queue", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-cli-"));
  try {
    const db = new ChatStore(root);
    let chatId = "";
    try { chatId = db.create("Terminal chat", null).id; db.add(chatId, "user", "hello"); } finally { db.close(); }
    const mine = proposeAction(root, { actor: "sam", kind: "note", title: "From this chat", detail: "d", chatId });
    proposeAction(root, { actor: "sam", kind: "note", title: "From elsewhere", detail: "d" });
    recordActivity(root, "sam", "turn", "Answered");
    recordActivity(root, "owner", "approved", "note: x");
    assert.equal(actionsView(root, { pending: true }).length, 2);
    assert.equal(actionsView(root, { chat: chatId }).length, 1);
    assert.equal(actionsView(root, { chat: chatId })[0].id, mine.id);
    const view = chatView(root, chatId);
    assert.equal(view.actions.length, 1);
    assert.equal((view.messages as unknown[]).length, 1);
    assert.equal(activityView(root, { actor: "owner" }).length, 1);
    assert.equal(activityView(root, { kind: "turn" }).length, 1);
    const snap = statusSnapshot(root);
    assert.equal(snap.pendingActions.length, 2);
    assert.equal(snap.activity.length, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
