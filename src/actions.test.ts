import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { proposeAction, decideAction, listActions, correctedProfileName } from "./actions.js";
import { readActivity } from "./activity.js";
import { MemoryStore } from "./memory.js";
import { PreferenceStore } from "./preferences.js";
import { heartbeatJobs } from "./heartbeat.js";
import { executeOwnTool, ownToolsFor } from "./own-tools.js";
import { ChatStore } from "./chats.js";

function registerProfile(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-actions-")); }

test("actions: an approved note lands in the actor's memory scope and nowhere else", async () => {
  const root = fresh();
  try {
    const a = proposeAction(root, { actor: "alex", kind: "note", title: "Save the launch date", detail: "The launch date is March 3" });
    assert.equal(a.status, "pending");
    const done = await await decideAction(root, a.id, true);
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

test("actions: an approved law becomes standing law; a rejected one never executes", async () => {
  const root = fresh();
  try {
    const good = proposeAction(root, { actor: "alex", kind: "law", title: "Rule", detail: "Always confirm before spending" });
    await decideAction(root, good.id, true);
    const prefs = new PreferenceStore(root);
    try { assert.ok(prefs.lawsFor("alex").some(l => l.statement.includes("confirm before spending"))); }
    finally { prefs.close(); }
    const bad = proposeAction(root, { actor: "alex", kind: "note", title: "Nope", detail: "should never be saved" });
    const rejected = await decideAction(root, bad.id, false);
    assert.equal(rejected.status, "rejected");
    const store = new MemoryStore(join(root, ".sam", "missions.db"));
    try { assert.equal(store.list(undefined, ["profile:alex"]).length, 0); }
    finally { store.close(); }
    await assert.rejects(decideAction(root, bad.id, true), /already decided/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actions: an approved heartbeat creates the job, and the whole life is in the ledger", async () => {
  const root = fresh();
  try {
    const a = proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Morning check", detail: JSON.stringify({ name: "morning check", minutes: 1440, profile: "sam", prompt: "Summarize overnight changes" }) });
    await decideAction(root, a.id, true);
    assert.equal(heartbeatJobs(root).length, 1);
    const kinds = readActivity(root, 50).map(x => x.kind);
    assert.ok(kinds.includes("proposal"));
    assert.ok(kinds.includes("approved"));
    assert.equal(listActions(root).filter(x => x.status === "done").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actions: the chat tool proposes but cannot execute - approval is the only door", async () => {
  const root = fresh();
  try {
    const out = executeOwnTool(root, "alex", "sam_propose_action", { kind: "note", title: "From chat", detail: "A fact from a chat" }) as { status: string; id: string };
    assert.equal(out.status, "pending_owner_approval");
    const store = new MemoryStore(join(root, ".sam", "missions.db"));
    try { assert.equal(store.list(undefined, ["profile:alex"]).length, 0); }
    finally { store.close(); }
    await decideAction(root, out.id, true);
    const store2 = new MemoryStore(join(root, ".sam", "missions.db"));
    try { assert.equal(store2.list(undefined, ["profile:alex"]).length, 1); }
    finally { store2.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actions: a heartbeat proposal naming a connector display name is refused at proposal time, with the valid names and the likely fix", async () => {
  const root = fresh();
  try {
    registerProfile(root, "second-shift");
    const detail = JSON.stringify({ name: "morning leads", minutes: 1440, profile: "Second Shift", prompt: "Check new leads" });
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Morning leads", detail }), /Unknown profile "Second Shift".*Valid profiles: sam, second-shift.*Did you mean "second-shift"/);
    assert.equal(listActions(root).length, 0);
    // The chat tool surfaces the same refusal verbatim so the model can retry in-turn.
    const out = executeOwnTool(root, "sam", "sam_propose_action", { kind: "heartbeat", title: "Morning leads", detail }) as { error?: string };
    assert.match(out.error ?? "", /Valid profiles: sam, second-shift/);
    assert.equal(listActions(root).length, 0);
    // The tool definition the model sees carries the real profile names.
    const tool = ownToolsFor(root).find(t => (t as { function?: { name?: string } }).function?.name === "sam_propose_action") as { function: { description: string } };
    assert.match(tool.function.description, /detail\.profile MUST be exactly one of these profile names: sam, second-shift/);
    assert.equal(correctedProfileName(root, "Second Shift"), "second-shift");
    assert.equal(correctedProfileName(root, "nope"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actions: heartbeat proposals validate detail shape at proposal time; a registered profile executes", async () => {
  const root = fresh();
  try {
    registerProfile(root, "trading");
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Bad", detail: "not json" }), /Invalid heartbeat detail/);
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Bad", detail: JSON.stringify({ name: "x", minutes: 1, profile: "trading", prompt: "p" }) }), /minutes/);
    assert.throws(() => proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Bad", detail: JSON.stringify({ name: "x", minutes: 60, profile: "ghost", prompt: "p" }) }), /Unknown profile "ghost" in heartbeat detail\. Valid profiles: sam, trading/);
    assert.equal(listActions(root).length, 0);
    const ok = proposeAction(root, { actor: "sam", kind: "heartbeat", title: "Stack watch", detail: JSON.stringify({ name: "stack watch 2", minutes: 60, profile: "trading", prompt: "Check the stack" }) });
    const done = await decideAction(root, ok.id, true);
    assert.equal(done.status, "done");
    assert.equal(heartbeatJobs(root).length, 1);
    assert.equal(heartbeatJobs(root)[0].profile, "trading");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actions: a legacy dead card fails with a corrected re-proposal pending, and approving it creates the job", async () => {
  const root = fresh();
  try {
    registerProfile(root, "second-shift");
    // A proposal written before proposal-time validation existed, seeded
    // straight into the store the way Dip's PC record sits today.
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacy = { id: "1d255a8d-6d00-47c6-b00e-5f2e089ab0d6", actor: "sam", kind: "heartbeat", title: "Morning lead check", detail: JSON.stringify({ name: "morning lead check", minutes: 1440, profile: "Second Shift", prompt: "Check new leads" }), status: "pending", createdAt: new Date().toISOString(), decidedAt: null, result: null, chatId: null };
    writeFileSync(join(root, ".sam", "actions.json"), JSON.stringify([legacy], null, 2));
    const failed = await decideAction(root, legacy.id, true);
    assert.equal(failed.status, "failed");
    assert.match(failed.result ?? "", /Corrected re-proposal pending approval: [0-9a-f-]{36} \(profile second-shift\)/);
    const pending = listActions(root).filter(x => x.status === "pending");
    assert.equal(pending.length, 1);
    assert.equal(JSON.parse(pending[0].detail).profile, "second-shift");
    const done = await decideAction(root, pending[0].id, true);
    assert.equal(done.status, "done");
    assert.equal(heartbeatJobs(root).length, 1);
    assert.ok(readActivity(root, 50).some(l => l.kind === "reproposal"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actions: a proposal made in a chat carries that chat's id, and legacy records read as unattached", async () => {
  const root = fresh();
  try {
    const out = executeOwnTool(root, "alex", "sam_propose_action", { kind: "note", title: "In chat", detail: "stamped" }, "chat-123") as { id: string };
    const listed = listActions(root).find(x => x.id === out.id);
    assert.equal(listed?.chatId, "chat-123");
    assert.equal(listActions(root).filter(x => x.chatId === "chat-123").length, 1);
    assert.equal(listActions(root).filter(x => x.chatId === "other-chat").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
