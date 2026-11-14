import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { searchManagedChats, type ChatSearchHit } from "./chat-manage.js";
import { executeOwnTool } from "./own-tools.js";
import { readActivity } from "./activity.js";
import {
  attachCitation, citationForMessage, citationViewsForChat, consumeSearchHits,
  extractCitationMarkers, processReplyCitations, recordSearchHits, resolveCitation,
} from "./chat-citations.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-citations-"));
}

const FAKE_ID = "12345678-1234-4234-9234-1234567890ab";

// Seed: chat A holds the synthetic phrase, chat B is where the owner
// asks. Returns the phrase message's id in chat A.
function seed(root: string): { a: string; b: string; phraseMessageId: string } {
  const store = new ChatStore(root);
  const a = store.create("Field notes");
  const msg = store.add(a.id, "user", "the vault combination phrase is zorblax quindle forty seven");
  const b = store.create("Asking");
  store.close();
  return { a: a.id, b: b.id, phraseMessageId: msg.id };
}

test("citations: search hits carry the exact message id of the match", () => {
  const root = scratch();
  try {
    const { a, phraseMessageId } = seed(root);
    const hits = searchManagedChats(root, "sam", "zorblax quindle");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].chatId, a);
    assert.equal(hits[0].messageId, phraseMessageId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("citations: marker extraction strips markers and reports every id named", () => {
  const hit = extractCitationMarkers("The phrase is zorblax quindle forty seven.\n[[cite:" + FAKE_ID + "]]");
  assert.deepEqual(hit.messageIds, [FAKE_ID]);
  assert.equal(hit.text, "The phrase is zorblax quindle forty seven.");
  const plain = extractCitationMarkers("no marker here");
  assert.deepEqual(plain.messageIds, []);
  assert.equal(plain.text, "no marker here");
});

test("citations: a reply citing a verified hit from its own run attaches and resolves", () => {
  const root = scratch();
  try {
    const { a, b, phraseMessageId } = seed(root);
    const store = new ChatStore(root);
    const ask = store.add(b, "user", "what was the vault combination phrase?");
    store.close();
    // The tool dispatch records this run's hits, like a live turn.
    const result = executeOwnTool(root, "sam", "sam_search_chats", { query: "zorblax quindle" }, b, ask.id) as { hits: ChatSearchHit[] };
    assert.equal(result.hits[0].messageId, phraseMessageId);
    const processed = processReplyCitations(root, {
      chatId: b, userMessageId: ask.id, actor: "sam",
      text: "The phrase is zorblax quindle forty seven.\n[[cite:" + phraseMessageId + "]]",
    });
    assert.equal(processed.rejected, false);
    assert.equal(processed.hit?.chatId, a);
    assert.equal(processed.hit?.messageId, phraseMessageId);
    assert.ok(!processed.text.includes("[[cite:"));
    // Attach under the reply's own message id and resolve it.
    const store2 = new ChatStore(root);
    const replyRow = store2.add(b, "assistant", processed.text);
    store2.close();
    assert.equal(attachCitation(root, { messageId: replyRow.id, chatId: b, actor: "sam", hit: processed.hit as ChatSearchHit }), true);
    const stored = citationForMessage(root, replyRow.id);
    assert.equal(stored?.sourceChatId, a);
    assert.equal(stored?.sourceMessageId, phraseMessageId);
    const resolved = resolveCitation(root, stored as NonNullable<typeof stored>);
    assert.equal(resolved.available, true);
    assert.equal(resolved.sourceTitle, "Field notes");
    const views = citationViewsForChat(root, b);
    assert.equal(views[replyRow.id]?.available, true);
    // The registry is consumed: the same marker in a later pass
    // over the same turn is no longer backed by any recorded hit.
    const again = processReplyCitations(root, { chatId: b, userMessageId: ask.id, actor: "sam", text: "again [[cite:" + phraseMessageId + "]]" });
    assert.equal(again.hit, null);
    assert.equal(again.rejected, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("citations: a fabricated source is rejected, stripped, and ledgered - never attached", () => {
  const root = scratch();
  try {
    const { b } = seed(root);
    const store = new ChatStore(root);
    const ask = store.add(b, "user", "what was the phrase?");
    store.close();
    // A real search ran this run (hits exist), but the model names
    // a message that was never among them.
    executeOwnTool(root, "sam", "sam_search_chats", { query: "zorblax quindle" }, b, ask.id);
    const processed = processReplyCitations(root, {
      chatId: b, userMessageId: ask.id, actor: "sam",
      text: "The phrase is zorblax quindle forty seven.\n[[cite:" + FAKE_ID + "]]",
    });
    assert.equal(processed.hit, null);
    assert.equal(processed.rejected, true);
    assert.ok(!processed.text.includes("[[cite:"));
    const lines = readActivity(root, 50).filter(l => l.kind === "citation-rejected");
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].summary.includes("zorblax"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("citations: a search that ran without a marker attaches nothing", () => {
  const root = scratch();
  try {
    const { b } = seed(root);
    const store = new ChatStore(root);
    const ask = store.add(b, "user", "what was the phrase?");
    store.close();
    executeOwnTool(root, "sam", "sam_search_chats", { query: "zorblax quindle" }, b, ask.id);
    const processed = processReplyCitations(root, {
      chatId: b, userMessageId: ask.id, actor: "sam",
      text: "The phrase is zorblax quindle forty seven.",
    });
    assert.equal(processed.hit, null);
    assert.equal(processed.rejected, false);
    assert.equal(processed.text, "The phrase is zorblax quindle forty seven.");
    assert.deepEqual(consumeSearchHits(b, ask.id), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("citations: an archived or message-missing source resolves unavailable", () => {
  const root = scratch();
  try {
    const { a, b, phraseMessageId } = seed(root);
    const hits = searchManagedChats(root, "sam", "zorblax quindle");
    const store = new ChatStore(root);
    const replyRow = store.add(b, "assistant", "answer");
    store.close();
    assert.equal(attachCitation(root, { messageId: replyRow.id, chatId: b, actor: "sam", hit: hits[0] }), true);
    const stored = citationForMessage(root, replyRow.id) as NonNullable<ReturnType<typeof citationForMessage>>;
    assert.equal(resolveCitation(root, stored).available, true);
    // Retire the source chat: the citation stops resolving and the
    // unavailable view exposes no content, only the stored ids.
    const store2 = new ChatStore(root);
    store2.archive(a, true);
    store2.close();
    const afterArchive = resolveCitation(root, stored);
    assert.equal(afterArchive.available, false);
    // A citation naming a message the chat no longer holds (or
    // never held) is likewise unavailable.
    const ghost: ChatSearchHit = { ...hits[0], messageId: FAKE_ID };
    const reply2 = (() => { const s = new ChatStore(root); const r = s.add(b, "assistant", "answer two"); s.close(); return r; })();
    assert.equal(attachCitation(root, { messageId: reply2.id, chatId: b, actor: "sam", hit: ghost }), true);
    const ghostStored = citationForMessage(root, reply2.id) as NonNullable<ReturnType<typeof citationForMessage>>;
    assert.equal(resolveCitation(root, ghostStored).available, false);
    assert.equal(phraseMessageId.length, 36);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("citations: another profile's chat is not resolvable through a citation (access rules)", () => {
  const root = scratch();
  try {
    const store = new ChatStore(root);
    const dipChat = store.create("Dip private", "dip");
    const secret = store.add(dipChat.id, "user", "the launch code is hummingbird seven");
    const b = store.create("Asking");
    const replyRow = store.add(b.id, "assistant", "answer");
    store.close();
    // Even a perfectly formed citation row naming dip's chat,
    // attached under sam's actor, must not resolve: sam does not
    // manage dip's chats, so the source stays unavailable and its
    // contents are never exposed through the citation surface.
    const foreignHit: ChatSearchHit = { chatId: dipChat.id, messageId: secret.id, title: "Dip private", role: "user", snippet: "hummingbird", created_at: secret.created_at, rank: 0 };
    assert.equal(attachCitation(root, { messageId: replyRow.id, chatId: b.id, actor: "sam", hit: foreignHit }), true);
    const stored = citationForMessage(root, replyRow.id) as NonNullable<ReturnType<typeof citationForMessage>>;
    const resolved = resolveCitation(root, stored);
    assert.equal(resolved.available, false);
    // The same row under the owning profile resolves fine, proving
    // the gate is the access rule, not the data.
    assert.equal(resolveCitation(root, { ...stored, actor: "dip" }).available, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("citations: hits recorded for one turn never leak into another turn's reply", () => {
  const root = scratch();
  try {
    const { b, phraseMessageId } = seed(root);
    recordSearchHits(b, "turn-one", searchManagedChats(root, "sam", "zorblax quindle"));
    const other = processReplyCitations(root, {
      chatId: b, userMessageId: "turn-two", actor: "sam",
      text: "borrowed [[cite:" + phraseMessageId + "]]",
    });
    assert.equal(other.hit, null);
    assert.equal(other.rejected, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
