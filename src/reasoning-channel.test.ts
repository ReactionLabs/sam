import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { runChatTurn } from "./agent-turn.js";
import { readActivity } from "./activity.js";
import { resetChatTurn } from "./chat-queue.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

// Reasoning channel separation (Dip, live, twice on 2026-11-14):
// the model's reasoning reached the owner's screen as a chat
// bubble - once as the partial of a think-then-answer completion
// ("The owner asks what can be built in artifacts..."), once as
// narration riding a tool round. The scored text-pattern guard
// (reply-guard.ts) watched the partial seam and under-scored both.
// These tests pin the STRUCTURAL fix at the provider/turn seam:
// a stubbed model streams reasoning exactly the way MiniMax does,
// and the message store - polled WHILE the turn runs, not just
// after it - must never hold reasoning text, in any row, at any
// moment. Only the answer may ever land.

type Msg = { role: string; content?: string | null };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const MARKER_A = "REASONINGMARKERA7F3";
const MARKER_B = "REASONINGMARKERB91C";
const MARKER_C = "REASONINGMARKERC55D";
const ANSWER_A = "Artifacts are durable deliverables in your library: an html page or a markdown document.";
const ANSWER_B = "The workspace listing came back and the answer stands on it.";
const NARRATION_B = "Let me pull the workspace listing first.";

// Scenario C's gate: the stub resolves this once it has written
// the think deltas and is holding the stream open, so the test
// resets at a deterministic mid-reasoning moment.
let hangStreamOpen: (() => void) | null = null;
let hangRes: import("node:http").ServerResponse | null = null;

function sse(res: import("node:http").ServerResponse, events: string[]) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(events.join("\n\n") + "\n\n");
}
function delta(content: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: { content } }] });
}
function toolDelta(id: string, name: string, args: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] } }] });
}
function finish(reason: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
}
const DONE = "data: [DONE]";

async function handleModel(body: { messages: Msg[]; stream?: boolean }, res: import("node:http").ServerResponse) {
  const messages = body.messages ?? [];
  const userText = messages.filter(m => m.role === "user").map(m => String(m.content ?? "")).join("\n");
  const hasToolResult = messages.some(m => m.role === "tool");
  if (userText.includes("REASONING_HANG")) {
    // Think deltas out, then the stream simply never finishes:
    // the turn is cut mid-reasoning by the owner's reset.
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(delta("<think>" + MARKER_C + ": the owner asks a question and I am still thinking it through, no answer yet") + "\n\n");
    hangRes = res;
    hangStreamOpen?.();
    return; // hold forever; the reset aborts the request
  }
  if (userText.includes("REASONING_TOOL_ROUND")) {
    if (!hasToolResult) {
      // Reasoning (tagged), then untagged narration, then a tool
      // call - the incident's second shape in one completion.
      return sse(res, [
        delta("<think>" + MARKER_B + ": the owner wants the workspace listing; sam_workspace_list is the call.</think>"),
        delta(NARRATION_B),
        toolDelta("call-b1", "sam_workspace_list", "{}"),
        finish("tool_calls"),
        DONE,
      ]);
    }
    return sse(res, [
      delta("<think>" + MARKER_B + " again: now answer from the listing.</think>"),
      delta(ANSWER_B),
      finish("stop"),
      DONE,
    ]);
  }
  if (userText.includes("REASONING_STREAM_ANSWER")) {
    // The incident's first shape: one completion, think first,
    // answer after. The think streams out, the stream HOLDS (so
    // the test can poll the store mid-turn, the moment Dip's
    // screenshot captured), then the answer streams.
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(delta("<think>The owner asks what can be built in artifacts. I should answer plainly about the artifact capability. " + MARKER_A + "</think>") + "\n\n");
    await sleep(900);
    res.end([delta(ANSWER_A), finish("stop"), DONE].join("\n\n") + "\n\n");
    return;
  }
  return sse(res, [delta("Stub model: unscripted turn."), finish("stop"), DONE]);
}

let server: Server;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["SAM_MODEL_ENDPOINT", "SAM_MODEL_API_KEY", "SAM_MODEL", "SAM_MODEL_PROVIDER"];

test.before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  server = createServer((req, res) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => { void handleModel(JSON.parse(data || "{}"), res); });
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
  hangRes?.destroy();
  server?.closeAllConnections?.();
  server?.close();
});

function scratchRoot(): string { return mkdtempSync(join(tmpdir(), "sam-reasoning-channel-")); }
function newChat(root: string, title: string): string {
  const store = new ChatStore(root);
  try { return store.create(title, null).id; } finally { store.close(); }
}
function allAssistantTexts(root: string, chatId: string): string[] {
  const store = new ChatStore(root);
  try { return store.messages(chatId).filter(m => m.role === "assistant").map(m => m.content); }
  finally { store.close(); }
}

test("reasoning channel: a think-then-answer stream never puts reasoning in the store, even mid-turn", async () => {
  const root = scratchRoot();
  try {
    const chatId = newChat(root, "Reasoning stream");
    const seenDuring: string[] = [];
    let polls = 0;
    const turn = runChatTurn(root, chatId, "REASONING_STREAM_ANSWER What all can u build in artifacts?", { source: "dashboard" });
    const poller = setInterval(() => {
      polls++;
      try { seenDuring.push(...allAssistantTexts(root, chatId)); } catch { /* the store mid-turn is the point; a locked read retries next tick */ }
    }, 40);
    let reply: string;
    try { reply = await turn; } finally { clearInterval(poller); }
    assert.ok(polls >= 5, "the store was polled while the think half of the stream was still arriving (" + polls + " polls)");
    assert.equal(reply, ANSWER_A);
    for (const text of seenDuring) {
      assert.ok(!text.includes(MARKER_A), "no reasoning marker was ever in the store mid-turn");
      assert.ok(!text.includes("The owner asks"), "no reasoning prose was ever in the store mid-turn");
    }
    const store = new ChatStore(root);
    try {
      const assistants = store.messages(chatId).filter(m => m.role === "assistant");
      assert.equal(assistants.length, 1, "exactly one assistant message landed");
      assert.equal(assistants[0].content, ANSWER_A);
      assert.equal(assistants[0].partial, 0, "the answer is finished, not a partial");
      assert.equal(store.openPartial(chatId), null, "no partial row survives the turn");
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reasoning channel: narration riding a tool round is withheld; only the answer lands", async () => {
  const root = scratchRoot();
  try {
    const chatId = newChat(root, "Reasoning tool round");
    const seenDuring: string[] = [];
    const turn = runChatTurn(root, chatId, "REASONING_TOOL_ROUND List the workspace and tell me what you see.", { source: "dashboard" });
    const poller = setInterval(() => {
      try { seenDuring.push(...allAssistantTexts(root, chatId)); } catch { /* as above */ }
    }, 25);
    let reply: string;
    try { reply = await turn; } finally { clearInterval(poller); }
    assert.equal(reply, ANSWER_B);
    for (const text of [...seenDuring, ...allAssistantTexts(root, chatId)]) {
      assert.ok(!text.includes(MARKER_B), "tagged reasoning never reached the store");
      assert.ok(!text.includes(NARRATION_B), "untagged tool-round narration never reached the store");
    }
    const store = new ChatStore(root);
    try {
      const assistants = store.messages(chatId).filter(m => m.role === "assistant");
      assert.equal(assistants.length, 1);
      assert.equal(assistants[0].content, ANSWER_B);
    } finally { store.close(); }
    // The withheld narration is ledgered once, by size only: the
    // line exists, and it carries neither the narration nor the
    // reasoning text.
    const lines = readActivity(root, 50, { kind: "narration-channel" });
    assert.equal(lines.length, 1, "one narration-channel line for the turn");
    assert.ok(!lines[0].summary.includes(NARRATION_B) && !lines[0].summary.includes(MARKER_B), "the ledger line names sizes, never the words");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reasoning channel: a turn cut mid-reasoning by Reset leaves no partial behind", async () => {
  const root = scratchRoot();
  try {
    const chatId = newChat(root, "Reasoning cut");
    const streamOpen = new Promise<void>(resolve => { hangStreamOpen = resolve; });
    const turn = runChatTurn(root, chatId, "REASONING_HANG Tell me about artifacts.", { source: "dashboard" });
    await streamOpen; // think deltas are out; the model is mid-reasoning
    await sleep(150);
    const reset = resetChatTurn(root, chatId);
    assert.ok(reset.abortedRequests >= 1, "the reset aborted the in-flight request");
    const reply = await turn;
    assert.equal(reply, "", "a reset turn closes silently, saving nothing");
    const store = new ChatStore(root);
    try {
      const msgs = store.messages(chatId);
      assert.equal(msgs.filter(m => m.role === "assistant").length, 0, "no assistant row exists from the cut turn");
      assert.equal(store.openPartial(chatId), null, "no partial row survives");
      assert.ok(msgs.every(m => !m.content.includes(MARKER_C)), "no reasoning text anywhere in the transcript");
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); hangStreamOpen = null; hangRes?.destroy(); hangRes = null; }
});

test("reasoning channel: the provider routes by disposition - narration channel for tool rounds, answer channel only for turn-enders", async () => {
  const partials: string[] = [];
  const narrations: string[] = [];
  const local = createServer((req, res) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => {
      const body = JSON.parse(data || "{}") as { messages: Msg[] };
      const userText = body.messages.map(m => String(m.content ?? "")).join("\n");
      if (userText.includes("WITH_CALLS")) {
        return sse(res, [delta("<think>hidden</think>Working notes before the call."), toolDelta("call-p1", "sam_workspace_list", "{}"), finish("tool_calls"), DONE]);
      }
      return sse(res, [delta("<think>hidden</think>The plain answer."), finish("stop"), DONE]);
    });
  });
  local.listen(0, "127.0.0.1");
  await once(local, "listening");
  try {
    const port = (local.address() as { port: number }).port;
    const provider = new OpenAICompatibleProvider("http://127.0.0.1:" + port + "/v1/chat/completions", "");
    provider.onPartial = t => { partials.push(t); };
    provider.onNarration = t => { narrations.push(t); };
    const withCalls = await provider.completeConnectorTurn("mock", [{ role: "user", content: "WITH_CALLS please" }], []);
    assert.equal(withCalls.calls.length, 1);
    assert.deepEqual(partials, [], "the answer channel stayed silent for a tool round");
    assert.deepEqual(narrations, ["Working notes before the call."], "the narration rode its own channel, think-stripped");
    const plain = await provider.completeConnectorTurn("mock", [{ role: "user", content: "plain please" }], []);
    assert.equal(plain.content, "The plain answer.");
    assert.deepEqual(partials, ["The plain answer."], "the answer channel reported the turn-ending text exactly once");
    assert.equal(narrations.length, 1, "no narration for a call-free completion");
  } finally { local.close(); await once(local, "close"); }
});

test("reasoning channel: a stream that dies mid-answer salvages the answer-so-far to the answer channel, once", async () => {
  const partials: string[] = [];
  const narrations: string[] = [];
  const local = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(delta("Hello ") + "\n\n");
    setTimeout(() => { res.socket?.destroy(); }, 60);
  });
  local.listen(0, "127.0.0.1");
  await once(local, "listening");
  try {
    const port = (local.address() as { port: number }).port;
    const provider = new OpenAICompatibleProvider("http://127.0.0.1:" + port + "/v1/chat/completions", "");
    provider.onPartial = t => { partials.push(t); };
    provider.onNarration = t => { narrations.push(t); };
    await assert.rejects(provider.completeConnectorTurn("mock", [{ role: "user", content: "say hello" }], []));
    assert.deepEqual(partials, ["Hello"], "the killed answer's text is salvaged for the resume path, stripped, exactly once");
    assert.deepEqual(narrations, [], "nothing rode the narration channel");
  } finally { local.close(); await once(local, "close"); }
});

test("reasoning channel: a stream that dies after tool calls salvages its text to the narration channel only", async () => {
  const partials: string[] = [];
  const narrations: string[] = [];
  const local = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(delta("Narration before the call.") + "\n\n");
    res.write(toolDelta("call-d1", "sam_workspace_list", "{}") + "\n\n");
    setTimeout(() => { res.socket?.destroy(); }, 60);
  });
  local.listen(0, "127.0.0.1");
  await once(local, "listening");
  try {
    const port = (local.address() as { port: number }).port;
    const provider = new OpenAICompatibleProvider("http://127.0.0.1:" + port + "/v1/chat/completions", "");
    provider.onPartial = t => { partials.push(t); };
    provider.onNarration = t => { narrations.push(t); };
    await assert.rejects(provider.completeConnectorTurn("mock", [{ role: "user", content: "list the workspace" }], []));
    assert.deepEqual(partials, [], "a dead tool round's text never reaches the answer channel, even as salvage");
    assert.deepEqual(narrations, ["Narration before the call."], "the remains rode the narration channel, counted and dropped upstream");
  } finally { local.close(); await once(local, "close"); }
});

test("reasoning channel: an unterminated think completion is refused, never shown", async () => {
  let hits = 0;
  const local = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "<think>reasoning that never closes and must not leak" } }] }));
  });
  local.listen(0, "127.0.0.1");
  await once(local, "listening");
  try {
    const port = (local.address() as { port: number }).port;
    const provider = new OpenAICompatibleProvider("http://127.0.0.1:" + port + "/v1/chat/completions", "");
    const partials: string[] = [];
    provider.onPartial = t => { partials.push(t); };
    await assert.rejects(provider.completeConnectorTurn("mock", [{ role: "user", content: "hi" }], []), /Unsafe model output/);
    assert.equal(hits, 3, "the existing retry class absorbed it, three attempts");
    assert.deepEqual(partials, [], "nothing reached the answer channel");
  } finally { local.close(); await once(local, "close"); }
});
