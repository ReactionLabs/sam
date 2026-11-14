import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { listManagedChats } from "./chat-manage.js";
import { isPlaceholderTitle, organizeChats, ORGANIZE_STALE_DAYS } from "./chat-organize.js";
import { provisionalTitle } from "./chat-title.js";
import { readActivity } from "./activity.js";
import { executeOwnToolAsync } from "./own-tools.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-organize-"));
}

const completer = async (userText: string) =>
  userText.includes("attention") ? "Venue Deposit and Banner Proof" : "Pricing Review Plan";

interface Messy {
  untitledReal: string; genericReal: string; ownerNamed: string; longReal: string;
  staleSmoke: string; oneMessage: string; emptyStale: string; pinnedSmoke: string;
  otherProfile: string; visitor: string;
}

function seedMessy(root: string): Messy {
  const store = new ChatStore(root);
  try {
    const first = "What needs my attention this morning?";
    const untitledReal = store.create(provisionalTitle(first), null);
    store.add(untitledReal.id, "user", first);
    store.add(untitledReal.id, "assistant", "Two things: the venue deposit due Friday, and the banner proof Allen is waiting on.");
    const genericReal = store.create("New conversation", null);
    store.add(genericReal.id, "user", "Help me plan the Q1 pricing review for the pool route");
    store.add(genericReal.id, "assistant", "Here is a plan for the pricing review.");
    const ownerNamed = store.create("My Harbor List", null);
    store.add(ownerNamed.id, "user", "keep this list exactly as named");
    store.add(ownerNamed.id, "assistant", "kept");
    const longReal = store.create("Harbor planning thread", null);
    for (let i = 0; i < 6; i++) store.add(longReal.id, i % 2 ? "assistant" : "user", "Harbor planning exchange " + (i + 1) + " with real substance.");
    const staleSmoke = store.create("Smoke proof chat 12", null);
    store.add(staleSmoke.id, "user", "smoke run");
    store.add(staleSmoke.id, "assistant", "smoke ok");
    const oneMessage = store.create("Quick check", null);
    store.add(oneMessage.id, "user", "ping");
    const emptyStale = store.create("Empty shell", null);
    const pinnedSmoke = store.create("Smoke pinned keep", null);
    store.add(pinnedSmoke.id, "user", "pinned smoke");
    store.pin(pinnedSmoke.id, true);
    const otherProfile = store.create("Smoke dip chat", "dip");
    store.add(otherProfile.id, "user", "dip smoke");
    const visitor = store.create("Web chat", "dip", { visitor: true });
    store.add(visitor.id, "user", "visitor smoke words");
    return {
      untitledReal: untitledReal.id, genericReal: genericReal.id, ownerNamed: ownerNamed.id,
      longReal: longReal.id, staleSmoke: staleSmoke.id, oneMessage: oneMessage.id,
      emptyStale: emptyStale.id, pinnedSmoke: pinnedSmoke.id, otherProfile: otherProfile.id, visitor: visitor.id,
    };
  } finally { store.close(); }
}

function titles(root: string): Map<string, { title: string; archived?: number }> {
  const store = new ChatStore(root);
  try {
    return new Map(store.list({ includeArchived: true }).map(c => [c.id, { title: c.title, archived: c.archived }]));
  } finally { store.close(); }
}

test("organize: placeholder detection follows the shipped title machinery", () => {
  const base = { id: "x", created_at: "", updated_at: "" };
  assert.equal(isPlaceholderTitle({ ...base, title: "New conversation" }, "anything"), true);
  assert.equal(isPlaceholderTitle({ ...base, title: provisionalTitle("What needs my attention this morning?") }, "What needs my attention this morning?"), true);
  assert.equal(isPlaceholderTitle({ ...base, title: "My Harbor List" }, "What needs my attention this morning?"), false);
  assert.equal(isPlaceholderTitle({ ...base, title: "Venue Deposit and Banner Proof" }, "What needs my attention this morning?"), false);
});

test("organize: one pass renames placeholders, archives stale scratch, spares the real and the pinned", async () => {
  const root = scratch();
  try {
    const ids = seedMessy(root);
    const later = new Date(Date.now() + (ORGANIZE_STALE_DAYS + 3) * 86_400_000);
    const result = await organizeChats(root, "sam", { now: later, complete: completer });
    assert.equal(result.scanned, 8);
    assert.deepEqual(result.renamed.map(r => r.chatId).sort(), [ids.genericReal, ids.untitledReal].sort());
    assert.deepEqual(result.archived.map(a => a.chatId).sort(), [ids.emptyStale, ids.oneMessage, ids.staleSmoke].sort());
    const after = titles(root);
    assert.equal(after.get(ids.untitledReal)?.title, "Venue Deposit and Banner Proof");
    assert.equal(after.get(ids.genericReal)?.title, "Pricing Review Plan");
    assert.equal(after.get(ids.ownerNamed)?.title, "My Harbor List");
    assert.equal(after.get(ids.longReal)?.title, "Harbor planning thread");
    assert.ok(!after.get(ids.longReal)?.archived, "a long real conversation is never archived for age alone");
    assert.ok(after.get(ids.staleSmoke)?.archived);
    assert.ok(after.get(ids.oneMessage)?.archived);
    assert.ok(after.get(ids.emptyStale)?.archived);
    assert.ok(!after.get(ids.pinnedSmoke)?.archived, "pinned chats are never archived");
    assert.ok(!after.get(ids.otherProfile)?.archived, "another profile's chats are outside the pass");
    assert.ok(!after.get(ids.visitor)?.archived, "visitor chats are outside the pass");
    // The summary names everything it did, and the activity ledger
    // carries exactly ONE chat-organize record for the run.
    assert.match(result.summary, /renamed 2, archived 3/);
    assert.match(result.summary, /"Needs my attention this morning" -> "Venue Deposit and Banner Proof"/);
    assert.match(result.summary, /Archived: "Smoke proof chat 12"/);
    assert.match(result.summary, /Nothing was deleted/);
    const lines = readActivity(root, 50).filter(l => l.kind === "chat-organize");
    assert.equal(lines.length, 1);
    // Archived chats are recoverable through the ordinary door.
    assert.equal(listManagedChats(root, "sam", { includeArchived: true }).some(c => c.id === ids.staleSmoke), true);
    // A second run has nothing to do and says so plainly.
    const second = await organizeChats(root, "sam", { now: later, complete: completer });
    assert.equal(second.renamed.length, 0);
    assert.equal(second.archived.length, 0);
    assert.match(second.summary, /nothing to do/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("organize: nothing is archived before the stale threshold", async () => {
  const root = scratch();
  try {
    const ids = seedMessy(root);
    const result = await organizeChats(root, "sam", { complete: completer });
    assert.equal(result.archived.length, 0);
    const after = titles(root);
    assert.ok(!after.get(ids.staleSmoke)?.archived);
    assert.ok(!after.get(ids.emptyStale)?.archived);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("organize: the chat the owner is speaking in is never archived", async () => {
  const root = scratch();
  try {
    const ids = seedMessy(root);
    const later = new Date(Date.now() + (ORGANIZE_STALE_DAYS + 3) * 86_400_000);
    const result = await organizeChats(root, "sam", { now: later, currentChatId: ids.staleSmoke, complete: completer });
    assert.equal(result.archived.some(a => a.chatId === ids.staleSmoke), false);
    assert.ok(!titles(root).get(ids.staleSmoke)?.archived);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("organize: the sam_manage_chats tool dispatches the pass and refuses visitors", async () => {
  const root = scratch();
  try {
    const store = new ChatStore(root);
    let ownerChat: string, visitorChat: string;
    try {
      const c = store.create("Harbor planning thread", null);
      store.add(c.id, "user", "a real conversation");
      store.add(c.id, "assistant", "noted");
      ownerChat = c.id;
      visitorChat = store.create("Web chat", "sam", { visitor: true }).id;
    } finally { store.close(); }
    const out = await executeOwnToolAsync(root, "sam", "sam_manage_chats", { action: "organize" }, undefined, ownerChat) as { status: string; summary: string };
    assert.equal(out.status, "organized");
    assert.match(out.summary, /nothing to do/);
    const refused = await executeOwnToolAsync(root, "sam", "sam_manage_chats", { action: "organize" }, undefined, visitorChat) as { error: string };
    assert.match(refused.error, /Visitors cannot organize/);
    const noChat = await executeOwnToolAsync(root, "sam", "sam_manage_chats", { action: "organize" }) as { error: string };
    assert.match(noChat.error, /needs the live owner chat/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
