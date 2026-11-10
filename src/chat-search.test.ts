import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ChatStore, ftsChatMatch } from "./chats.js";
import { searchManagedChats } from "./chat-manage.js";
import { executeOwnTool, OWN_TOOLS } from "./own-tools.js";
import { CORE_OWN_TOOLS } from "./tool-tiers.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-chatsearch-"));
}

test("chat search: the match builder keeps only plain prefix terms", () => {
  assert.equal(ftsChatMatch("zebra deployment"), "zebra* AND deployment*");
  // FTS operators, quotes, and punctuation in a natural question vanish
  // instead of throwing or steering the query.
  // (The trailing OR would be the ninth term; the 8-term cap drops it.)
  assert.equal(ftsChatMatch('what about "don\'t call it a mini" OR *'), "what* AND about* AND don* AND t* AND call* AND it* AND a* AND mini*");
  assert.equal(ftsChatMatch("zebra zebra"), "zebra*");
  assert.equal(ftsChatMatch("?!..."), null);
  assert.equal(ftsChatMatch(""), null);
});

test("chat search: FTS is multi-term, prefix-aware, and relevance-ranked", () => {
  const root = scratch();
  try {
    const store = new ChatStore(root);
    const both = store.create("Both terms");
    store.add(both.id, "user", "the deployment plan for zebras ships friday");
    const oneOnly = store.create("One term");
    store.add(oneOnly.id, "user", "deployment notes without the animal");
    const dense = store.create("Dense");
    store.add(dense.id, "user", "zebra zebra zebra");
    const sparse = store.create("Sparse");
    store.add(sparse.id, "user", "zebra " + "filler words about unrelated daily operations and routine scheduling notes ".repeat(6));
    store.close();
    // AND across terms, with prefixes: deploy~deployment, zebra~zebras.
    const andHits = searchManagedChats(root, "sam", "deploy zebra");
    assert.deepEqual(andHits.map(h => h.chatId), [both.id]);
    // bm25 ranks the dense short hit above the sparse long one, even
    // though the sparse chat is newer in store order terms.
    const ranked = searchManagedChats(root, "sam", "zebra");
    assert.ok(ranked.length >= 2);
    assert.equal(ranked[0].chatId, dense.id);
    assert.ok(ranked.findIndex(h => h.chatId === sparse.id) > 0);
    // The snippet is cut around the match, not the head of the message.
    const tail = searchManagedChats(root, "sam", "animal");
    assert.equal(tail.length, 1);
    assert.match(tail[0].snippet, /animal/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat search: a database that predates the index is rebuilt searchable", () => {
  const root = scratch();
  try {
    const store = new ChatStore(root);
    const chat = store.create("Legacy");
    store.add(chat.id, "user", "an old quokka conversation from before the index");
    store.close();
    // Simulate the pre-FTS store: drop the index and its triggers.
    const raw = new Database(join(root, ".sam", "chats.db"));
    raw.exec("DROP TABLE chat_messages_fts; DROP TRIGGER chat_messages_fts_insert; DROP TRIGGER chat_messages_fts_delete; DROP TRIGGER chat_messages_fts_update;");
    raw.close();
    const hits = searchManagedChats(root, "sam", "quokka");
    assert.deepEqual(hits.map(h => h.chatId), [chat.id]);
    // And new writes after the rebuild are indexed by the triggers.
    const store2 = new ChatStore(root);
    store2.add(chat.id, "assistant", "a fresh wombat note");
    store2.close();
    assert.equal(searchManagedChats(root, "sam", "wombat").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat search: the fence holds - other profiles, visitors, archived stay out", () => {
  const root = scratch();
  try {
    const store = new ChatStore(root);
    const dip = store.create("Dip thread", "dip");
    store.add(dip.id, "user", "dip only quokka talk");
    const visitor = store.create("Door visitor", "dip", { visitor: true });
    store.add(visitor.id, "user", "visitor quokka words");
    const old = store.create("Old core");
    store.add(old.id, "user", "archived quokka talk");
    store.archive(old.id, true);
    store.close();
    assert.equal(searchManagedChats(root, "sam", "quokka").length, 0);
    assert.deepEqual(searchManagedChats(root, "dip", "quokka").map(h => h.chatId), [dip.id]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chat search: sam_search_chats is a core own tool and refuses visitors", () => {
  assert.ok(OWN_TOOLS.some(t => (t as { function?: { name?: string } }).function?.name === "sam_search_chats"));
  assert.ok(CORE_OWN_TOOLS.includes("sam_search_chats"));
  const root = scratch();
  try {
    const store = new ChatStore(root);
    const dip = store.create("Dip thread", "dip");
    store.add(dip.id, "user", "the cortado stand decision from last week");
    const visitor = store.create("Door visitor", "dip", { visitor: true });
    store.add(visitor.id, "user", "hello");
    store.close();
    const found = executeOwnTool(root, "dip", "sam_search_chats", { query: "cortado decision" }, dip.id) as { untrusted: boolean; hits: Array<{ chatId: string }> };
    assert.equal(found.untrusted, true);
    assert.deepEqual(found.hits.map(h => h.chatId), [dip.id]);
    const refused = executeOwnTool(root, "dip", "sam_search_chats", { query: "cortado" }, visitor.id) as { error: string };
    assert.match(refused.error, /Visitors cannot search chats/);
    // A malformed, operator-laden query is a clean empty result, not a throw.
    const weird = executeOwnTool(root, "dip", "sam_search_chats", { query: '"unclosed OR *' }, dip.id) as { hits: Array<unknown> };
    assert.deepEqual(weird.hits, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
