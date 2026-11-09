import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBoxStores } from "./box-stores.js";

test("two SAM boxes keep missions, memory, chats and agent profiles separate across reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-box-stores-"));
  try {
    const a = openBoxStores(root, "owner-one", "website");
    const b = openBoxStores(root, "owner-one", "trading");
    const c = openBoxStores(root, "owner-two", "website");
    let websiteChatId = "";
    let tradingChatId = "";
    try {
      assert.notEqual(a.storage.database, b.storage.database);
      assert.notEqual(a.storage.database, c.storage.database);
      const mission = a.missions.create("Build a website");
      a.memory.add({ kind: "decision", content: "Use a test tenant", source: "owner-confirmed" });
      b.missions.create("Paper-trade only");
      b.memory.add({ kind: "observation", content: "Paper account", source: "test" });
      assert.equal(a.missions.list().length, 1);
      assert.equal(b.missions.list().length, 1);
      assert.equal(c.missions.list().length, 0);
      assert.equal(b.missions.get(mission.id), undefined);
      assert.equal(c.missions.get(mission.id), undefined);
      assert.equal(a.memory.list().length, 1);
      assert.equal(b.memory.list().length, 1);
      assert.equal(c.memory.list().length, 0);
      assert.equal(b.memory.search("tenant").length, 0);
      assert.equal(c.memory.search("tenant").length, 0);

      a.chats.createAgent("builder", "Build and test code.");
      const websiteChat = a.chats.create("Website work", "builder");
      websiteChatId = websiteChat.id;
      a.chats.add(websiteChat.id, "user", "Keep this project in its own box.");
      b.chats.createAgent("paper-trader", "Read-only paper research.");
      const tradingChat = b.chats.create("Paper research", "paper-trader");
      tradingChatId = tradingChat.id;
      b.chats.add(tradingChat.id, "user", "No signing or transfers.");
      assert.equal(a.chats.list().length, 1);
      assert.equal(b.chats.list().length, 1);
      assert.equal(c.chats.list().length, 0);
      assert.deepEqual(a.chats.agents().map(x => x.name), ["builder"]);
      assert.deepEqual(b.chats.agents().map(x => x.name), ["paper-trader"]);
      assert.throws(() => b.chats.messages(websiteChat.id), /Chat not found/);
      assert.throws(() => a.chats.messages(tradingChat.id), /Chat not found/);
    } finally {
      a.close(); b.close(); c.close();
    }

    const website = openBoxStores(root, "owner-one", "website");
    const trading = openBoxStores(root, "owner-one", "trading");
    try {
      assert.equal(website.missions.list()[0]?.objective, "Build a website");
      assert.equal(website.memory.list()[0]?.content, "Use a test tenant");
      assert.equal(trading.missions.list()[0]?.objective, "Paper-trade only");
      assert.equal(trading.memory.list()[0]?.content, "Paper account");
      assert.equal(trading.memory.search("tenant").length, 0);
      assert.equal(website.chats.messages(websiteChatId)[0]?.content, "Keep this project in its own box.");
      assert.equal(trading.chats.messages(tradingChatId)[0]?.content, "No signing or transfers.");
      assert.deepEqual(website.chats.agents().map(x => x.name), ["builder"]);
      assert.deepEqual(trading.chats.agents().map(x => x.name), ["paper-trader"]);
    } finally { website.close(); trading.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid box identifiers cannot open stores or fall back to legacy database", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-box-invalid-"));
  try {
    assert.throws(() => openBoxStores(root, "../owner", "website"), /Invalid owner ID/);
    assert.throws(() => openBoxStores(root, "owner", "../instance"), /Invalid instance ID/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
