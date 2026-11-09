import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeAction, decideAction, listActions } from "./actions.js";
import { readActivity } from "./activity.js";
import { MemoryStore } from "./memory.js";
import { PreferenceStore } from "./preferences.js";
import { heartbeatJobs } from "./heartbeat.js";
import { executeOwnTool } from "./own-tools.js";

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-actions-")); }

test("actions: an approved note lands in the actor's memory scope and nowhere else", () => {
  const root = fresh();
  try {
    const a = proposeAction(root, { actor: "alex", kind: "note", title: "Save the launch date", detail: "The launch date is March 3" });
    assert.equal(a.status, "pending");
    const done = decideAction(root, a.id, true);
    assert.equal(done.status, "done");
    const store = new MemoryStore(join(root, ".sam", "missions.db"));
    try {
      const mine = store.list(undefined, ["profile:alex"]);
      assert.equal(mine.length, 1);
      assert.match(mine[0].content, /March 3/);
      assert.equal(store.list(undefined, ["core"]).length, 0);
      assert.equal(store.list(undefined, ["profile:blair"]).length, 0);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actions: an approved law becomes standing law; a rejected one never executes", () => {
  const root = fresh();
  try {
    const good = proposeAction(root, { actor: "alex", kind: "law", title: "Rule", detail: "Always confirm before spending" });
    decideAction(root, good.id, true);
    const prefs = new PreferenceStore(root);
    try { assert.ok(prefs.lawsFor("alex").some(l => l.statement.includes("confirm before spending"))); }
    finally { prefs.close(); }
    const bad = proposeAction(root, { actor: "alex", kind: "note", title: "Nope", detail: "should never be saved" });
    const rejected = decideAction(root, bad.id, false);
    assert.equal(rejected.status, "rejected");
    const store = new MemoryStore(join(root, ".sam", "missions.db"));
    try { assert.equal(store.list(undefined, ["profile:alex"]).length, 0); }
    finally { store.close(); }
    assert.throws(() => decideAction(root, bad.id, true), /already decided/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actions: an approved heartbeat creates the job, and the whole life is in the ledger", () => {
  const root = fresh();
  try {
    const a = proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Morning check", detail: JSON.stringify({ name: "morning check", minutes: 1440, profile: "sam", prompt: "Summarize overnight changes" }) });
    decideAction(root, a.id, true);
    assert.equal(heartbeatJobs(root).length, 1);
    const kinds = readActivity(root, 50).map(x => x.kind);
    assert.ok(kinds.includes("proposal"));
    assert.ok(kinds.includes("approved"));
    assert.equal(listActions(root).filter(x => x.status === "done").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actions: the chat tool proposes but cannot execute - approval is the only door", () => {
  const root = fresh();
  try {
    const out = executeOwnTool(root, "alex", "sam_propose_action", { kind: "note", title: "From chat", detail: "A fact from a chat" }) as { status: string; id: string };
    assert.equal(out.status, "pending_owner_approval");
    const store = new MemoryStore(join(root, ".sam", "missions.db"));
    try { assert.equal(store.list(undefined, ["profile:alex"]).length, 0); }
    finally { store.close(); }
    decideAction(root, out.id, true);
    const store2 = new MemoryStore(join(root, ".sam", "missions.db"));
    try { assert.equal(store2.list(undefined, ["profile:alex"]).length, 1); }
    finally { store2.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
