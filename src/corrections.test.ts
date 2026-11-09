import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCorrection, proposeCorrection, withoutCorrectedRules } from "./corrections.js";
import { listActions, decideAction } from "./actions.js";
import { PreferenceStore } from "./preferences.js";
import { ChatStore } from "./chats.js";
import { consolidatePreferences } from "./heartbeat.js";
import { readActivity } from "./activity.js";

test("correction detection: the proof case and its family become rule statements", () => {
  // Dip, 2026-11-08: "don't call it a mini" washed past. It must not again.
  assert.equal(detectCorrection("don't call it a mini")?.statement, "Never call it a mini");
  assert.equal(detectCorrection("Don’t call it a mini, call it their own SAM")?.statement, "Never call it a mini");
  assert.equal(detectCorrection("do not call them minis")?.statement, "Never call them minis");
  assert.equal(detectCorrection("stop calling it a mini")?.statement, "Never call it a mini");
  assert.equal(detectCorrection("stop doing long sponsor intros")?.statement, "Stop doing long sponsor intros");
  assert.equal(detectCorrection("Don't use em dashes in replies")?.statement, "Never use em dashes in replies");
  assert.equal(detectCorrection("No, don't send drafts without asking")?.statement, "Never send drafts without asking");
  assert.equal(detectCorrection("call it their own SAM, not a mini")?.statement, "Call it their own SAM, not a mini");
  assert.equal(detectCorrection("use the short form instead of the long one")?.statement, "Use the short form instead of the long one");
  assert.equal(detectCorrection("no, not like that, keep answers short")?.statement, "Keep answers short");
});

test("correction detection: vague corrections and non-corrections propose nothing", () => {
  assert.equal(detectCorrection("no, not like that"), null);
  assert.equal(detectCorrection("don't do that"), null);
  assert.equal(detectCorrection("stop doing that"), null);
  // First-person dislikes are preferences, not corrections of SAM.
  assert.equal(detectCorrection("I don't like Mondays"), null);
  assert.equal(detectCorrection("I don't like long answers"), null);
  // Prospective rules keep the preferences path (law when stated).
  assert.equal(detectCorrection("Never trade on Fridays"), null);
  assert.equal(detectCorrection("I like short answers"), null);
  assert.equal(detectCorrection("What is the stack health?"), null);
  assert.equal(detectCorrection("The stack is still frozen"), null);
});

test("a correction proposes a P1 law, deduped, and only approval makes it law", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-corr-"));
  try {
    const first = proposeCorrection(root, { actor: "dip", chatId: "chat-1", text: "don't call it a mini" })?.proposal;
    assert.ok(first);
    assert.equal(first.kind, "law");
    assert.equal(first.status, "pending");
    assert.equal(first.detail, "Never call it a mini");
    assert.equal(first.chatId, "chat-1");
    // Pending is not law: the profile's law is empty until the owner approves.
    const prefs = new PreferenceStore(root);
    assert.equal(prefs.lawsFor("dip").length, 0);
    prefs.close();
    // The same correction again returns the same proposal, never a duplicate.
    const again = proposeCorrection(root, { actor: "dip", chatId: "chat-1", text: "Don't call it a mini!" });
    assert.equal(again?.proposal.id, first.id);
    assert.equal(again?.created, false);
    assert.equal(listActions(root).filter(a => a.status === "pending").length, 1);
    assert.ok(readActivity(root, 50).some(a => a.kind === "correction" && /Never call it a mini/.test(a.summary)));
    // Approval executes through the ordinary P1 executor: now it is law.
    const decided = await decideAction(root, first.id, true);
    assert.equal(decided.status, "done");
    const after = new PreferenceStore(root);
    assert.deepEqual(after.lawsFor("dip").map(l => l.statement), ["Never call it a mini"]);
    after.close();
    // Once it is law, the same correction proposes nothing new.
    assert.equal(proposeCorrection(root, { actor: "dip", text: "don't call it a mini" }), null);
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a rejected correction leaves no law and no residue", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-corr2-"));
  try {
    const prop = proposeCorrection(root, { actor: "trading", text: "stop doing long sponsor intros" })?.proposal;
    assert.ok(prop);
    await decideAction(root, prop.id, false);
    const prefs = new PreferenceStore(root);
    assert.equal(prefs.lawsFor("trading").length, 0);
    prefs.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("consolidation routes corrections to the gate instead of noting instant law", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-corr3-"));
  try {
    const db = new ChatStore(root);
    const chat = db.create("Desk", "trading");
    db.add(chat.id, "user", "Don't call it a mini");
    db.add(chat.id, "user", "I like short answers");
    db.close();
    const first = consolidatePreferences(root);
    assert.equal(first.corrections, 1);
    const pending = listActions(root).filter(a => a.status === "pending" && a.kind === "law");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].detail, "Never call it a mini");
    const prefs = new PreferenceStore(root);
    assert.equal(prefs.lawsFor("trading").length, 0);
    // The like in the next message still notes through the ordinary path.
    assert.equal(prefs.list("trading").filter(p => p.kind === "like").length, 1);
    prefs.close();
    // The watermark scan never re-proposes the same correction.
    const second = consolidatePreferences(root);
    assert.equal(second.corrections, 0);
    assert.equal(listActions(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("withoutCorrectedRules drops only the rule that restates the correction", () => {
  const found = [
    { statement: "trade only on tuesdays", kind: "rule" as const },
    { statement: "short answers", kind: "like" as const },
  ];
  const kept = withoutCorrectedRules(found, { statement: "Never call it a mini" });
  assert.deepEqual(kept.map(f => f.kind), ["rule", "like"]); // no textual overlap: untouched
  const dropped = withoutCorrectedRules(
    [{ statement: "Never call it a mini", kind: "rule" as const }, { statement: "short answers", kind: "like" as const }],
    { statement: "Never call it a mini" },
  );
  assert.deepEqual(dropped.map(f => f.kind), ["like"]);
  assert.equal(withoutCorrectedRules(found, null).length, 2);
});
