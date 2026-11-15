import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import { chatThreadSignature, sseThreadEvent } from "./dashboard-live.js";

// Sprint 4 item 1. The open chat used to learn about a reply by
// polling, and the poll stopped when the turn looked idle. These
// tests pin the replacement: one Server-Sent Events stream pushes
// the thread when it changes. A stub model on loopback stands in
// for the provider so nothing leaves the machine. The test client
// never GETs the thread again after it opens the stream.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANSWER = "Live answer without a refresh.";
const STEERED_ANSWER = "Steered live: the short version mentions the kelp.";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

test("thread signature changes when content, queue status, or the running turn changes", () => {
  const base = {
    messages: [{ id: "m1", role: "assistant", partial: 1, reaction: null, content: "partial" }],
    queue: [{ id: "q1", status: "queued", content: "hold on" }],
    turnActive: true,
    events: [],
    actions: [],
    artifacts: [],
    citations: {},
    sources: {},
  };
  const same = chatThreadSignature(base);
  assert.equal(chatThreadSignature(JSON.parse(JSON.stringify(base))), same);
  assert.notEqual(chatThreadSignature({ ...base, messages: [{ id: "m1", role: "assistant", partial: 0, reaction: null, content: ANSWER }] }), same, "a finished reply on the same message id is a change");
  assert.notEqual(chatThreadSignature({ ...base, queue: [{ id: "q1", status: "steered", content: "hold on" }] }), same, "queued becoming steered is a change");
  assert.notEqual(chatThreadSignature({ ...base, turnActive: false }), same, "the turn ending is a change");
  const wire = sseThreadEvent({ messages: [{ content: "line\nbreak" }] });
  assert.match(wire, /^data: .+\n\n$/);
  assert.equal(wire.split("\n").filter(line => line.startsWith("data: ")).length, 1, "a newline inside a message stays inside one data line");
  assert.equal(JSON.parse(wire.slice(6)).messages[0].content, "line\nbreak");
});

type Msg = { role: string; content?: string | null };
function delta(content: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: { content } }] });
}
function toolDelta(id: string, name: string, args: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] } }] });
}
function finish(reason: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } });
}
const DONE = "data: [DONE]";
function sse(res: ServerResponse, events: string[]) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(events.join("\n\n") + "\n\n");
}
function jsonReply(res: ServerResponse, text: string) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }));
}

let releaseHold: () => void = () => {};
let hold = Promise.resolve();
function armHold() {
  hold = new Promise<void>(resolve => { releaseHold = resolve; });
}

async function handleModel(body: { messages?: Msg[]; stream?: boolean }, res: ServerResponse) {
  const messages = body.messages ?? [];
  const userText = messages.filter(m => m.role === "user").map(m => String(m.content ?? "")).join("\n");
  const hasToolResult = messages.some(m => m.role === "tool");
  if (!body.stream) {
    jsonReply(res, "Tide today");
    return;
  }
  if (userText.includes("HOLD-LIVE")) {
    if (!hasToolResult) {
      await sleep(3500);
      sse(res, [toolDelta("call-hold", "sam_workspace_list", "{}"), finish("tool_calls"), DONE]);
      return;
    }
    await hold;
    sse(res, [delta(userText.includes("steer me") ? STEERED_ANSWER : "Hold finished without a steer."), finish("stop"), DONE]);
    return;
  }
  if (userText.includes("QUICK-LIVE")) {
    await sleep(800);
    sse(res, [delta(ANSWER), finish("stop"), DONE]);
    return;
  }
  sse(res, [delta("Stub model: unscripted turn."), finish("stop"), DONE]);
}

let model: Server;
let endpoint = "";
let dash: ChildProcess | null = null;
let dashPort = 0;
let dashUrl = "";
let token = "";
let workspace = "";

function killDash() {
  if (dash && dash.exitCode === null && dash.signalCode === null) dash.kill("SIGTERM");
}

test.before(async () => {
  armHold();
  model = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let body: { messages?: Msg[]; stream?: boolean } = {};
      try { body = JSON.parse(raw || "{}") as { messages?: Msg[]; stream?: boolean }; } catch { body = {}; }
      void handleModel(body, res);
    });
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const addr = model.address();
  if (!addr || typeof addr === "string") throw new Error("model port missing");
  endpoint = "http://127.0.0.1:" + addr.port + "/v1/chat/completions";
  workspace = mkdtempSync(join(tmpdir(), "sam-live-chat-"));
  dashPort = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, SAM_MODEL_ENDPOINT: endpoint, SAM_MODEL: "stub-model", SAM_MODEL_API_KEY: "local-test-key" };
  delete env.SAM_MODEL_PROVIDER;
  delete env.MINIMAX_API_KEY;
  dash = spawn(process.execPath, [join(repoRoot, "dist", "cli.js"), "--workspace", workspace, "dashboard", "--port", String(dashPort)], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  dash.stdout?.on("data", (chunk) => { log += chunk.toString(); });
  dash.stderr?.on("data", (chunk) => { log += chunk.toString(); });
  dashUrl = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error("dashboard did not print its URL\n" + log)), 15000);
    const watch = () => {
      const match = log.match(/SAM dashboard: (http:\/\/127\.0\.0\.1:\d+\/dashboard\/[0-9a-f]{32})/);
      if (match) { clearTimeout(timer); resolveUrl(match[1]); }
    };
    dash!.stdout?.on("data", watch);
    dash!.on("exit", (code) => { clearTimeout(timer); reject(new Error("dashboard exited " + code + "\n" + log)); });
    watch();
  });
  token = dashUrl.split("/").pop() ?? "";
});

test.after(async () => {
  releaseHold();
  killDash();
  await sleep(200);
  if (dash && dash.exitCode === null) dash.kill("SIGKILL");
  await new Promise<void>(resolve => model.close(() => resolve()));
  rmSync(workspace, { recursive: true, force: true });
});

interface LiveEvent {
  messages?: Array<{ id?: string; role?: string; content?: string; partial?: number }>;
  queue?: Array<{ id?: string; status?: string; content?: string }>;
  turnActive?: boolean;
}

function openLive(chatId: string): { events: LiveEvent[]; gets: number; stop: () => void } {
  const events: LiveEvent[] = [];
  let buf = "";
  const req = http.get(`http://127.0.0.1:${dashPort}/api/${token}/chats/${chatId}/live`, (res) => {
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buf += chunk;
      let cut = buf.indexOf("\n\n");
      while (cut >= 0) {
        const raw = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = raw.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
        if (data) events.push(JSON.parse(data) as LiveEvent);
        cut = buf.indexOf("\n\n");
      }
    });
  });
  req.on("error", () => { /* closed on purpose */ });
  return { events, gets: 0, stop: () => req.destroy() };
}

async function waitFor(label: string, pred: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for " + label);
    await sleep(40);
  }
}

async function postMessage(chatId: string, content: string) {
  const res = await fetch(`http://127.0.0.1:${dashPort}/api/${token}/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SAM-Request": "dashboard" },
    body: JSON.stringify({ content, source: "dashboard" }),
  });
  const body = await res.json() as { status?: string; error?: string };
  assert.equal(res.status, 202, body.error ?? "message was not accepted onto the queue");
  return body;
}

async function createChat(title: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${dashPort}/api/${token}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SAM-Request": "dashboard" },
    body: JSON.stringify({ title }),
  });
  assert.equal(res.status, 201);
  const body = await res.json() as { id: string };
  return body.id;
}

function hasAnswer(events: LiveEvent[], text: string): boolean {
  return events.some(event => event.turnActive === false && (event.messages ?? []).some(m => m.role === "assistant" && String(m.content ?? "").includes(text) && m.partial !== 1));
}
function hasQueue(events: LiveEvent[], content: string, status: string): boolean {
  return events.some(event => (event.queue ?? []).some(q => q.status === status && String(q.content ?? "").includes(content)));
}

test("open stream receives the reply, then queued and steered, with no further thread GET", { timeout: 30000 }, async () => {
  const quickId = await createChat("Quick");
  const quick = openLive(quickId);
  try {
    await waitFor("the stream's opening snapshot", () => quick.events.length >= 1);
    assert.equal(quick.gets, 0);
    const before = quick.events.length;
    await postMessage(quickId, "QUICK-LIVE what is the tide");
    await waitFor("the assistant reply on the stream", () => hasAnswer(quick.events, ANSWER));
    const arrival = quick.events.findIndex(event => event.turnActive === false && (event.messages ?? []).some(m => String(m.content ?? "").includes(ANSWER)));
    assert.ok(arrival > before - 1, "the answer is a later event, not the snapshot that was already open");
    assert.ok(quick.events.slice(0, arrival).some(event => event.turnActive === true), "the running turn was visible on the stream before the reply");
    assert.equal(quick.gets, 0, "the reply arrived on the stream; the client did not GET the thread again");
  } finally { quick.stop(); }

  const heldId = await createChat("Held");
  const held = openLive(heldId);
  try {
    await waitFor("the held chat's opening snapshot", () => held.events.length >= 1);
    await postMessage(heldId, "HOLD-LIVE check the coast");
    await waitFor("the held turn to show as running", () => held.events.some(event => event.turnActive === true));
    await postMessage(heldId, "please steer me toward the kelp");
    await waitFor("the follow-up to show as queued", () => hasQueue(held.events, "steer me", "queued"), 4000);
    await waitFor("the follow-up to show as steered", () => hasQueue(held.events, "steer me", "steered"), 12000);
    const queuedAt = held.events.findIndex(event => (event.queue ?? []).some(q => q.status === "queued" && String(q.content ?? "").includes("steer me")));
    const steeredAt = held.events.findIndex(event => (event.queue ?? []).some(q => q.status === "steered" && String(q.content ?? "").includes("steer me")));
    assert.ok(queuedAt >= 0 && steeredAt > queuedAt, "steered is a later event than queued");
    releaseHold();
    await waitFor("the steered turn's answer", () => hasAnswer(held.events, STEERED_ANSWER), 8000);
    assert.equal(held.gets, 0, "queued, steered, and the answer all arrived on the stream");
  } finally { held.stop(); releaseHold(); }
});

test("an unknown chat does not open a stream", async () => {
  const missing = "00000000-0000-4000-8000-000000000000";
  const status = await new Promise<number>((resolveStatus, reject) => {
    const req = http.get(`http://127.0.0.1:${dashPort}/api/${token}/chats/${missing}/live`, (res: IncomingMessage) => {
      res.resume();
      resolveStatus(res.statusCode ?? 0);
    });
    req.setTimeout(4000, () => req.destroy(new Error("live 404 hung")));
    req.on("error", reject);
  });
  assert.equal(status, 404);
});
