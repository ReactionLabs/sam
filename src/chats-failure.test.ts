import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import { ChatStore, chatStoreFailureSummary, isChatStoreLedgered } from "./chats.js";
import { classifyDefect } from "./self-work.js";

// Chat store failure visibility (gap found 2026-11-15,
// hourly run 01:04): chats.db holds every conversation
// (chats, messages, team events, agent profiles,
// compactions) behind the one ChatStore class, and every
// touch opened it raw - the constructor's open plus every
// method threw into whichever catch wrapped the call with
// the seam unnamed. Each touch now ledgers ONE
// chat-store-failed line (constructor open at phase write,
// reads at phase read, mutations at phase write) and
// rethrows exactly, tagged; every caller's handling is
// unchanged and reads still fail closed (never folded as
// no chats, which would silently empty every conversation
// dressed as a fresh install).
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-chats-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "chat-store-failed" });
}

test("chat-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(chatStoreFailureSummary("read", "unable to open\n  database   file"), "Chat store read failed: unable to open database file");
  assert.equal(chatStoreFailureSummary("write", "disk gone"), "Chat store write failed: disk gone");
  assert.equal(chatStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "chat-store-failed", summary: chatStoreFailureSummary(phase, "boom") }),
      { key: "chat-store-failed:" + phase, label: "chat store failures (" + phase + " step)" },
    );
  }
});

test("chat-store-failed: a dead store at open ledgers exactly one write line, tagged, and rethrows", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, ".sam", "chats.db"), { recursive: true });
    assert.throws(() => new ChatStore(root), (e: unknown) => isChatStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Chat store write failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "chat-store-failed:write", label: "chat store failures (write step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat-store-failed: a dead read on a live handle ledgers one read line per touch, never two for one error", () => {
  const root = scratch();
  try {
    const store = new ChatStore(root);
    const chat = store.create("A Title That Must Not Leak");
    store.add(chat.id, "user", "a body that must not leak");
    const raw = openDatabase(join(root, ".sam", "chats.db"));
    try { raw.exec("ALTER TABLE chat_messages RENAME TO chat_messages_gone"); } finally { raw.close(); }

    assert.throws(() => store.messages(chat.id), (e: unknown) => isChatStoreLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Chat store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "chat-store-failed:read", label: "chat store failures (read step)" });

    // openPartial rides messages internally: its inner touch
    // ledgers its one line, and openPartial's own guard adds
    // no second line for the same tagged error.
    assert.throws(() => store.openPartial(chat.id), (e: unknown) => isChatStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "one line for the inner messages touch, none added by the outer guard");
    assert.ok(lines[1].summary.startsWith("Chat store read failed: "), lines[1].summary);

    store.close();
    assert.ok(!JSON.stringify(lines).includes("A Title That Must Not Leak"), "no chat title ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("a body that must not leak"), "no message content ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat-store-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const root = scratch();
  try {
    const store = new ChatStore(root);
    const chat = store.create("Insert Plant");
    const raw = openDatabase(join(root, ".sam", "chats.db"));
    try { raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON chat_messages BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;"); } finally { raw.close(); }
    assert.throws(() => store.add(chat.id, "user", "content that must not leak"), (e: unknown) => isChatStoreLedgered(e));
    store.close();
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Chat store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
    assert.ok(!JSON.stringify(lines).includes("content that must not leak"), "no message content ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat-store-failed: validation and data errors are not store failures and ledger nothing", () => {
  const root = scratch();
  try {
    const store = new ChatStore(root);
    const plain = (re: RegExp) => (e: unknown) => re.test((e as Error).message) && !isChatStoreLedgered(e);
    assert.throws(() => store.create(""), plain(/^Chat title must be/));
    assert.throws(() => store.create("Ok title", "Bad Name"), plain(/^Invalid agent profile$/));
    assert.throws(() => store.createAgent("Bad Name", "instructions"), plain(/^Invalid agent profile$/));
    assert.throws(() => store.setAgentModel("whoever", "bad model!"), plain(/^Invalid agent profile$/));
    assert.throws(() => store.messages("missing-chat"), plain(/^Chat not found$/));
    assert.throws(() => store.add("missing-chat", "user", "hello"), plain(/^Chat not found$/));
    assert.throws(() => store.branch("missing-chat", "Branch title"), plain(/^Parent chat not found$/));
    assert.throws(() => store.add(store.create("Real chat").id, "user", ""), plain(/^Invalid chat message$/));
    const chat = store.create("Reaction chat");
    const msg = store.add(chat.id, "assistant", "a reply");
    assert.throws(() => store.setReaction(chat.id, msg.id, "not an emoji"), plain(/^Invalid reaction:/));
    assert.throws(() => store.setCompaction(chat.id, -1, "summary"), plain(/^Invalid compaction$/));
    assert.throws(() => store.addEvent(chat.id, "Bad Agent", "message", "hi"), plain(/^Invalid team event$/));
    store.close();
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat-store-failed: a healthy store exercises every surface with zero failure lines", () => {
  const root = scratch();
  try {
    const store = new ChatStore(root);
    assert.deepEqual(store.list(), [], "a fresh store reads as no chats");
    const agent = store.createAgent("helper", "Help with things.", { model: "Model-One" });
    assert.equal(agent.name, "helper");
    assert.equal(store.setAgentModel("helper", "Model-Two")?.model, "Model-Two");
    assert.equal(store.setAgentModel("ghost", "Model-Two"), null);
    const chat = store.create("Healthy chat", "helper");
    const user = store.add(chat.id, "user", "hello there");
    store.add(chat.id, "assistant", "general kenobi");
    assert.equal(store.messages(chat.id).length, 2);
    assert.equal(store.isVisitor(chat.id), false);
    assert.equal(store.get(chat.id)?.title, "Healthy chat");
    assert.equal(store.searchMessages("kenobi", [chat.id]).length, 1);
    assert.equal(store.searchMessagesFts("kenobi", [chat.id]).length, 1);
    assert.equal(store.setReaction(chat.id, user.id, "👀"), true);
    const partialId = store.savePartial(chat.id, null, "draft in progress");
    assert.equal(store.openPartial(chat.id)?.id, partialId);
    assert.equal(store.finishPartial(chat.id, partialId, "final answer"), true);
    const branch = store.branch(chat.id, "Healthy branch");
    assert.equal(store.messages(branch.id).length, 3);
    store.setCompaction(chat.id, 2, "summary of the first two");
    assert.equal(store.getCompaction(chat.id)?.covered, 2);
    assert.equal(store.listCompactions().length, 1);
    store.addEvent(chat.id, "helper", "message", "noted");
    assert.equal(store.events(chat.id).length, 1);
    assert.equal(store.pin(chat.id, true), true);
    assert.equal(store.archive(chat.id, true), true);
    assert.equal(store.list().length, 1, "the archived chat is hidden, the branch is not");
    assert.equal(store.lastActivity().length, 2);
    store.close();
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
