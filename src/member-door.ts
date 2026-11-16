import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { recordActivity } from "./activity.js";
import { ChatStore } from "./chats.js";
import { chatTurnActive, enqueueChatMessage, listChatQueue, mergeQueueIntoMessages, resendFailedMessage, resetChatTurn, resumeChatQueues } from "./chat-queue.js";
import { CHAT_LIVE_POLL_MS, chatThreadSignature, sseThreadEvent } from "./dashboard-live.js";
import { decideAction, listActions } from "./actions.js";
import { listArtifacts } from "./artifacts.js";
import { listBackgroundTasks } from "./background.js";
import { panelMemory } from "./run-inspector.js";
import { installedSkills } from "./skill-registry.js";
import { readActivity } from "./activity.js";
import { sessionCapStatus } from "./session-caps.js";
import { RateLimiter } from "./mini-door.js";
import {
  findOrCreateMember, listApiTokens, memberDoorPaused, memberForApiToken, memberForSession, memberThinkBlock, memberView,
  mintApiToken, mintMagicToken, redeemMagicToken, removeMemberKey, revokeApiToken, revokeSession,
  setMemberKey, setMemberKeySource,
  type Member,
} from "./members.js";
import { sendMagicLinkEmail } from "./member-mail.js";

// The member door (Mission Control Phase 1, Dip ruling 2026-11-15):
// the public API the hosted web app talks to. Every rule of the
// house applies harder here because this door faces the internet:
// - A real credential on EVERY call: a per-account session token
//   (Bearer) minted only by a redeemed magic link. There is no
//   anonymous route except /health and the two auth doors, and the
//   auth doors are rate-limited and never enumerate accounts.
// - The Host header must be on the allowlist (the loopback names
//   plus SAM_MEMBER_DOOR_HOSTS), so a stray DNS name or a
//   port-scan vhost gets nothing.
// - The operator kill switch (env flag or flag file) pauses the
//   whole door in one move; /health keeps answering so the app can
//   say "paused" instead of "gone".
// - Isolation is structural: every read is keyed by the SESSION's
//   member profile. A chat, action, artifact, or record that
//   belongs to another profile answers 404, the same as missing -
//   the door never confirms another member's world exists.
// - Turns ride the same chat queue the dashboard uses (bursts,
//   live updates, session caps), and the member's SAM thinks only
//   on the member's own key (members.ts / failover.ts).

const DOOR_VERSION = 1;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}
function readBody(req: IncomingMessage, cap = 32768): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) { rejectBody(new Error("Request body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed as Record<string, unknown>;
}
function clientIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

export interface MemberDoorOptions {
  port?: number;
  /** Extra Host header values to accept (the public funnel name). */
  hosts?: string[];
}

export async function serveMemberDoor(root: string, opts: MemberDoorOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const port = opts.port ?? 4321;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid member door port");
  const workspace = resolve(root);
  const allowedHosts = new Set<string>([
    "127.0.0.1:" + port, "localhost:" + port, "[::1]:" + port,
    ...(opts.hosts ?? []),
    ...((process.env.SAM_MEMBER_DOOR_HOSTS ?? "").split(",").map(s => s.trim()).filter(Boolean)),
  ]);
  // Auth attempts, per address: link requests 10 per hour (each
  // one sends an email), redemptions 30 per hour. No minimum gap:
  // a person double-tapping the form is not a grinding script,
  // the hourly caps bind the scripts, and the token's 256-bit
  // entropy is the real wall. Member messages: 120 per hour per
  // account (the per-chat session caps bind tighter for real
  // abuse; this stops a runaway client draining a key).
  const linkLimiter = new RateLimiter(10, 3600_000, 0);
  const redeemLimiter = new RateLimiter(30, 3600_000, 0);
  const messageLimiter = new RateLimiter(120, 3600_000, 0);
  resumeChatQueues(workspace);

  function memberChats(member: Member): Array<{ id: string; title: string; updatedAt: string }> {
    const store = new ChatStore(workspace);
    try {
      return store.list().filter(c => c.agent_name === member.profile)
        .map(c => ({ id: c.id, title: c.title, updatedAt: c.updated_at }));
    } finally { store.close(); }
  }
  function ownsChat(member: Member, chatId: string): boolean {
    const store = new ChatStore(workspace);
    try {
      const chat = store.get(chatId);
      return !!chat && chat.agent_name === member.profile;
    } finally { store.close(); }
  }
  function loadThread(member: Member, chatId: string) {
    const store = new ChatStore(workspace);
    try {
      const chat = store.get(chatId);
      if (!chat || chat.agent_name !== member.profile) return null;
      let queue: ReturnType<typeof listChatQueue> = [];
      let turnActive = false;
      try { queue = listChatQueue(workspace, chatId); turnActive = chatTurnActive(workspace, chatId); } catch { /* queue view is garnish */ }
      const merged = mergeQueueIntoMessages(store.messages(chatId), queue);
      const actions = listActions(workspace).filter(a => a.chatId === chatId && a.actor === member.profile);
      return {
        chat: { id: chat.id, title: chat.title, updatedAt: chat.updated_at },
        messages: merged.messages, queue: merged.queue, turnActive, actions,
      };
    } finally { store.close(); }
  }
  function panels(member: Member) {
    const chats = memberChats(member);
    const chatIds = new Set(chats.map(c => c.id));
    const missions = listBackgroundTasks(workspace)
      .filter(t => t.actor === member.profile)
      .map(t => ({ id: t.id, title: t.title, status: t.status, chatId: t.chatId, createdAt: t.createdAt, finishedAt: t.finishedAt, result: t.result ? t.result.slice(0, 2000) : null }));
    const approvals = listActions(workspace)
      .filter(a => a.status === "pending" && (a.actor === member.profile || (a.chatId !== null && chatIds.has(a.chatId))))
      .map(a => ({ id: a.id, kind: a.kind, title: a.title, detail: a.detail.slice(0, 1000), createdAt: a.createdAt, chatId: a.chatId }));
    const intel = readActivity(workspace, 40, { actor: member.profile })
      .map(line => ({ at: line.at, kind: line.kind, summary: line.summary }));
    let artifacts: Array<{ id: string; title: string; kind: string; version: number; updatedAt: string; path: string }> = [];
    try {
      artifacts = listArtifacts(workspace, member.profile)
        .map(a => ({ id: a.id, title: a.title, kind: a.kind, version: a.version, updatedAt: a.updatedAt, path: a.path }));
    } catch { artifacts = []; }
    let memory: Array<{ id: string; kind: string; createdAt: string; preview: string }> = [];
    try {
      memory = panelMemory(workspace, member.profile).records.slice(0, 25)
        .map(r => ({ id: r.id, kind: r.kind, createdAt: r.created_at, preview: r.preview }));
    } catch { memory = []; }
    let skills: Array<{ name: string; source: string }> = [];
    try { skills = installedSkills(workspace).map(s => ({ name: s.name, source: s.source })); } catch { skills = []; }
    let caps: Array<{ chatId: string; turns: number; maxTurns: number; tokens: number; maxTokens: number }> = [];
    try {
      caps = chats.map(c => {
        const s = sessionCapStatus(workspace, c.id);
        return { chatId: c.id, turns: s.turnsUsed, maxTurns: s.caps.maxTurns, tokens: s.tokensUsed, maxTokens: s.caps.maxTokens };
      });
    } catch { caps = []; }
    return { missions, approvals, intel, artifacts, memory, skills, caps, chats };
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://member-door");
      const host = (req.headers.host ?? "").toLowerCase();
      if (!allowedHosts.has(host)) { sendJson(res, 421, { error: "Unknown host" }); return; }
      const path = url.pathname;

      if (path === "/health") {
        sendJson(res, 200, { ok: true, door: DOOR_VERSION, paused: memberDoorPaused(workspace) });
        return;
      }
      if (memberDoorPaused(workspace)) {
        sendJson(res, 503, { error: "Mission Control is paused right now. Try again soon." });
        return;
      }

      // --- Auth doors (no session yet) ---
      if (path === "/auth/request-link" && req.method === "POST") {
        if (!linkLimiter.allow("link:" + clientIp(req))) { sendJson(res, 429, { error: "Too many tries. Wait a bit and try again." }); return; }
        const body = await readJson(req);
        let created = false;
        let member: Member;
        try {
          const found = findOrCreateMember(workspace, String(body.email ?? ""));
          member = found.member; created = found.created;
        } catch {
          // An invalid address gets the same calm answer shape as a
          // good one - the door never teaches enumeration.
          sendJson(res, 200, { ok: true, mailDelivered: false });
          return;
        }
        if (member.status !== "active") { sendJson(res, 200, { ok: true, mailDelivered: false }); return; }
        const raw = mintMagicToken(workspace, member);
        const mail = await sendMagicLinkEmail(workspace, { to: member.email, rawToken: raw });
        sendJson(res, 200, { ok: true, mailDelivered: mail.delivered, accountCreated: created });
        return;
      }
      if (path === "/auth/redeem" && req.method === "POST") {
        if (!redeemLimiter.allow("redeem:" + clientIp(req))) { sendJson(res, 429, { error: "Too many tries. Wait a bit and try again." }); return; }
        const body = await readJson(req);
        const redeemed = redeemMagicToken(workspace, String(body.token ?? ""));
        if (!redeemed) { sendJson(res, 401, { error: "That link has expired or was already used. Ask for a fresh one." }); return; }
        sendJson(res, 200, { sessionToken: redeemed.sessionToken, member: memberView(workspace, redeemed.member) });
        return;
      }

      // --- Everything below needs the member's credential: a
      // session token from the app, or one of the member's own API
      // tokens (the developer door). Both carry exactly the
      // member's scope. ---
      const authHeader = req.headers.authorization ?? "";
      const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      const member = sessionToken
        ? (memberForSession(workspace, sessionToken) ?? memberForApiToken(workspace, sessionToken))
        : null;
      if (!member) { sendJson(res, 401, { error: "Sign in first." }); return; }
      const view = memberView(workspace, member);

      if (path === "/auth/sign-out" && req.method === "POST") {
        revokeSession(workspace, sessionToken);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path === "/me" && req.method === "GET") {
        sendJson(res, 200, { member: view });
        return;
      }
      if (path === "/me/key" && req.method === "POST") {
        const body = await readJson(req);
        try {
          const next = setMemberKey(workspace, member, {
            apiKey: String(body.apiKey ?? ""),
            kind: body.kind === "custom" ? "custom" : "minimax",
            endpoint: typeof body.endpoint === "string" ? body.endpoint : undefined,
            model: typeof body.model === "string" ? body.model : undefined,
          });
          sendJson(res, 200, { member: next });
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : "That key could not be saved." });
        }
        return;
      }
      if (path === "/me/key" && req.method === "DELETE") {
        sendJson(res, 200, { member: removeMemberKey(workspace, member) });
        return;
      }
      if (path === "/me/key-source" && req.method === "POST") {
        const body = await readJson(req);
        try {
          const next = setMemberKeySource(workspace, member, body.source === "managed" ? "managed" : "own");
          sendJson(res, 200, { member: next });
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : "That choice could not be saved." });
        }
        return;
      }
      if (path === "/me/api-tokens" && req.method === "GET") {
        sendJson(res, 200, { tokens: listApiTokens(workspace, member) });
        return;
      }
      if (path === "/me/api-tokens" && req.method === "POST") {
        const body = await readJson(req);
        try {
          const minted = mintApiToken(workspace, member, typeof body.name === "string" ? body.name : "");
          sendJson(res, 201, { token: minted.token, view: minted.view });
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : "That token could not be made." });
        }
        return;
      }
      const apiTokenMatch = path.match(/^\/me\/api-tokens\/([A-Za-z0-9-]+)$/);
      if (apiTokenMatch && req.method === "DELETE") {
        const gone = revokeApiToken(workspace, member, apiTokenMatch[1]);
        sendJson(res, gone ? 200 : 404, gone ? { ok: true } : { error: "No such token." });
        return;
      }
      if (path === "/developer" && req.method === "GET") {
        // The pro layer, stated plainly (dual-audience bar): the
        // same engine, scriptable. Everything named here is real:
        // the CLI from the public repo, this door as the API, the
        // member's own tokens above, their activity as the log.
        sendJson(res, 200, {
          profile: member.profile,
          cli: {
            install: "git clone https://github.com/ReactionLabs/sam.git && cd sam && ./scripts/install.sh",
            repo: "https://github.com/ReactionLabs/sam",
            note: "The full SAM command line: every screen in this app is a door on the same engine the CLI drives.",
          },
          api: {
            base: (process.env.SAM_MEMBER_DOOR_PUBLIC_URL ?? "") || null,
            auth: "Send your API token as a Bearer token. Mint one under API tokens; it carries exactly your account's scope.",
            note: "This door is the API: chats, panels, approvals, and your key settings, all JSON.",
          },
          skills: {
            note: "SAM runs playbooks called skills. The ones installed on this SAM are listed under Tools; the library and the format live in the repo.",
            repo: "https://github.com/ReactionLabs/sam",
          },
          logs: {
            note: "Your Intel feed is your SAM's own activity log, written as it works. The CLI shows the same ledger locally.",
          },
        });
        return;
      }
      if (path === "/panels" && req.method === "GET") {
        sendJson(res, 200, panels(member));
        return;
      }
      if (path === "/chats" && req.method === "GET") {
        sendJson(res, 200, { chats: memberChats(member) });
        return;
      }
      if (path === "/chats" && req.method === "POST") {
        const body = await readJson(req);
        const title = String(body.title ?? "New mission").trim().slice(0, 120) || "New mission";
        const store = new ChatStore(workspace);
        try {
          const chat = store.create(title, member.profile);
          sendJson(res, 201, { chat: { id: chat.id, title: chat.title, updatedAt: chat.updated_at } });
        } finally { store.close(); }
        return;
      }
      const chatMatch = path.match(/^\/chats\/([A-Za-z0-9-]+)(\/messages|\/live|\/reset)?$/);
      if (chatMatch) {
        const chatId = chatMatch[1];
        const sub = chatMatch[2] ?? "";
        if (!ownsChat(member, chatId)) { sendJson(res, 404, { error: "No such chat." }); return; }
        if (sub === "" && req.method === "GET") {
          const thread = loadThread(member, chatId);
          if (!thread) { sendJson(res, 404, { error: "No such chat." }); return; }
          sendJson(res, 200, thread);
          return;
        }
        if (sub === "/messages" && req.method === "POST") {
          if (!messageLimiter.allow("msg:" + member.id)) { sendJson(res, 429, { error: "A lot of messages in a short time. Give SAM a minute." }); return; }
          const body = await readJson(req);
          const content = String(body.content ?? "").trim();
          if (!content) { sendJson(res, 400, { error: "Write a message first." }); return; }
          // Cannot-think states answer directly in the chat: the
          // member asked SAM something, and SAM's answer is the
          // plain-words reason (add your key, usage spent) saved
          // as a real exchange - never a bare failed tag that
          // reads like a bug.
          const block = memberThinkBlock(workspace, member);
          if (block) {
            const store = new ChatStore(workspace);
            try {
              store.add(chatId, "user", content.slice(0, 20000), "member-app");
              store.add(chatId, "assistant", block);
            } finally { store.close(); }
            try { recordActivity(workspace, member.profile, "member-cannot-think", "SAM answered in chat with the plain reason it cannot think yet: " + block); } catch { /* the answer already landed */ }
            sendJson(res, 200, { status: "answered", reply: block });
            return;
          }
          const result = enqueueChatMessage(workspace, { chatId, content: content.slice(0, 20000), source: "member-app" });
          sendJson(res, result.status === "queued" ? 202 : 200, result);
          return;
        }
        if (sub === "/reset" && req.method === "POST") {
          const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
          const result = resetChatTurn(workspace, chatId);
          const nudge = typeof body.nudge === "string" ? body.nudge.trim().slice(0, 4000) : "";
          if (nudge) enqueueChatMessage(workspace, { chatId, content: nudge, source: "member-app" });
          sendJson(res, 200, result);
          return;
        }
        if (sub === "/live" && req.method === "GET") {
          // Same live pattern as the dashboard: the full thread
          // document whenever its signature changes, a comment
          // heartbeat so a quiet chat does not look disconnected.
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          req.socket?.setNoDelay(true);
          let closed = false;
          res.on("close", () => { closed = true; });
          const write = (chunk: string): boolean => {
            if (closed || res.writableEnded || res.destroyed) return false;
            try { res.write(chunk); return true; } catch { closed = true; return false; }
          };
          let lastSig = "";
          let lastBeat = Date.now();
          const publish = (): boolean => {
            const thread = loadThread(member, chatId);
            if (!thread) { write("event: gone\ndata: {}\n\n"); return false; }
            const sig = chatThreadSignature(thread);
            const now = Date.now();
            if (sig !== lastSig) { lastSig = sig; lastBeat = now; return write(sseThreadEvent(thread)); }
            if (now - lastBeat >= 15000) { lastBeat = now; return write(": ping\n\n"); }
            return true;
          };
          if (!write("retry: 3000\n\n") || !publish()) { if (!res.writableEnded) res.end(); return; }
          const timer = setInterval(() => { if (!publish()) { clearInterval(timer); if (!res.writableEnded) res.end(); } }, CHAT_LIVE_POLL_MS);
          res.on("close", () => clearInterval(timer));
          return;
        }
        sendJson(res, 404, { error: "No such route." });
        return;
      }
      const resendMatch = path.match(/^\/chats\/([A-Za-z0-9-]+)\/queue\/([A-Za-z0-9-]+)\/resend$/);
      if (resendMatch && req.method === "POST") {
        if (!ownsChat(member, resendMatch[1])) { sendJson(res, 404, { error: "No such chat." }); return; }
        try {
          const item = resendFailedMessage(workspace, resendMatch[1], resendMatch[2]);
          sendJson(res, 202, { item });
        } catch { sendJson(res, 404, { error: "No such failed message." }); }
        return;
      }
      const decideMatch = path.match(/^\/actions\/([A-Za-z0-9-]+)\/decide$/);
      if (decideMatch && req.method === "POST") {
        const action = listActions(workspace).find(a => a.id === decideMatch[1]);
        const memberChatIds = new Set(memberChats(member).map(c => c.id));
        if (!action || (action.actor !== member.profile && !(action.chatId !== null && memberChatIds.has(action.chatId)))) {
          sendJson(res, 404, { error: "No such approval." });
          return;
        }
        const body = await readJson(req);
        const decided = await decideAction(workspace, action.id, body.approve === true);
        sendJson(res, 200, { action: decided });
        return;
      }
      sendJson(res, 404, { error: "No such route." });
    } catch (error) {
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : "Something went wrong";
        sendJson(res, message === "Request body too large" ? 413 : 500, { error: "Something went wrong on SAM's side. Try again." });
        try { recordActivity(workspace, "sam", "member-door-error", ("Member door error: " + message).slice(0, 300)); } catch { /* never mask the response */ }
      } else {
        try { res.end(); } catch { /* already gone */ }
      }
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  return {
    port,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}
