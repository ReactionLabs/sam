import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChatTurn } from "./agent-turn.js";
import { ChatStore } from "./chats.js";
import { addressBookDir, getContact } from "./contacts.js";

// The Address Book across two chats (Dip's proof shape, 2026-11-16):
// chat 1 states facts about a person and SAM saves the entry as
// part of the turn; chat 2, a FRESH chat, asks who that person is
// and SAM reads the entry back - with its citation - without the
// owner re-explaining anything. The provider is scripted; the
// machinery (tool dispatch, the store, the people files, the
// citation pass) is the real one.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-address-book-chats-"));
}

function installEnv(): () => void {
  const saved = { ...process.env };
  process.env.SAM_MODEL_PROVIDER = "minimax";
  process.env.SAM_MODEL = "MiniMax-M2.5";
  process.env.MINIMAX_API_KEY = "test";
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

/** The source number the run's tool result actually carried, read
 *  off the request the way the model would see it. */
function citedNumber(init: unknown): string | null {
  try {
    const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as { messages?: Array<{ role?: string; content?: unknown }> };
    for (const message of body.messages ?? []) {
      if (message.role !== "tool" || typeof message.content !== "string") continue;
      const match = message.content.match(/\[Source (\d+): Address Book entry: Maria Testcase/);
      if (match) return match[1];
    }
  } catch { /* fall through */ }
  return null;
}

test("address book: a fact saved in one chat is recalled, cited, in a fresh chat", async () => {
  const root = scratch();
  const restoreEnv = installEnv();
  const oldFetch = globalThis.fetch;
  try {
    const store = new ChatStore(root);
    const chat1 = store.create("Saving Maria");
    const chat2 = store.create("Asking about Maria");
    store.close();

    // Chat 1: the owner states the facts and asks for the save.
    let calls1 = 0;
    globalThis.fetch = async () => {
      calls1++;
      if (calls1 === 1) return toolCall("c1-0", "sam_load_tools", { names: ["sam_address_book"] });
      if (calls1 === 2) return toolCall("c1-1", "sam_address_book", {
        action: "save", name: "Maria Testcase", relationship: "cousin",
        email: "maria@example.test", special: true, fact: "Lives in Tampa",
      });
      return jsonResponse({ content: "Done. Saved Maria Testcase to your people file." });
    };
    const reply1 = await runChatTurn(root, chat1.id,
      "This is my cousin Maria Testcase, her email is maria@example.test and she lives in Tampa. Save her as a contact and mark her special.");
    assert.match(reply1, /Saved Maria Testcase/);
    const saved = getContact(root, "Maria Testcase");
    assert.ok(saved, "the entry exists after chat 1");
    assert.equal(saved!.relationship, "cousin");
    assert.equal(saved!.email, "maria@example.test");
    assert.equal(saved!.special, true);
    assert.deepEqual(saved!.sourceChats, [chat1.id], "the save is stamped with the chat it came from");
    const page = readFileSync(join(addressBookDir(root), "maria-testcase.md"), "utf8");
    assert.match(page, /Relationship: cousin/);
    assert.match(page, /Lives in Tampa/);

    // Chat 2: a fresh chat, no re-explaining. The scripted model
    // answers from whatever the show result actually carried.
    let calls2 = 0;
    globalThis.fetch = async (_url: unknown, init?: unknown) => {
      calls2++;
      if (calls2 === 1) return toolCall("c2-0", "sam_load_tools", { names: ["sam_address_book"] });
      if (calls2 === 2) return toolCall("c2-1", "sam_address_book", { action: "show", name: "Maria Testcase" });
      const n = citedNumber(init);
      assert.ok(n, "the show result carried a citable source number");
      return jsonResponse({ content: "Maria Testcase is your cousin, and she lives in Tampa [" + n + "]." });
    };
    const reply2 = await runChatTurn(root, chat2.id, "Who is Maria Testcase?");
    assert.match(reply2, /your cousin/, "the fact came back without the owner repeating it");
    assert.match(reply2, /Sources:/, "the recall closes with its source list");
    assert.match(reply2, /Address Book entry: Maria Testcase/, "and the source named is the Address Book entry");
    assert.ok(existsSync(join(root, ".sam", "source-citations.db")), "the citation is on the audit record");
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});
