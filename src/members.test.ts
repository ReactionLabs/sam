import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "./sqlite.js";
import {
  findOrCreateMember, isMemberProfile, listApiTokens, listMembers, memberByEmail,
  memberConnection, memberForApiToken, memberForSession, memberView, mintApiToken,
  MINIMAX_DEFAULT_MODEL, MINIMAX_MODELS,
  mintMagicToken, redeemMagicToken, removeMemberKey, revokeApiToken, revokeSession,
  setMemberKey, setMemberKeySource, setMemberStatus,
} from "./members.js";
import { ChatStore } from "./chats.js";
import { getVaultCredentialValue, listVaultCredentials } from "./vault.js";
import { turnRoutes } from "./failover.js";
import { executeOwnTool, memberToolRefusal } from "./own-tools.js";

function tempRoot(): string {
  // The vault lives OUTSIDE the SAM home by design (a sibling
  // directory), so sibling temp roots would share one vault -
  // every test root gets its own SAM_VAULT_DIR.
  const root = mkdtempSync(join(tmpdir(), "sam-members-"));
  process.env.SAM_VAULT_DIR = join(root, "vault");
  return root;
}

test("signup creates the account and its own scoped SAM", () => {
  const root = tempRoot();
  try {
    const { member, created } = findOrCreateMember(root, "  Owner@Example.com ");
    assert.equal(created, true);
    assert.equal(member.email, "owner@example.com");
    assert.match(member.profile, /^member-[0-9a-f]{8}$/);
    assert.equal(member.keySource, "own");
    // The scoped SAM exists on the per-person machinery, with a
    // welcome chat of its own.
    const store = new ChatStore(root);
    try {
      const chats = store.list().filter(c => c.agent_name === member.profile);
      assert.equal(chats.length, 1);
    } finally { store.close(); }
    // Same email again: same account, no second SAM.
    const again = findOrCreateMember(root, "owner@example.com");
    assert.equal(again.created, false);
    assert.equal(again.member.id, member.id);
    assert.equal(listMembers(root).length, 1);
    assert.equal(isMemberProfile(root, member.profile), true);
    assert.equal(isMemberProfile(root, "sam"), false);
    assert.throws(() => findOrCreateMember(root, "not-an-email"), /Invalid email/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("magic link redeems once, the session works, sign-out kills it", () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "second@example.com");
    const raw = mintMagicToken(root, member);
    const redeemed = redeemMagicToken(root, raw);
    assert.ok(redeemed);
    assert.equal(redeemed.member.id, member.id);
    // Single use: the same link never works twice.
    assert.equal(redeemMagicToken(root, raw), null);
    assert.equal(memberForSession(root, redeemed.sessionToken)?.id, member.id);
    assert.equal(revokeSession(root, redeemed.sessionToken), true);
    assert.equal(memberForSession(root, redeemed.sessionToken), null);
    // A fresh mint replaces the old link.
    const first = mintMagicToken(root, member);
    const second = mintMagicToken(root, member);
    assert.equal(redeemMagicToken(root, first), null);
    assert.ok(redeemMagicToken(root, second));
    // Garbage never redeems.
    assert.equal(redeemMagicToken(root, "f".repeat(64)), null);
    assert.equal(redeemMagicToken(root, "short"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an expired magic link does not redeem", () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "third@example.com");
    const raw = mintMagicToken(root, member);
    const db = openDatabase(join(root, ".sam", "members.db"));
    try {
      const rows = db.prepare("SELECT hash, data FROM member_tokens").all() as Array<{ hash: string; data: string }>;
      for (const row of rows) {
        const t = JSON.parse(row.data) as { expiresAt: string };
        t.expiresAt = new Date(Date.now() - 1000).toISOString();
        db.prepare("UPDATE member_tokens SET data = ? WHERE hash = ?").run(JSON.stringify(t), row.hash);
      }
    } finally { db.close(); }
    assert.equal(redeemMagicToken(root, raw), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("BYOK: the key vaults under the account name and never surfaces", () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "byok@example.com");
    // No key yet: the connection says so in plain words.
    const before = memberConnection(root, member);
    assert.ok("unavailable" in before && /add your key/i.test(before.unavailable));

    const secret = "sk-member-secret-1234567890";
    const view = setMemberKey(root, member, { apiKey: secret });
    assert.equal(view.hasKey, true);
    assert.equal(view.provider?.kind, "minimax");
    assert.equal(view.provider?.model, "MiniMax-M2.5");
    // The value is nowhere in the view, the member list, or the
    // connection facts - it lives only in the vault.
    assert.equal(JSON.stringify(view).includes(secret), false);
    assert.equal(JSON.stringify(listMembers(root)).includes(secret), false);
    const names = listVaultCredentials(root).map(c => c.name);
    assert.deepEqual(names, [view.id ? memberKeyOf(root) : ""]);
    assert.equal(getVaultCredentialValue(root, memberKeyOf(root)), secret);
    const conn = memberConnection(root, memberByEmail(root, "byok@example.com")!);
    assert.ok(!("unavailable" in conn));
    if (!("unavailable" in conn)) {
      assert.equal(conn.endpoint, "https://api.minimax.io/v1/chat/completions");
      assert.equal(conn.vaultKey, memberKeyOf(root));
      assert.equal(JSON.stringify(conn).includes(secret), false);
    }
    // Removal takes the SAM back to cannot-think-yet.
    const removed = removeMemberKey(root, memberByEmail(root, "byok@example.com")!);
    assert.equal(removed.hasKey, false);
    assert.ok("unavailable" in memberConnection(root, memberByEmail(root, "byok@example.com")!));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("BYOK model field: only a listed MiniMax model is stored; anything else lands on the default", () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "label@example.com");
    const fresh = () => memberByEmail(root, "label@example.com")!;
    // "Minimax" is the provider label, not a model name: typed into
    // the model field it must land on the default, in any case, or
    // the API 400s every turn.
    let view = setMemberKey(root, member, { apiKey: "sk-label-key", model: "Minimax" });
    assert.equal(view.provider?.model, MINIMAX_DEFAULT_MODEL);
    view = setMemberKey(root, fresh(), { apiKey: "sk-label-key", model: "MINIMAX" });
    assert.equal(view.provider?.model, MINIMAX_DEFAULT_MODEL);
    // Blank stays the default.
    view = setMemberKey(root, fresh(), { apiKey: "sk-label-key", model: "  " });
    assert.equal(view.provider?.model, MINIMAX_DEFAULT_MODEL);
    // Every model on the current list round-trips exactly.
    for (const model of MINIMAX_MODELS) {
      view = setMemberKey(root, fresh(), { apiKey: "sk-label-key", model });
      assert.equal(view.provider?.model, model);
    }
    // Off-list values normalize to the default instead of being
    // stored: a retired name and a foreign name alike.
    view = setMemberKey(root, fresh(), { apiKey: "sk-label-key", model: "MiniMax-M2" });
    assert.equal(view.provider?.model, MINIMAX_DEFAULT_MODEL);
    view = setMemberKey(root, fresh(), { apiKey: "sk-label-key", model: "gpt-4o" });
    assert.equal(view.provider?.model, MINIMAX_DEFAULT_MODEL);
    // The custom kind keeps its own model exactly as given.
    view = setMemberKey(root, fresh(), { apiKey: "sk-label-key", kind: "custom", endpoint: "https://example.com/v1/chat/completions", model: "minimax" });
    assert.equal(view.provider?.model, "minimax");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function memberKeyOf(root: string): string {
  return listVaultCredentials(root)[0]?.name ?? "";
}

test("turn routes: a member rides only their own key; the house key is never the route", () => {
  const root = tempRoot();
  const savedKey = process.env.SAM_MODEL_API_KEY;
  const savedEndpoint = process.env.SAM_MODEL_ENDPOINT;
  try {
    process.env.SAM_MODEL_API_KEY = "house-key-must-never-serve-a-member";
    const { member } = findOrCreateMember(root, "routes@example.com");
    // No key: one unavailable route with plain words, NOT the house
    // connection.
    let routes = turnRoutes(root, process.env, member.profile, null, "chat");
    assert.equal(routes.length, 1);
    assert.ok(routes[0].unavailable && /add your key/i.test(routes[0].unavailable));
    assert.equal(routes[0].vaultKey, undefined);
    // With a key: one member route carrying the vault NAME only.
    setMemberKey(root, member, { apiKey: "sk-routes-key" });
    routes = turnRoutes(root, process.env, memberByEmail(root, "routes@example.com")!.profile, null, "chat");
    assert.equal(routes.length, 1);
    assert.equal(routes[0].providerId, "member");
    assert.equal(routes[0].vaultKey, memberKeyOf(root));
    assert.equal(routes[0].keyEnv, "");
    // A non-member profile is untouched by the member branch.
    const house = turnRoutes(root, process.env, "sam", null, "chat");
    assert.notEqual(house[0].providerId, "member");
  } finally {
    if (savedKey === undefined) delete process.env.SAM_MODEL_API_KEY; else process.env.SAM_MODEL_API_KEY = savedKey;
    if (savedEndpoint === undefined) delete process.env.SAM_MODEL_ENDPOINT; else process.env.SAM_MODEL_ENDPOINT = savedEndpoint;
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed path: config-gated, capped, and honest when off", () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "managed@example.com");
    // Off by default: the switch refuses with plain words.
    assert.throws(() => setMemberKeySource(root, member, "managed", {}), /not open yet/);
    const view = setMemberKeySource(root, member, "managed", { SAM_MEMBER_MANAGED: "1" });
    assert.equal(view.keySource, "managed");
    assert.equal(view.managed.enabled, true);
    assert.equal(view.managed.spent, false);
    // Managed routes ride the house connection when under the cap.
    const env = { ...process.env, SAM_MEMBER_MANAGED: "1", SAM_MODEL_API_KEY: "house", SAM_MODEL_ENDPOINT: "https://api.minimax.io/v1/chat/completions" } as NodeJS.ProcessEnv;
    const routes = turnRoutes(root, env, member.profile, null, "chat");
    assert.equal(routes.length, 1);
    assert.equal(routes[0].vaultKey, undefined);
    assert.notEqual(routes[0].providerId, "member");
    // With managed off in env, the same account is told plainly.
    const off = turnRoutes(root, { ...process.env } as NodeJS.ProcessEnv, member.profile, null, "chat");
    assert.ok(off[0].unavailable && /not open yet/i.test(off[0].unavailable));
    // Back to own key any time.
    const back = setMemberKeySource(root, memberByEmail(root, "managed@example.com")!, "own", { SAM_MEMBER_MANAGED: "1" });
    assert.equal(back.keySource, "own");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("API tokens: mint shows once, hash at rest, revoke is instant, scope is the member", () => {
  const root = tempRoot();
  try {
    const a = findOrCreateMember(root, "dev-a@example.com").member;
    const b = findOrCreateMember(root, "dev-b@example.com").member;
    const minted = mintApiToken(root, a, "laptop scripts");
    assert.match(minted.token, /^sam_[0-9a-f]{48}$/);
    assert.equal(JSON.stringify(listApiTokens(root, a)).includes(minted.token), false);
    assert.equal(memberForApiToken(root, minted.token)?.id, a.id);
    // B's token list never shows A's token; A cannot revoke B's.
    const bMint = mintApiToken(root, b, "b token");
    assert.equal(listApiTokens(root, a).some(t => t.id === bMint.view.id), false);
    assert.equal(revokeApiToken(root, a, bMint.view.id), false);
    assert.equal(memberForApiToken(root, bMint.token)?.id, b.id);
    assert.equal(revokeApiToken(root, a, minted.view.id), true);
    assert.equal(memberForApiToken(root, minted.token), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a disabled member cannot sign in, hold a session, or set a key", () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "paused@example.com");
    const raw = mintMagicToken(root, member);
    const session = redeemMagicToken(root, raw);
    assert.ok(session);
    setMemberStatus(root, member.id, "disabled");
    assert.equal(memberForSession(root, session.sessionToken), null);
    const raw2 = mintMagicToken(root, memberByEmail(root, "paused@example.com")!);
    assert.equal(redeemMagicToken(root, raw2), null);
    assert.throws(() => setMemberKey(root, memberByEmail(root, "paused@example.com")!, { apiKey: "sk-x" }), /disabled/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the member tool fence: the machine hand is refused, the member hand works", () => {
  const root = tempRoot();
  try {
    const { member } = findOrCreateMember(root, "fence@example.com");
    const actor = member.profile;
    for (const tool of ["sam_code", "sam_coding_task", "sam_orchestrate", "sam_spawn_subagent", "sam_brief", "sam_senses", "sam_author_skill", "sam_workspace_read"]) {
      const refusal = memberToolRefusal(root, actor, tool, {});
      assert.ok(refusal && /not part of a member SAM's hand/.test(refusal.error), tool);
      const result = executeOwnTool(root, actor, tool, { action: "list" }) as { error?: string };
      assert.ok(result.error, tool + " must be refused at dispatch");
    }
    // Allowed tools pass the fence (the result is the tool's own).
    assert.equal(memberToolRefusal(root, actor, "sam_memory_list", {}), null);
    const listed = executeOwnTool(root, actor, "sam_memory_list", {}) as { error?: string };
    assert.equal(listed.error, undefined);
    // Proposal kinds are fenced too: engine/spawn refused, note fine,
    // heartbeat only for the member's own profile.
    assert.ok(memberToolRefusal(root, actor, "sam_propose_action", { kind: "engine", title: "x", detail: "{}" }));
    assert.ok(memberToolRefusal(root, actor, "sam_propose_action", { kind: "spawn", title: "x", detail: "{}" }));
    assert.equal(memberToolRefusal(root, actor, "sam_propose_action", { kind: "note", title: "x", detail: "hello" }), null);
    assert.ok(memberToolRefusal(root, actor, "sam_propose_action", { kind: "heartbeat", title: "x", detail: JSON.stringify({ profile: "sam", every: "day", summary: "s", channelId: "c" }) }));
    assert.equal(memberToolRefusal(root, actor, "sam_propose_action", { kind: "heartbeat", title: "x", detail: JSON.stringify({ profile: actor, every: "day", summary: "s", channelId: "c" }) }), null);
    // The operator's own profiles are never fenced.
    assert.equal(memberToolRefusal(root, "sam", "sam_code", { action: "list" }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
