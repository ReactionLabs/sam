import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { readActivity } from "./activity.js";
import { awaitChatQueue, enqueueChatMessage } from "./chat-queue.js";
import { REASONING_BLOCKED_REPLY, isReasoningNarration, reasoningNarrationSignals } from "./reply-guard.js";

// Reasoning-leak guard (Dip catch, 2026-11-14): untagged prose
// reasoning must never persist or render as the assistant reply.
// Pinned on BOTH recorded incidents plus the answers that must
// survive, then proven through the real queue/turn path with a
// stubbed model that narrates.

const INCIDENT_TEST_CHAT = "No orchestration file in code root? Let's search for orchestrate tool implementation.";
const INCIDENT_PDF = "The owner wants a PDF made from something in my artifacts. I need to find the right artifact first. Let me load sam_artifact and sam_manage_chats so I can list what is there and pull the content. Also the question";

test("detector: both recorded incidents are reasoning narration", () => {
  assert.equal(isReasoningNarration(INCIDENT_TEST_CHAT), true, reasoningNarrationSignals(INCIDENT_TEST_CHAT).map(s => s.name).join(","));
  assert.equal(isReasoningNarration(INCIDENT_PDF), true, reasoningNarrationSignals(INCIDENT_PDF).map(s => s.name).join(","));
});

test("detector: ordinary answers survive, including ones that mention tools or report work", () => {
  const survivors = [
    "Your brief is ready. I made it an artifact, Zorblax Field Kit Brief, now at v2, and it is in your Artifacts library.",
    "I checked the numbers: three workers ran and all of them finished. The branch is main and the tree is clean.",
    "Let me know if you want the shorter version.",
    "Done. The PDF is built from your artifact and saved as version 3.",
    "Here is what I found in your artifacts: two briefs and a one-pager. The newest is the field kit brief from this morning.",
    "I will hold the send until you approve it, per your rule.",
    // A long, substantive answer that opens with one process
    // phrase but answers in full: dilution keeps it alive.
    "I pulled the records together for the quarter and here is the picture. Revenue held steady across all three months, with the middle month carrying the bulk of it. Two clients account for most of the volume, and both renewed without a discount conversation. The one soft spot is the smallest account, which has gone quiet since the summer; nothing in the record says it churned, only that it stopped ordering. Costs stayed inside the band you set, and the only surprise was a single shipping charge that nobody had forecast. My read: the quarter is healthy, the quiet account is worth one direct check-in, and nothing here needs a decision from you today.",
  ];
  for (const s of survivors) assert.equal(isReasoningNarration(s), false, s.slice(0, 60) + " :: " + reasoningNarrationSignals(s).map(x => x.name).join(","));
});

test("detector: a bare process fragment as the whole reply is narration", () => {
  assert.equal(isReasoningNarration("Let me check the file"), true);
  assert.equal(isReasoningNarration("Let me load sam_memory_list and see"), true);
  assert.equal(isReasoningNarration(""), false);
  assert.equal(isReasoningNarration("Yes."), false);
});

// --- through the turn path -------------------------------------

type Msg = { role: string; content?: string | null };
function reply(res: import("node:http").ServerResponse, message: Record<string, unknown>) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...message } }] }));
}
function lastUser(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return String(messages[i].content ?? "");
  return "";
}
function handleModel(body: { messages: Msg[] }, res: import("node:http").ServerResponse) {
  const user = lastUser(body.messages);
  const steered = body.messages.some(m => m.role === "system" && String(m.content ?? "").includes("narrated your own process"));
  if (user.includes("narrate then answer")) {
    if (!steered) return reply(res, { content: INCIDENT_TEST_CHAT, tool_calls: undefined });
    return reply(res, { content: "The orchestration code lives in src/orchestration.ts, with the lane runtime in the same file.", tool_calls: undefined });
  }
  if (user.includes("narrate forever")) {
    return reply(res, { content: INCIDENT_PDF, tool_calls: undefined });
  }
  return reply(res, { content: "Plain answer.", tool_calls: undefined });
}

let server: Server;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["SAM_MODEL_ENDPOINT", "SAM_MODEL_API_KEY", "SAM_MODEL", "SAM_MODEL_PROVIDER"];
test.before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  server = createServer((req, res) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => { handleModel(JSON.parse(data || "{}"), res); });
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

function scratchRoot(): string { return mkdtempSync(join(tmpdir(), "sam-guard-")); }
function newChat(root: string, title: string): string {
  const store = new ChatStore(root);
  try { return store.create(title, null).id; } finally { store.close(); }
}
function messages(root: string, chatId: string) {
  const store = new ChatStore(root);
  try { return store.messages(chatId); } finally { store.close(); }
}

test("turn path: a narrating completion is withheld, the turn steers, the real answer lands", async () => {
  const root = scratchRoot();
  try {
    const chatId = newChat(root, "Narrate then answer");
    enqueueChatMessage(root, { chatId, content: "narrate then answer: where does the orchestration code live?", source: "dashboard" });
    await awaitChatQueue(root, chatId, 20000);
    const assistants = messages(root, chatId).filter(m => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.match(assistants[0].content, /src\/orchestration\.ts/);
    assert.ok(!assistants.some(m => m.content.includes("No orchestration file")), "the monologue never persisted");
    assert.ok(readActivity(root, 30, { kind: "reasoning-leak-blocked" }).length >= 1, "the block is ledgered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("turn path: a model that only narrates gets the honest blocked line, never its monologue", async () => {
  const root = scratchRoot();
  try {
    const chatId = newChat(root, "Narrate forever");
    enqueueChatMessage(root, { chatId, content: "narrate forever: can you make a PDF of something in your artifacts?", source: "dashboard" });
    await awaitChatQueue(root, chatId, 20000);
    const assistants = messages(root, chatId).filter(m => m.role === "assistant");
    assert.deepEqual(assistants.map(m => m.content), [REASONING_BLOCKED_REPLY]);
    assert.ok(!assistants.some(m => m.content.includes("sam_artifact")), "no tool-name monologue reached the transcript");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
