import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { archiveManagedChat, branchManagedChat, createManagedChat, listManagedChats, pinManagedChat, renameManagedChat, searchManagedChats, unarchiveManagedChat } from "./chat-manage.js";
import { executeOwnTool } from "./own-tools.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-chatmgmt-"));
}

function seed(root: string) {
  const store = new ChatStore(root);
  try {
    const core = store.create("Core planning", null);
    store.add(core.id, "user", "the zebra deployment plan lives here");
    store.add(core.id, "assistant", "noted, zebra plan stored");
    const dip = store.create("Dip thread", "dip");
    store.add(dip.id, "user", "my cortado order and the harbor list");
    const visitor = store.create("Door visitor", "dip", { visitor: true });
    store.add(visitor.id, "user", "visitor words about zebras");
    return { core, dip, visitor };
  } finally { store.close(); }
}

test("chat management: each profile sees and manages only its own chats", () => {
  const root = scratch();
  try {
    const { core, dip } = seed(root);
    assert.deepEqual(listManagedChats(root, "sam").map(c => c.id), [core.id]);
    assert.deepEqual(listManagedChats(root, "dip").map(c => c.id), [dip.id]);
    assert.throws(() => renameManagedChat(root, "dip", core.id, "Hijacked"), /belongs to profile/);
    assert.throws(() => renameManagedChat(root, "sam", dip.id, "Hijacked"), /belongs to profile/);
    const renamed = renameManagedChat(root, "sam", core.id, "Core planning v2");
    assert.equal(renamed.title, "Core planning v2");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat management: visitor chats are refused for every actor", () => {
  const root = scratch();
  try {
    const { visitor } = seed(root);
    assert.throws(() => renameManagedChat(root, "dip", visitor.id, "Nope"), /Visitor chats/);
    assert.throws(() => archiveManagedChat(root, "sam", visitor.id), /Visitor chats/);
    assert.equal(listManagedChats(root, "dip").some(c => c.id === visitor.id), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat management: create, pin, branch, archive, search stay inside the fence", () => {
  const root = scratch();
  try {
    const { core, dip } = seed(root);
    const made = createManagedChat(root, "dip", "Dip new thread");
    assert.equal(made.agent_name, "dip");
    assert.equal(listManagedChats(root, "sam").some(c => c.id === made.id), false);
    assert.equal(pinManagedChat(root, "sam", core.id, true).pinned, 1);
    const branch = branchManagedChat(root, "sam", core.id, "Zebra branch");
    const store = new ChatStore(root);
    const history = store.messages(branch.id);
    store.close();
    assert.equal(history.length, 2);
    const hits = searchManagedChats(root, "sam", "zebra");
    assert.ok(hits.some(h => h.chatId === core.id));
    assert.equal(searchManagedChats(root, "dip", "zebra").length, 0);
    assert.ok(searchManagedChats(root, "dip", "cortado").some(h => h.chatId === dip.id));
    archiveManagedChat(root, "sam", core.id);
    assert.equal(listManagedChats(root, "sam").some(c => c.id === core.id), false);
    assert.equal(listManagedChats(root, "sam", { includeArchived: true }).some(c => c.id === core.id), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat management: last activity reports newest message and count; unarchive restores", () => {
  const root = scratch();
  try {
    const store = new ChatStore(root);
    const a = store.create("Busy");
    const b = store.create("Quiet");
    store.add(a.id, "user", "one");
    store.add(a.id, "assistant", "two");
    store.add(b.id, "user", "only");
    const act = new Map(store.lastActivity().map(x => [x.chat_id, x]));
    assert.equal(act.get(a.id)?.messages, 2);
    assert.equal(act.get(b.id)?.messages, 1);
    assert.ok((act.get(a.id)?.last_message_at ?? "") >= (act.get(b.id)?.last_message_at ?? ""));
    store.close();
    archiveManagedChat(root, "sam", a.id);
    assert.equal(listManagedChats(root, "sam").some(c => c.id === a.id), false);
    const back = unarchiveManagedChat(root, "sam", a.id);
    assert.ok(!back.archived);
    assert.equal(listManagedChats(root, "sam").some(c => c.id === a.id), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat management: the sam_manage_chats tool dispatches through the same fence", () => {
  const root = scratch();
  try {
    const { dip } = seed(root);
    const listed = executeOwnTool(root, "dip", "sam_manage_chats", { action: "list" }) as { chats: Array<{ id: string }> };
    assert.deepEqual(listed.chats.map(c => c.id), [dip.id]);
    const refused = executeOwnTool(root, "dip", "sam_manage_chats", { action: "rename", chatId: "missing", title: "x" }) as { error: string };
    assert.match(refused.error, /Chat not found/);
    const made = executeOwnTool(root, "dip", "sam_manage_chats", { action: "create", title: "From the tool" }) as { title: string };
    assert.equal(made.title, "From the tool");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
