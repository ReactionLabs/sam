import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { PreferenceStore } from "./preferences.js";
import { consolidatePreferences } from "./heartbeat.js";
import { listActions } from "./actions.js";
import { issueDoorKey, listDoors, doorModeForKey, doorForKey } from "./mini-door.js";
import { spawnMini } from "./minis.js";
import { listEpisodes } from "./episodes.js";

test("visitor chats: the flag is set at creation and inherited by branches", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-visitor-"));
  try {
    const db = new ChatStore(root);
    const owner = db.create("Owner desk", "trading");
    const visitor = db.create("Web chat", "trading", { visitor: true });
    assert.equal(db.isVisitor(owner.id), false);
    assert.equal(db.isVisitor(visitor.id), true);
    const branch = db.branch(visitor.id, "Branch");
    assert.equal(db.isVisitor(branch.id), true);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("visitor mode: consolidation captures NOTHING from a visitor chat, owner chat untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-visitor2-"));
  try {
    const db = new ChatStore(root);
    db.createAgent("biz", "A business mini");
    const visitor = db.create("Web chat", "biz", { visitor: true });
    // A visitor trying every capture shape: a preference, a rule, a correction.
    db.add(visitor.id, "user", "I like short answers");
    db.add(visitor.id, "user", "Remember that the shop opens at 6am");
    db.add(visitor.id, "user", "Don't call it a mini");
    const owner = db.create("Owner desk", "biz");
    db.add(owner.id, "user", "I like short answers");
    db.close();
    const result = consolidatePreferences(root);
    assert.equal(result.visitorSkipped, 3);
    assert.equal(result.corrections, 0);
    // No law proposal was routed from the visitor's correction.
    assert.equal(listActions(root).filter(a => a.kind === "law").length, 0);
    const prefs = new PreferenceStore(root);
    const noted = prefs.list("biz");
    prefs.close();
    // Exactly one note exists: the owner's like. The visitor's identical
    // like and the "remember" rule never landed.
    assert.equal(noted.length, 1);
    assert.equal(noted[0].kind, "like");
    // But the visit itself is still history: an episode records the day.
    const episodes = listEpisodes(root, "biz");
    assert.ok(episodes.length >= 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("visitor doors: mode is issued, audited, and defaults to owner for legacy doors", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-visitor3-"));
  try {
    spawnMini(root, { name: "shop", person: "Pat", instructions: "Front desk for Pat's shop" });
    const ownerKey = issueDoorKey(root, "shop");
    assert.equal(doorModeForKey(root, ownerKey), "owner");
    const visitorKey = issueDoorKey(root, "shop", { visitor: true });
    assert.equal(doorModeForKey(root, visitorKey), "visitor");
    assert.equal(doorForKey(root, visitorKey), "shop");
    const audit = listDoors(root);
    assert.equal(audit.length, 1); // reissue replaced the door, mode included
    assert.equal(audit[0].mode, "visitor");
    assert.equal(doorModeForKey(root, "f".repeat(64)), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
