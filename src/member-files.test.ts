import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serveMemberDoor } from "./member-door.js";
import { findOrCreateMember, mintMagicToken } from "./members.js";
import { awaitChatQueue } from "./chat-queue.js";
import { resetReachCache } from "./reach.js";

// Member files, end to end (maturity pass, 2026-11-16): a member's
// SAM already holds the artifact tool and web research in its
// fenced hand; this test proves the whole loop through the door -
// a scripted stub model (standing in for the member's own key)
// makes an artifact in chat, revises it, and runs a research call
// against a stub agent-reach binary - and that the door's new
// artifact and files reads serve exactly the member's own world:
// list, read, versions, the unified files listing, and a second
// member seeing none of it.

const MEMBER_KEY = "member-files-key";

let stub: Server;
let stubEndpoint = "";
let root = "";
let door: { port: number; close: () => Promise<void> } | null = null;
let base = "";
const savedEnv: Record<string, string | undefined> = {};

interface Msg { role?: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }

function completion(message: Record<string, unknown>): string {
  return JSON.stringify({
    choices: [{ message: { role: "assistant", ...message } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}
function toolCall(name: string, args: Record<string, unknown>): string {
  return completion({ content: null, tool_calls: [{ id: "call-" + Math.random().toString(36).slice(2), type: "function", function: { name, arguments: JSON.stringify(args) } }] });
}

// The scripted model: it reads the turn so far (everything after
// the last user message) and plays the next step of the job the
// ask names - load the tool if it is not on the table yet, call
// it, then answer once its result is in.
function stubReply(body: { messages?: Msg[]; tools?: Array<{ function?: { name?: string } }> }): string {
  const messages = body.messages ?? [];
  const toolNames = (body.tools ?? []).map(t => t.function?.name ?? "");
  const lastUserAt = messages.map(m => m.role).lastIndexOf("user");
  const ask = typeof messages[lastUserAt]?.content === "string" ? String(messages[lastUserAt].content) : "";
  const turn = messages.slice(lastUserAt + 1);
  const results = turn.filter(m => m.role === "tool").map(m => String(m.content ?? ""));
  const has = (frag: string) => results.some(r => r.includes(frag));
  const loadOr = (tool: string, call: () => string) => toolNames.includes(tool) ? call() : toolCall("sam_load_tools", { names: [tool] });

  if (/revise/i.test(ask)) {
    if (has("\"updated\"")) return completion({ content: "Revised. The Harbor Brief is now version 2, with the ferry line added." });
    if (has("\"artifacts\"")) {
      let id = "";
      for (const r of results) { try { const parsed = JSON.parse(r) as { artifacts?: Array<{ id: string }> }; if (parsed.artifacts?.[0]) { id = parsed.artifacts[0].id; break; } } catch { /* keep looking */ } }
      if (id) return toolCall("sam_artifact", { action: "update", id, content: "# Harbor Brief\n\nThe harbor at a glance: berths, tides, and the morning ferry.\n" });
    }
    return loadOr("sam_artifact", () => toolCall("sam_artifact", { action: "list" }));
  }
  if (/research/i.test(ask)) {
    if (has("\"ok\":true") || has("\"ok\": true")) return completion({ content: "Here is what I found: the big story leads the wire this morning [1]." });
    return loadOr("sam_reach", () => toolCall("sam_reach", { channel: "web", action: "search", query: "tampa harbor news", limit: 3 }));
  }
  if (/artifact/i.test(ask)) {
    if (has("\"created\"")) return completion({ content: "Made your Harbor Brief. It is saved as an artifact, version 1." });
    return loadOr("sam_artifact", () => toolCall("sam_artifact", { action: "create", title: "Harbor Brief", kind: "markdown", content: "# Harbor Brief\n\nThe harbor at a glance: berths, tides, and the working waterfront.\n" }));
  }
  return completion({ content: "Hello from your own SAM." });
}

function reachStubBin(dir: string): string {
  const path = join(dir, "agent-reach-stub.js");
  writeFileSync(path, `
const a = process.argv.slice(2);
if (a[0] === "channels") {
  console.log(JSON.stringify({ channels: [{ id: "web", actions: ["search", "read"] }] }));
} else if (a[0] === "web" && a[1] === "search") {
  console.log(JSON.stringify({ ok: true, items: [{ title: "Big story", url: "https://example.com/a", author: "Wire", published_at: "2026-11-16", text: "Something happened at the harbor." }] }));
} else {
  console.log(JSON.stringify({ ok: false, error: { code: "BAD_INPUT", message: "unhandled" } }));
}
`);
  return path;
}

async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: "Bearer " + opts.token } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
async function signIn(email: string): Promise<{ token: string; profile: string }> {
  const { member } = findOrCreateMember(root, email);
  const raw = mintMagicToken(root, member);
  const redeemed = await api("/auth/redeem", { method: "POST", body: { token: raw } });
  assert.equal(redeemed.status, 200);
  const view = redeemed.json.member as { profile: string };
  return { token: String(redeemed.json.sessionToken), profile: view.profile };
}
async function say(token: string, chatId: string, content: string): Promise<string> {
  const posted = await api("/chats/" + chatId + "/messages", { method: "POST", token, body: { content } });
  assert.ok(posted.status === 200 || posted.status === 202, "message accepted, got " + posted.status);
  await awaitChatQueue(root, chatId);
  const thread = await api("/chats/" + chatId, { token });
  assert.equal(thread.status, 200);
  const messages = (thread.json.messages ?? []) as Array<{ role: string; content: string }>;
  const last = [...messages].reverse().find(m => m.role === "assistant");
  return last?.content ?? "";
}

test.before(async () => {
  for (const k of ["SAM_MODEL_API_KEY", "SAM_MEMBER_DOOR_OFF", "SAM_MEMBER_APP_URL", "RESEND_API_KEY", "SAM_AGENT_REACH_BIN"]) savedEnv[k] = process.env[k];
  process.env.SAM_MODEL_API_KEY = "house-key-must-never-reach-a-member-turn";
  delete process.env.SAM_MEMBER_DOOR_OFF;
  delete process.env.SAM_MEMBER_APP_URL;
  delete process.env.RESEND_API_KEY;
  root = mkdtempSync(join(tmpdir(), "sam-member-files-"));
  process.env.SAM_VAULT_DIR = join(root, "vault");
  process.env.SAM_AGENT_REACH_BIN = reachStubBin(root);
  resetReachCache();
  stub = createServer((req, res) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => {
      let reply: string;
      try { reply = stubReply(JSON.parse(data) as { messages?: Msg[]; tools?: Array<{ function?: { name?: string } }> }); }
      catch { reply = completion({ content: "Hello from your own SAM." }); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(reply);
    });
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  stubEndpoint = "http://127.0.0.1:" + (stub.address() as { port: number }).port + "/v1/chat/completions";
  door = await serveMemberDoor(root, { port: 19341 });
  base = "http://127.0.0.1:" + door.port;
});

test.after(async () => {
  if (door) await door.close();
  stub.close();
  resetReachCache();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});

test("the new reads demand a credential", async () => {
  assert.equal((await api("/me/artifacts")).status, 401);
  assert.equal((await api("/me/files")).status, 401);
  assert.equal((await api("/me/artifacts/whatever")).status, 401);
});

test("a member makes and revises an artifact in chat, then reads it back through the door", async () => {
  const a = await signIn("files-a@example.com");
  const keyed = await api("/me/key", { method: "POST", token: a.token, body: { apiKey: MEMBER_KEY, kind: "custom", endpoint: stubEndpoint, model: "stub-1" } });
  assert.equal(keyed.status, 200);
  const created = await api("/chats", { method: "POST", token: a.token, body: { title: "Harbor work" } });
  assert.equal(created.status, 201);
  const chatId = String((created.json.chat as { id: string }).id);

  const reply = await say(a.token, chatId, "Make me an artifact: a one-page brief about the harbor.");
  assert.match(reply, /Harbor Brief/);

  const list = await api("/me/artifacts", { token: a.token });
  assert.equal(list.status, 200);
  const artifacts = list.json.artifacts as Array<Record<string, unknown>>;
  assert.equal(artifacts.length, 1);
  const head = artifacts[0];
  assert.equal(head.title, "Harbor Brief");
  assert.equal(head.kind, "markdown");
  assert.equal(head.version, 1);
  assert.ok(Number(head.sizeBytes) > 0, "the listing carries a real size");
  assert.equal(head.chatId, chatId, "the artifact names the chat that made it");
  assert.equal(head.chatTitle, "Harbor work");

  const read = await api("/me/artifacts/" + head.id, { token: a.token });
  assert.equal(read.status, 200);
  const artifact = read.json.artifact as { content: string; versions: Array<{ version: number }> };
  assert.match(artifact.content, /working waterfront/);
  assert.equal(artifact.versions.length, 1);

  const revised = await say(a.token, chatId, "Please revise the Harbor Brief: add a line about the ferry.");
  assert.match(revised, /version 2/);
  const reread = await api("/me/artifacts/" + head.id, { token: a.token });
  const now = reread.json.artifact as { version: number; content: string; versions: Array<{ version: number }> };
  assert.equal(now.version, 2);
  assert.match(now.content, /ferry/);
  assert.equal(now.versions.length, 2);

  const v1 = await api("/me/artifacts/" + head.id + "/versions/1", { token: a.token });
  assert.equal(v1.status, 200);
  const first = v1.json.artifact as { version: number; content: string };
  assert.equal(first.version, 1);
  assert.doesNotMatch(first.content, /ferry/);
  assert.equal((await api("/me/artifacts/" + head.id + "/versions/9", { token: a.token })).status, 404);
});

test("a member's research ask runs the reach call and the answer carries its source", async () => {
  const a = await signIn("files-a@example.com");
  const created = await api("/chats", { method: "POST", token: a.token, body: { title: "News check" } });
  const chatId = String((created.json.chat as { id: string }).id);
  const reply = await say(a.token, chatId, "Research the latest Tampa harbor news for me.");
  assert.match(reply, /\[1\]/, "the answer cites the source its tool result registered");
  assert.match(reply, /Sources:/, "and lists it, the research-answer shape");
  assert.match(reply, /agent-reach web search/, "the source names the research that ran");
});

test("the files listing is one organized home: artifacts plus the standing files", async () => {
  const a = await signIn("files-a@example.com");
  const files = await api("/me/files", { token: a.token });
  assert.equal(files.status, 200);
  const entries = files.json.files as Array<Record<string, unknown>>;
  const artifact = entries.find(e => e.group === "artifact");
  assert.ok(artifact, "the artifact SAM made is in the files home");
  assert.equal(artifact?.title, "Harbor Brief");
  assert.equal(artifact?.chatTitle, "Harbor work");
  assert.equal(artifact?.href, "/app/artifacts/" + String(artifact?.key).slice("artifact:".length));
  const soul = entries.find(e => e.key === "standing:soul");
  const agents = entries.find(e => e.key === "standing:agents");
  assert.ok(soul && agents, "both standing files are listed");
  assert.equal(soul?.seeded, true, "an unsaved soul reads as the starter it is");
  const saved = await api("/me/files/soul", { method: "PUT", token: a.token, body: { content: "# Who my SAM is\n\nPlain words, warm, brief.\n" } });
  assert.equal(saved.status, 200);
  const after = await api("/me/files", { token: a.token });
  const soulNow = (after.json.files as Array<Record<string, unknown>>).find(e => e.key === "standing:soul");
  assert.equal(soulNow?.present, true);
  assert.equal(soulNow?.seeded, false);
  assert.ok(Number(soulNow?.sizeBytes) > 0);
  assert.ok(String(soulNow?.updatedAt ?? "").length > 0, "a saved file carries its time");
});

test("a second member sees none of it", async () => {
  const a = await signIn("files-a@example.com");
  const listA = await api("/me/artifacts", { token: a.token });
  const id = String((listA.json.artifacts as Array<{ id: string }>)[0].id);
  const b = await signIn("files-b@example.com");
  const listB = await api("/me/artifacts", { token: b.token });
  assert.deepEqual(listB.json.artifacts, []);
  assert.equal((await api("/me/artifacts/" + id, { token: b.token })).status, 404);
  assert.equal((await api("/me/artifacts/" + id + "/versions/1", { token: b.token })).status, 404);
  const filesB = await api("/me/files", { token: b.token });
  const entriesB = filesB.json.files as Array<Record<string, unknown>>;
  assert.equal(entriesB.filter(e => e.group === "artifact").length, 0, "no artifact crosses into the other member's files");
  assert.ok(entriesB.every(e => e.group === "standing"), "only their own standing files remain");
});
