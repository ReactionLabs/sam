import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardHtml } from "./dashboard-ui.js";
import { ChatStore } from "./chats.js";
import { planJob, listDispatchRefusals, type LaneSpec } from "./orchestration.js";
import { runInspectorForChat, panelMemory, panelFiles } from "./run-inspector.js";
import { MemoryStore } from "./memory.js";

function lane(partial: Partial<LaneSpec> & { name: string }): LaneSpec {
  return {
    kind: "research",
    goal: "goal for " + partial.name,
    doneLooksLike: "done shape for " + partial.name,
    notDoneLooksLike: "not done shape for " + partial.name,
    landsAt: "the job report",
    ...partial,
  };
}
function freshRoot(): string { return mkdtempSync(join(tmpdir(), "panel-")); }

test("the served page script parses and carries the panel furniture", () => {
  const m = dashboardHtml.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, "page has a script");
  assert.doesNotThrow(() => new Function(m![1]), "page script must parse");
  for (const pin of [
    "data-pane=\"run\"", "data-pane=\"memory\"", "data-pane=\"files\"", "data-pane=\"activity\"",
    "id=\"railLeft\"", "id=\"railRight\"", "samRails", "id=\"chatSearch\"",
    "'Pinned'", "'Active'", "'Archived ('", "[[callout]] ", "renderCallout",
    "className='speaker'", "'DIP'", "Read-only here. Changes go through Sam",
    "/run'", "/panel/memory?", "/panel/files?",
  ]) assert.ok(dashboardHtml.includes(pin), "page carries " + pin);
});

test("a refused dispatch is recorded with requested vs available, and callouts into its chat", () => {
  const root = freshRoot();
  const store = new ChatStore(root);
  const chat = store.create("Dispatch test");
  store.close();
  const lanes = [lane({ name: "b1", kind: "build" }), lane({ name: "b2", kind: "build" }), lane({ name: "b3", kind: "build" })];
  assert.throws(() => planJob(root, { ask: "too big", lanes, chatId: chat.id }), /does not fit the remaining worker pool/);
  const refusals = listDispatchRefusals(root, "sam");
  assert.equal(refusals.length, 1);
  assert.deepEqual(refusals[0].requested, { rounds: 6, maxCalls: 18 });
  assert.deepEqual(refusals[0].available, { rounds: 6, maxCalls: 16 });
  assert.equal(refusals[0].chatId, chat.id);
  const check = new ChatStore(root);
  const events = check.events(chat.id);
  check.close();
  assert.equal(events.length, 1);
  assert.ok(events[0].content.startsWith("[[callout]] Dispatch blocked · 0 of 3 workers started"), events[0].content);
  const view = runInspectorForChat(root, chat.id);
  assert.equal(view.job, null);
  assert.equal(view.refusals.length, 1);
  assert.equal(view.turnStartingBudget, null, "never recorded, so Unavailable");
  assert.equal(view.codeRoot, null, "no code root designated in a fresh workspace");
  assert.deepEqual(view.poolNow, { rounds: 6, maxCalls: 16 });
});

test("a planned job records the pool at dispatch and its lane budgets", () => {
  const root = freshRoot();
  const store = new ChatStore(root);
  const chat = store.create("Healthy test");
  store.close();
  const { job } = planJob(root, { ask: "small job", lanes: [lane({ name: "r1" })], chatId: chat.id });
  assert.deepEqual(job.poolAtDispatch, { rounds: 6, maxCalls: 16 });
  assert.equal(job.chatId, chat.id);
  const view = runInspectorForChat(root, chat.id);
  assert.ok(view.job);
  assert.equal(view.job!.lanes.length, 1);
  assert.deepEqual(view.job!.lanes[0].budget, { rounds: 2, maxCalls: 5 });
  assert.equal(view.job!.fallbacks, 0);
});

test("panel memory and files read the real stores for the profile", () => {
  const root = freshRoot();
  const mem = new MemoryStore(join(root, ".sam", "missions.db"));
  mem.add({ kind: "decision", content: "We ship on Fridays.\nDetails follow.", scope: "core", source: "test" });
  mem.close();
  const list = panelMemory(root, "sam");
  assert.equal(list.records.length, 1);
  assert.equal(list.records[0].kind, "decision");
  const one = panelMemory(root, "sam", "", list.records[0].id);
  assert.ok(one.record && one.record.content.includes("Details follow."));
  const files = panelFiles(root, "sam");
  assert.ok(Array.isArray(files.law));
  assert.ok(files.capabilities.length > 0, "capability statement lists the tool hand");
});
