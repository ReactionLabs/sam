import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChatTurn } from "./agent-turn.js";
import { ChatStore } from "./chats.js";
import { addressBookDir, contactOfferState, getContact } from "./contacts.js";

// The Address Book remove action (hourly run 2026-11-16 10:04):
// the chat tool could save/show/list/offer/decline but not remove,
// so an owner's in-chat "don't save him" could only flag an entry
// the CLI could have deleted. These tests pin the chat surface:
// a remove in a fresh chat deletes the entry, prunes the people
// page, drops the index line, and records the decline (the remove
// IS the owner's no, so the person is never offered again) - while
// an explicit later save still works, and removing a name with no
// entry records nothing at all.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-address-book-remove-"));
}

function installEnv(): () => void {
  const saved = { ...process.env };
  process.env.SAM_MODEL_PROVIDER = "minimax";
  process.env.SAM_MODEL = "MiniMax-M2.5";
  process.env.MINIMAX_API_KEY = "sk-test-not-a-real-key";
  return () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  };
}

function jsonResponse(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", ...message } }] }), {
    headers: { "Content-Type": "application/json" },
  });
}

function toolCall(id: string, name: string, args: Record<string, unknown>): Response {
  return jsonResponse({
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  });
}

/** Script one chat turn: load the tool, call it once, then answer. */
function scriptedTurn(actionArgs: Record<string, unknown>, answer: string): () => Promise<Response> {
  let calls = 0;
  return async () => {
    calls++;
    if (calls === 1) return toolCall("t-0", "sam_load_tools", { names: ["sam_address_book"] });
    if (calls === 2) return toolCall("t-1", "sam_address_book", actionArgs);
    return jsonResponse({ content: answer });
  };
}

test("address book remove: an entry saved in one chat is removed in a fresh chat, and the no sticks", async () => {
  const root = scratch();
  const restoreEnv = installEnv();
  const oldFetch = globalThis.fetch;
  try {
    const store = new ChatStore(root);
    const chat1 = store.create("Saving Dave");
    const chat2 = store.create("Removing Dave");
    const chat3 = store.create("Saving Dave again on request");
    store.close();

    globalThis.fetch = scriptedTurn(
      { action: "save", name: "Dave Testcase", relationship: "neighbor", fact: "Lives two doors down" },
      "Saved Dave Testcase to your people file.",
    );
    await runChatTurn(root, chat1.id, "Dave Testcase is my neighbor, he lives two doors down. Save him.");
    assert.ok(getContact(root, "Dave Testcase"), "the entry exists after the save");
    assert.ok(existsSync(join(addressBookDir(root), "dave-testcase.md")), "the people page exists after the save");

    globalThis.fetch = scriptedTurn(
      { action: "remove", name: "Dave Testcase" },
      "Done - Dave Testcase is out of your people file.",
    );
    const reply = await runChatTurn(root, chat2.id, "Actually, don't save Dave Testcase. Take him out.");
    assert.match(reply, /out of your people file/);
    assert.equal(getContact(root, "Dave Testcase"), null, "the entry is gone after the remove");
    assert.ok(!existsSync(join(addressBookDir(root), "dave-testcase.md")), "the people page is pruned after the remove");
    const index = readFileSync(join(addressBookDir(root), "INDEX.md"), "utf8");
    assert.ok(!index.includes("Dave Testcase"), "the index no longer lists the removed person");
    assert.equal(contactOfferState(root, "Dave Testcase"), "declined", "the remove records the owner's no, so he is never offered again");

    // The decline law stops offers and unasked saves, never an
    // asked one: an explicit save after the remove works.
    globalThis.fetch = scriptedTurn(
      { action: "save", name: "Dave Testcase", relationship: "neighbor" },
      "Saved Dave Testcase to your people file.",
    );
    await runChatTurn(root, chat3.id, "On second thought, do save Dave Testcase, he is my neighbor.");
    assert.ok(getContact(root, "Dave Testcase"), "an explicit save after a remove lands");
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("address book remove: a name with no entry removes nothing and records nothing", async () => {
  const root = scratch();
  const restoreEnv = installEnv();
  const oldFetch = globalThis.fetch;
  try {
    const store = new ChatStore(root);
    const chat = store.create("Removing a stranger");
    store.close();

    globalThis.fetch = scriptedTurn(
      { action: "remove", name: "Nobody Testcase" },
      "There was no entry for Nobody Testcase, so nothing changed.",
    );
    await runChatTurn(root, chat.id, "Remove Nobody Testcase from my people file.");
    assert.equal(getContact(root, "Nobody Testcase"), null);
    assert.equal(contactOfferState(root, "Nobody Testcase"), null, "a remove that found nothing records no decline - the decline verb is the owner's no, this was only a miss");
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});
