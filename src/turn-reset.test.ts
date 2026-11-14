import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { readActivity } from "./activity.js";
import { awaitChatQueue, chatTurnActive, enqueueChatMessage, listChatQueue, resetChatTurn, TURN_RESET_MESSAGE } from "./chat-queue.js";
import { isStatusCheck } from "./chat-queue.js";
import { claimTokenFor, OWNER_TURN_DEADLINE_MS } from "./turn-control.js";
import { dashboardHtml } from "./dashboard-ui.js";

// Stuck-turn lane (Dip, 2026-11-14: "we need to be able to stop
// that"): a stubbed model through the real queue/turn path proves
// the interactive deadline closes a looping turn with a saved
// checkpoint, a hung request is aborted at the deadline, a status
// check during a turn answers from runtime state immediately,
// and Reset aborts the in-flight request, invalidates the turn,
// cancels queued work, and leaves the chat ready - fast.

type Msg = { role: string; content?: string | null };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let callSeq = 0;
let hangAborted = 0;

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function reply(res: import("node:http").ServerResponse, message: Record<string, unknown>) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...message } }] }));
}
function lastUser(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return String(messages[i].content ?? "");
  return "";
}

async function handleModel(body: { messages: Msg[] }, req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const user = lastUser(body.messages);
  if (user.includes("hang forever")) {
    // A provider call that never answers. The only ways out are
    // the per-request timeout (60s - far too slow for these
    // tests) or the turn control's abort.
    req.on("close", () => { hangAborted++; });
    return;
  }
  if (user.includes("loop forever")) {
    await sleep(30);
    callSeq++;
    return reply(res, { content: null, tool_calls: [toolCall("loop-" + callSeq, "sam_workspace_list", {})] });
  }
  if (user.includes("start slow check")) {
    await sleep(2500);
    return reply(res, { content: "Slow answer landed.", tool_calls: undefined });
  }
  return reply(res, { content: "Quick answer.", tool_calls: undefined });
}

let server: Server;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["SAM_MODEL_ENDPOINT", "SAM_MODEL_API_KEY", "SAM_MODEL", "SAM_MODEL_PROVIDER"];

test.before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  server = createServer((req, res) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => { void handleModel(JSON.parse(data || "{}"), req, res); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  process.env.SAM_MODEL_ENDPOINT = "http://127.0.0.1:" + port + "/v1/chat/completions";
  process.env.SAM_MODEL_API_KEY = "stub-key";
  process.env.SAM_MODEL = "stub-model";
  delete process.env.SAM_MODEL_PROVIDER;
});
test.after(async () => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  server?.close();
});

function scratchRoot(): string { return mkdtempSync(join(tmpdir(), "sam-stuck-")); }
function newChat(root: string, title: string): string {
  const store = new ChatStore(root);
  try { return store.create(title, null).id; } finally { store.close(); }
}
function messages(root: string, chatId: string) {
  const store = new ChatStore(root);
  try { return store.messages(chatId); } finally { store.close(); }
}
async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(25);
  }
}

test("the chosen deadline: three minutes for an interactive owner turn", () => {
  assert.equal(OWNER_TURN_DEADLINE_MS, 180_000);
});

test("status matcher: Dip's phrasings match, lookalikes do not", () => {
  for (const s of ["u seem stuck, are u?", "are you stuck", "are you working?", "what's happening", "do u see what happend?", "do u see what happened?"])
    assert.equal(isStatusCheck(s), true, s);
  for (const s of ["are you stuck on the homework problem", "what's happening with the deploy", "please check whether the worker is stuck and report back in detail", "hello, can you pull the latest numbers for me"])
    assert.equal(isStatusCheck(s), false, s);
});

test("deadline: a looping turn closes with a saved checkpoint and a released claim", async () => {
  const root = scratchRoot();
  try {
    const chatId = newChat(root, "Looper");
    const started = Date.now();
    enqueueChatMessage(root, { chatId, content: "loop forever on this one", source: "dashboard", deadlineMs: 600 });
    await awaitChatQueue(root, chatId, 20000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 8000, "the turn closed near its deadline, not at the ceiling (took " + elapsed + "ms)");
    const assistants = messages(root, chatId).filter(m => m.role === "assistant");
    assert.equal(assistants.length, 1, "exactly one closing answer was saved");
    assert.match(assistants[0].content, /time limit/, "the close is the deadline checkpoint/synthesis");
    assert.equal(chatTurnActive(root, chatId), false, "the claim is released");
    assert.equal(claimTokenFor(root, chatId), null);
    assert.ok(readActivity(root, 30, { kind: "turn-deadline" }).length >= 1, "the deadline trip is ledgered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("deadline: a hung model request is aborted at the deadline, not at the 60s request timeout", async () => {
  const root = scratchRoot();
  try {
    const chatId = newChat(root, "Hanger");
    const started = Date.now();
    enqueueChatMessage(root, { chatId, content: "hang forever on this one", source: "dashboard", deadlineMs: 600 });
    await awaitChatQueue(root, chatId, 20000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 8000, "the hung request died at the deadline (took " + elapsed + "ms)");
    const assistants = messages(root, chatId).filter(m => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.match(assistants[0].content, /stopped that turn at its time limit/);
    assert.equal(chatTurnActive(root, chatId), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("status lane: a status check during a turn answers immediately from runtime state", async () => {
  const root = scratchRoot();
  try {
    const chatId = newChat(root, "Slow check");
    enqueueChatMessage(root, { chatId, content: "start slow check now", source: "dashboard" });
    await waitFor(() => chatTurnActive(root, chatId));
    await sleep(300);
    const receipt = enqueueChatMessage(root, { chatId, content: "u seem stuck, are u?", source: "dashboard" });
    assert.equal(receipt.effect, "status");
    assert.equal(receipt.status, "consumed");
    assert.match(receipt.reply ?? "", /still running/);
    // The answer is already in the transcript while the slow
    // turn is still running - it did not wait on the model.
    const midway = messages(root, chatId).filter(m => m.role === "assistant");
    assert.equal(midway.length, 1);
    assert.match(midway[0].content, /still running/);
    await awaitChatQueue(root, chatId, 20000);
    const after = messages(root, chatId).filter(m => m.role === "assistant");
    assert.equal(after.length, 2, "the slow turn's own answer still landed after the status exchange");
    assert.match(after[1].content, /Slow answer landed/);
    assert.equal(readActivity(root, 30, { kind: "message-status" }).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("status lane: with no turn running, a status-shaped message is ordinary work", async () => {
  const root = scratchRoot();
  try {
    const chatId = newChat(root, "Idle");
    const receipt = enqueueChatMessage(root, { chatId, content: "are you stuck", source: "dashboard" });
    assert.equal(receipt.effect, undefined);
    assert.equal(receipt.status, "queued");
    await awaitChatQueue(root, chatId, 20000);
    const assistants = messages(root, chatId).filter(m => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.match(assistants[0].content, /Quick answer/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reset: aborts the hung request, discards the late reply, cancels the queue, chat ready fast", async () => {
  const root = scratchRoot();
  try {
    const chatId = newChat(root, "Reset target");
    const abortsBefore = hangAborted;
    enqueueChatMessage(root, { chatId, content: "hang forever on this one", source: "dashboard" });
    await waitFor(() => claimTokenFor(root, chatId) !== null);
    await sleep(300); // the request is in flight and hung
    enqueueChatMessage(root, { chatId, content: "a follow-up that should never run", source: "dashboard" });
    const pressedAt = Date.now();
    const result = resetChatTurn(root, chatId);
    assert.equal(result.wasActive, true);
    assert.equal(result.cancelledQueued, 1);
    assert.ok(result.abortedRequests >= 1, "the press aborted the registered in-flight request");
    assert.equal(claimTokenFor(root, chatId), null, "the claim is gone the moment the press returns");
    await awaitChatQueue(root, chatId, 10000);
    const stopLatencyMs = Date.now() - pressedAt;
    assert.ok(stopLatencyMs < 2000, "the chat was ready fast after the press (took " + stopLatencyMs + "ms)");
    assert.ok(hangAborted > abortsBefore, "the hung provider request was actually aborted, not abandoned");
    const assistants = messages(root, chatId).filter(m => m.role === "assistant");
    assert.deepEqual(assistants.map(m => m.content), [TURN_RESET_MESSAGE], "only the reset status message landed; the killed turn saved nothing");
    const byContent = new Map(listChatQueue(root, chatId).map(i => [i.content, i.status]));
    assert.equal(byContent.get("a follow-up that should never run"), "cancelled");
    assert.equal(readActivity(root, 30, { kind: "turn-reset" }).length, 1, "exactly one turn-reset ledger line");
    // The next simple message runs as a fresh turn and answers.
    enqueueChatMessage(root, { chatId, content: "quick question after the reset", source: "dashboard" });
    await awaitChatQueue(root, chatId, 20000);
    const after = messages(root, chatId).filter(m => m.role === "assistant");
    assert.equal(after.length, 2);
    assert.match(after[1].content, /Quick answer/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reset: a press with nothing running is a quiet no-op", async () => {
  const root = scratchRoot();
  try {
    const chatId = newChat(root, "Idle reset");
    const result = resetChatTurn(root, chatId);
    assert.equal(result.wasActive, false);
    assert.equal(result.cancelledQueued, 0);
    assert.equal(messages(root, chatId).length, 0, "no status message is posted when nothing was stopped");
    assert.equal(readActivity(root, 30, { kind: "turn-reset" }).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dashboard page: the Reset control ships and its POST carries the dashboard header", () => {
  assert.match(dashboardHtml, /id="resetTurn"/);
  assert.match(dashboardHtml, /chats\/'\+selected\+\'\/reset/);
  const resetFetch = dashboardHtml.split("/reset'")[0].split("fetch(").pop() ?? "";
  assert.match(resetFetch + dashboardHtml.split("/reset'")[1].slice(0, 200), /X-SAM-Request/, "the reset POST carries X-SAM-Request");
});
