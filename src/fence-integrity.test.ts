import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digestLaw, extractIdentifiers, readLawSnapshot, verifyLawAcrossFold, verifyLawVerbatim,
} from "./fence-integrity.js";
import { PreferenceStore } from "./preferences.js";
import { ChatStore } from "./chats.js";
import { forceCompactChat } from "./compaction.js";
import { readActivity } from "./activity.js";

// Program H item C (filed requirement 4): standing law survives
// any compaction byte-identical, guarded by a post-compaction
// diff + identifier check. These tests pin the check itself -
// including the negative control, a tampered after-read the
// instrument MUST refuse (an instrument that cannot say no is
// decoration) - and the real fold running clean.
function scratch(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "sam-fence-"));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("identifiers: uuids, emails, urls, phone-shaped runs, and letter+digit codes are extracted", () => {
  const ids = extractIdentifiers("Tenant e07a13f0-1111-4222-8333-444444444444, code 47-ALPHA, mail dip@example.com, see https://secondshiftos.com/x, call 813-368-8602, plain words here");
  assert.ok(ids.includes("e07a13f0-1111-4222-8333-444444444444"));
  assert.ok(ids.includes("47-ALPHA"));
  assert.ok(ids.includes("dip@example.com"));
  assert.ok(ids.some(i => i.startsWith("https://secondshiftos.com/x")));
  assert.ok(ids.some(i => i.replace(/\D/g, "") === "8133688602"));
  assert.ok(!ids.includes("plain"));
});

test("verbatim diff: identical snapshots pass; a changed statement and a lost identifier fail by name", () => scratch(root => {
  const prefs = new PreferenceStore(root);
  let lawId = "";
  try {
    const noted = prefs.note("dip", "Never share the Zorblax launch code 47-ALPHA outside the house", "rule", "test");
    lawId = noted.id;
    prefs.note("dip", "Always answer concisely", "rule", "test");
  } finally { prefs.close(); }
  const before = readLawSnapshot(root, "dip");
  assert.equal(verifyLawVerbatim(before, readLawSnapshot(root, "dip")).ok, true, "an untouched store verifies clean");
  const tamperedEntries = before.entries.map(e => e.id === lawId
    ? { id: e.id, statement: "Never share the Zorblax launch code 48-ALPHA outside the house" }
    : e);
  const tampered = { profile: "dip", entries: tamperedEntries, digest: digestLaw(tamperedEntries) };
  const check = verifyLawVerbatim(before, tampered);
  assert.equal(check.ok, false);
  assert.deepEqual(check.changedIds, [lawId]);
  assert.ok(check.missingIdentifiers.includes("47-ALPHA"), "the moved identifier is named");
}));

test("negative control: the across-fold check refuses a tampered after-read", () => scratch(root => {
  const prefs = new PreferenceStore(root);
  try { prefs.note("dip", "The vault code is 47-ALPHA", "rule", "test"); } finally { prefs.close(); }
  const before = readLawSnapshot(root, "dip");
  const moved = [{ id: before.entries[0].id, statement: "The vault code is 99-OMEGA" }];
  const check = verifyLawAcrossFold(root, "dip", before, () => ({ profile: "dip", entries: moved, digest: digestLaw(moved) }));
  assert.equal(check.ok, false);
  assert.equal(check.changedIds.length, 1);
}));

test("a real compaction fold leaves standing law byte-identical and ledgers no fence failure", () => scratch(root => {
  const prefs = new PreferenceStore(root);
  try { prefs.note("dip", "Never share the Zorblax launch code 47-ALPHA outside the house", "rule", "test"); } finally { prefs.close(); }
  const chats = new ChatStore(root);
  let chatId = "";
  try {
    const chat = chats.create("Fold chat", "dip");
    chatId = chat.id;
    for (let i = 0; i < 26; i++) chats.add(chatId, i % 2 === 0 ? "user" : "assistant", "Turn " + String(i + 1) + " about the harbor plan.", "test");
  } finally { chats.close(); }
  const result = forceCompactChat(root, chatId);
  assert.equal(result.compactedNow, true, "the fold lands - the fence check passed it");
  assert.equal(readActivity(root, 100).filter(l => l.kind === "fence-integrity-failed").length, 0);
  const after = readLawSnapshot(root, "dip");
  assert.equal(after.entries[0].statement, "Never share the Zorblax launch code 47-ALPHA outside the house");
}));
