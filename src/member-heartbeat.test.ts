import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readActivity } from "./activity.js";
import { runChatTurn } from "./agent-turn.js";
import { ChatStore } from "./chats.js";
import { addHeartbeatJob, runHeartbeat } from "./heartbeat.js";
import { findOrCreateMember, setMemberKey } from "./members.js";

// Member heartbeat EXECUTION, proven end to end on the exact path
// the box tick runs: the CLI's `sam heartbeat` deps (runChatTurn on
// the heartbeat route + the same ensureChat shape) over a member
// home. Member A thinks on their own vaulted key against a stub
// provider; the stub records every Authorization header, so the
// test proves A's job ran on A's key while a house key sat in the
// environment. Member B has no key: their job must land as an
// honest failure carrying the plain cannot-think words, never a
// dressed-up success.

const MEMBER_KEY = "tick-member-key-a";
const HOUSE_KEY = "house-key-must-never-run-a-member-heartbeat";
const seenAuth: string[] = [];

let stub: Server;
let root = "";
const savedEnv: Record<string, string | undefined> = {};

test.before(async () => {
  for (const k of ["SAM_MODEL_API_KEY", "SAM_VAULT_DIR"]) savedEnv[k] = process.env[k];
  process.env.SAM_MODEL_API_KEY = HOUSE_KEY;
  root = mkdtempSync(join(tmpdir(), "sam-member-heartbeat-"));
  process.env.SAM_VAULT_DIR = join(root, "vault");
  stub = createServer((req, res) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => {
      seenAuth.push(String(req.headers.authorization ?? ""));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Heartbeat check complete: one new thing worth knowing today." } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
});

test.after(async () => {
  stub.close();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});

async function ensureChat(title: string, profile: string): Promise<string> {
  const db = new ChatStore(root);
  try {
    const found = db.list().find(c => c.title === title && (c.agent_name ?? null) === (profile === "sam" ? null : profile));
    if (found) return found.id;
    return db.create(title, profile === "sam" ? null : profile).id;
  } finally { db.close(); }
}

test("a member heartbeat tick runs the keyed member's job on their own key and records the keyless member's job as an honest cannot-think failure", async () => {
  const stubEndpoint = "http://127.0.0.1:" + (stub.address() as { port: number }).port + "/v1/chat/completions";
  const a = findOrCreateMember(root, "tick-a@example.com").member;
  setMemberKey(root, a, { apiKey: MEMBER_KEY, kind: "custom", endpoint: stubEndpoint, model: "stub-1" });
  const b = findOrCreateMember(root, "tick-b@example.com").member;

  addHeartbeatJob(root, "Tick proof A", 5, a.profile, "Check in and report anything new.");
  addHeartbeatJob(root, "Tick proof B", 5, b.profile, "Check in and report anything new.");

  const result = await runHeartbeat(root, {
    runTurn: (chatId, content) => runChatTurn(root, chatId, content, { route: "heartbeat" }),
    ensureChat,
  });

  // Both jobs fired. A's changed (a real reply landed); B's failed.
  assert.ok(result.ran.includes("Tick proof A"), JSON.stringify(result.ran));
  assert.ok(result.ran.includes("Tick proof B"), JSON.stringify(result.ran));
  assert.ok(result.changed.includes("Tick proof A"), JSON.stringify(result.changed));
  assert.ok(result.failed.includes("Tick proof B"), JSON.stringify(result.failed));

  // A's result lives in A's own heartbeat chat, under A's profile.
  const db = new ChatStore(root);
  try {
    const chat = db.list().find(c => c.title === "Heartbeat · Tick proof A");
    assert.ok(chat, "the heartbeat chat exists");
    assert.equal(chat.agent_name, a.profile);
    const messages = db.messages(chat.id);
    assert.ok(messages.some(m => m.role === "assistant" && m.content.includes("Heartbeat check complete")), JSON.stringify(messages.map(m => m.content)));
  } finally { db.close(); }

  // Every model call carried A's own key, never the house key.
  assert.ok(seenAuth.length >= 1);
  assert.ok(seenAuth.every(h => h === "Bearer " + MEMBER_KEY), seenAuth.join(","));
  assert.ok(!seenAuth.some(h => h.includes(HOUSE_KEY)));

  // B's record is the honest outcome: a heartbeat-failed line under
  // B's own profile naming the cannot-think reason in plain words.
  const bLines = readActivity(root, 60, { actor: b.profile });
  const failed = bLines.find(l => l.kind === "heartbeat-failed");
  assert.ok(failed, JSON.stringify(bLines.map(l => l.kind)));
  assert.match(failed.summary, /cannot think yet/i);
  assert.match(failed.summary, /Tick proof B/);
});
