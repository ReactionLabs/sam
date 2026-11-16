import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serveMemberDoor } from "./member-door.js";
import { findOrCreateMember, mintMagicToken } from "./members.js";
import { awaitChatQueue } from "./chat-queue.js";

// The member door, end to end: a stub model stands in for the
// member's own key. The stub records the Authorization header of
// every call, so the test proves the member's SAM thought with the
// MEMBER's vaulted key while a house key sat in the environment.

const MEMBER_KEY = "sk-door-test-member-key";
const HOUSE_KEY = "house-key-must-never-reach-a-member-turn";
const seenAuth: string[] = [];

let stub: Server;
let stubEndpoint = "";
let root = "";
let door: { port: number; close: () => Promise<void> } | null = null;
let base = "";
const savedEnv: Record<string, string | undefined> = {};

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
async function signIn(email: string): Promise<{ token: string; member: Record<string, unknown> }> {
  const { member } = findOrCreateMember(root, email);
  const raw = mintMagicToken(root, member);
  const redeemed = await api("/auth/redeem", { method: "POST", body: { token: raw } });
  assert.equal(redeemed.status, 200);
  return { token: String(redeemed.json.sessionToken), member: redeemed.json.member as Record<string, unknown> };
}

test.before(async () => {
  for (const k of ["SAM_MODEL_API_KEY", "SAM_MEMBER_DOOR_OFF", "SAM_MEMBER_APP_URL", "RESEND_API_KEY"]) savedEnv[k] = process.env[k];
  process.env.SAM_MODEL_API_KEY = HOUSE_KEY;
  delete process.env.SAM_MEMBER_DOOR_OFF;
  delete process.env.SAM_MEMBER_APP_URL;
  delete process.env.RESEND_API_KEY;
  root = mkdtempSync(join(tmpdir(), "sam-member-door-"));
  process.env.SAM_VAULT_DIR = join(root, "vault");
  stub = createServer((req, res) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => {
      seenAuth.push(String(req.headers.authorization ?? ""));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Hello from your own SAM." } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  stubEndpoint = "http://127.0.0.1:" + (stub.address() as { port: number }).port + "/v1/chat/completions";
  door = await serveMemberDoor(root, { port: 0 + 19321 });
  base = "http://127.0.0.1:" + door.port;
});

test.after(async () => {
  if (door) await door.close();
  stub.close();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});

test("health answers without a credential; everything else demands one", async () => {
  const health = await api("/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  const me = await api("/me");
  assert.equal(me.status, 401);
  const panels = await api("/panels", { token: "sam_" + "0".repeat(48) });
  assert.equal(panels.status, 401);
});

test("request-link never enumerates and reports honestly without a mailer", async () => {
  const good = await api("/auth/request-link", { method: "POST", body: { email: "door-a@example.com" } });
  assert.equal(good.status, 200);
  assert.equal(good.json.ok, true);
  // No mailer is configured in this test process, so the door says
  // the mail did not go out instead of pretending.
  assert.equal(good.json.mailDelivered, false);
  const bad = await api("/auth/request-link", { method: "POST", body: { email: "not-an-email" } });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.ok, true);
});

test("a member chats with their own SAM on their own key; a second member sees none of it", async () => {
  const a = await signIn("door-a@example.com");
  const b = await signIn("door-b@example.com");
  assert.notEqual(a.member.profile, b.member.profile);

  // Before the key: /me says plainly the SAM cannot think yet.
  assert.equal(a.member.hasKey, false);

  // A adds their own key (a custom endpoint: the stub).
  const keyed = await api("/me/key", { method: "POST", token: a.token, body: { apiKey: MEMBER_KEY, kind: "custom", endpoint: stubEndpoint, model: "stub-1" } });
  assert.equal(keyed.status, 200);
  assert.equal((keyed.json.member as Record<string, unknown>).hasKey, true);
  // The key value is in no response.
  assert.equal(JSON.stringify(keyed.json).includes(MEMBER_KEY), false);

  // A opens a chat and talks.
  const chatsA = await api("/chats", { token: a.token });
  const listA = chatsA.json.chats as Array<{ id: string; title: string }>;
  assert.equal(listA.length, 1);
  const chatId = listA[0].id;
  const sent = await api("/chats/" + chatId + "/messages", { method: "POST", token: a.token, body: { content: "Say hello" } });
  assert.equal(sent.status, 202);
  await awaitChatQueue(root, chatId);
  const thread = await api("/chats/" + chatId, { token: a.token });
  const messages = (thread.json.messages as Array<{ role: string; content: string }>).filter(m => !String(m.content).startsWith("queue:"));
  assert.ok(messages.some(m => m.role === "assistant" && m.content.includes("Hello from your own SAM.")), JSON.stringify(messages));

  // The model call carried the MEMBER's key, never the house key.
  assert.ok(seenAuth.length >= 1);
  assert.ok(seenAuth.every(h => h === "Bearer " + MEMBER_KEY), seenAuth.join(","));
  assert.ok(!seenAuth.some(h => h.includes(HOUSE_KEY)));

  // Isolation: B gets 404 for A's chat, and B's world is empty.
  const stolen = await api("/chats/" + chatId, { token: b.token });
  assert.equal(stolen.status, 404);
  const postStolen = await api("/chats/" + chatId + "/messages", { method: "POST", token: b.token, body: { content: "intrude" } });
  assert.equal(postStolen.status, 404);
  const panelsB = await api("/panels", { token: b.token });
  const chatsB = panelsB.json.chats as Array<{ id: string }>;
  assert.ok(chatsB.every(c => c.id !== chatId));
  // B's intel is B's alone: their own sign-in line, never A's
  // vault use or key events.
  const intelB = panelsB.json.intel as Array<{ kind: string }>;
  assert.ok(intelB.every(l => l.kind !== "vault-use" && l.kind !== "member-key-set"), JSON.stringify(intelB));

  // A's panels carry A's own real data.
  const panelsA = await api("/panels", { token: a.token });
  assert.ok((panelsA.json.intel as Array<{ kind: string }>).some(l => l.kind === "vault-use"));
});

test("an account with no key gets a plain cannot-think answer, not an error wall", async () => {
  const b = await signIn("door-b@example.com");
  const chatsB = await api("/chats", { token: b.token });
  const chatId = (chatsB.json.chats as Array<{ id: string }>)[0].id;
  const sent = await api("/chats/" + chatId + "/messages", { method: "POST", token: b.token, body: { content: "Hello?" } });
  // The door answers directly: SAM's reply IS the plain reason.
  assert.equal(sent.status, 200);
  assert.equal(sent.json.status, "answered");
  assert.match(String(sent.json.reply), /add your key/i);
  await awaitChatQueue(root, chatId);
  const thread = await api("/chats/" + chatId, { token: b.token });
  assert.match(JSON.stringify(thread.json), /add your key/i);
});

test("API tokens open the same door with the same scope", async () => {
  const a = await signIn("door-a@example.com");
  const minted = await api("/me/api-tokens", { method: "POST", token: a.token, body: { name: "test script" } });
  assert.equal(minted.status, 201);
  const raw = String(minted.json.token);
  assert.match(raw, /^sam_[0-9a-f]{48}$/);
  const me = await api("/me", { token: raw });
  assert.equal(me.status, 200);
  assert.equal((me.json.member as Record<string, unknown>).profile, a.member.profile);
  // Listed without the value; revoked means revoked.
  const listed = await api("/me/api-tokens", { token: a.token });
  assert.equal(JSON.stringify(listed.json).includes(raw), false);
  const id = (listed.json.tokens as Array<{ id: string }>)[0].id;
  const revoked = await api("/me/api-tokens/" + id, { method: "DELETE", token: a.token });
  assert.equal(revoked.status, 200);
  const after = await api("/me", { token: raw });
  assert.equal(after.status, 401);
  // The developer payload names only real doors.
  const dev = await api("/developer", { token: a.token });
  assert.equal(dev.status, 200);
  assert.match(String((dev.json.cli as Record<string, unknown>).install), /github\.com\/ReactionLabs\/sam/);
});

test("the kill switch pauses the door while health keeps answering", async () => {
  const a = await signIn("door-a@example.com");
  process.env.SAM_MEMBER_DOOR_OFF = "1";
  try {
    const paused = await api("/me", { token: a.token });
    assert.equal(paused.status, 503);
    const health = await api("/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.paused, true);
  } finally {
    delete process.env.SAM_MEMBER_DOOR_OFF;
  }
  const back = await api("/me", { token: a.token });
  assert.equal(back.status, 200);
});

test("sign-out ends the session", async () => {
  const a = await signIn("door-a@example.com");
  const out = await api("/auth/sign-out", { method: "POST", token: a.token });
  assert.equal(out.status, 200);
  const me = await api("/me", { token: a.token });
  assert.equal(me.status, 401);
});
