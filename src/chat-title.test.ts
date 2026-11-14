import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { autotitleChat, sanitizeChatTitle } from "./chat-title.js";

test("sanitizeChatTitle strips quotes, markdown, and trailing punctuation", () => {
  assert.equal(sanitizeChatTitle('"Venue deposit call"'), "Venue deposit call");
  assert.equal(sanitizeChatTitle("**Banner proof for Allen**\nignored second line"), "Banner proof for Allen");
  assert.equal(sanitizeChatTitle("Morning priorities."), "Morning priorities");
  assert.equal(sanitizeChatTitle("New conversation"), null);
  assert.equal(sanitizeChatTitle("hi"), null);
  assert.equal(sanitizeChatTitle(""), null);
});

function seededChat(root: string, title: string): string {
  const db = new ChatStore(root);
  try {
    const chat = db.create(title, null);
    db.add(chat.id, "user", "What needs my attention this morning?", "dashboard");
    db.add(chat.id, "assistant", "Two things: the venue deposit due Friday, and the banner proof Allen is waiting on.", "unknown");
    return chat.id;
  } finally {
    db.close();
  }
}

test("autotitleChat renames a provisional chat from the exchange", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-title-"));
  try {
    const id = seededChat(root, "Needs my attention this morning");
    const title = await autotitleChat(root, id, "Needs my attention this morning", {}, async () => '"Venue deposit and banner proof"');
    assert.equal(title, "Venue deposit and banner proof");
    const db = new ChatStore(root);
    try {
      assert.equal(db.get(id)?.title, "Venue deposit and banner proof");
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("autotitleChat never clobbers an owner rename and stays silent without a model", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-title-"));
  try {
    const id = seededChat(root, "Needs my attention this morning");
    // Placeholder mismatch (the owner renamed first): no rename, no callout.
    const skipped = await autotitleChat(root, id, "Some other placeholder", {}, async () => "Model Title Here");
    assert.equal(skipped, null);
    // No completer and no model env: provisional title stays.
    const noModel = await autotitleChat(root, id, "Needs my attention this morning", {});
    assert.equal(noModel, null);
    const db = new ChatStore(root);
    try {
      assert.equal(db.get(id)?.title, "Needs my attention this morning");
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
