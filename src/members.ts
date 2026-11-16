import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { recordActivity } from "./activity.js";
import { minis, spawnMini } from "./minis.js";
import { getVaultCredentialValue, listVaultCredentials, removeVaultCredential, setVaultCredential } from "./vault.js";
import { assertChatCompletionsUrl } from "./providers.js";
import { ChatStore } from "./chats.js";
import { sessionUsageToday } from "./session-caps.js";

// Members (Mission Control product, Dip ruling 2026-11-15): a member
// is a person with an ACCOUNT on a hosted SAM. An account owns
// exactly one scoped SAM - a mini on the existing per-person
// machinery - so everything the engine already scopes by profile
// (chats, memory, artifacts, approvals, law) is the member's alone
// the day the account exists, and no member surface can reach
// another member's world because every read is keyed by the
// account's own profile name.
//
// BYOK (bring your own key) is the money law of the product: a
// member's SAM thinks with the MEMBER's model key, stored in the
// SAM vault under a per-account credential name, resolved at turn
// time by the turn router (failover.ts) and spent only on that
// member's turns (agent-turn.ts ledgers one vault-use line per
// resolution). The house key in the process environment is NEVER a
// member route: a member with no key gets a SAM that cannot think
// yet, and every surface says so in plain words.
//
// Sign-in is a magic link: the raw token exists only in the email
// (and in the operator's hands when the CLI mints one); the store
// keeps its hash. A redeemed link mints a session token, also
// hash-stored, good for 30 days. Neither token is ever displayed
// back by any surface after its one delivery.

export const MEMBER_LINK_TTL_MS = 30 * 60 * 1000;
export const MEMBER_SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const MEMBER_PROVIDER_ID = "member";
export const MINIMAX_CHAT_ENDPOINT = "https://api.minimax.io/v1/chat/completions";
export const MINIMAX_DEFAULT_MODEL = "MiniMax-M2.5";
/** The current MiniMax chat models a member may pick (Settings
 *  shows this same list as a dropdown; the door validates against
 *  it). Lineup confirmed 2026-11-16 against the live MiniMax
 *  catalog summaries (M3.1 Flash, M3, M2.7, M2.5 and the Highspeed
 *  versions); M2.5 stays the standard default. */
export const MINIMAX_MODELS: readonly string[] = [
  "MiniMax-M2.5",
  "MiniMax-M2.5-highspeed",
  "MiniMax-M3",
  "MiniMax-M3.1-Flash",
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
];
const MAX_MEMBERS = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export interface MemberProviderConfig { kind: "minimax" | "custom"; endpoint: string; model: string }
/** Where the member's thinking comes from (monetization structure,
 *  Dip ruling 2026-11-15): "own" is BYOK - the member's vaulted
 *  key, their bill. "managed" runs on the house provider with
 *  per-account metering and hard daily caps from CONFIG (never
 *  code), and is only selectable while the operator has switched
 *  it on (SAM_MEMBER_MANAGED=1). Prices and billing are a later
 *  ruling: the member record carries a billing slot so the Stripe
 *  customer link lands without a migration, and NOTHING charges
 *  anyone in this build. */
export type MemberKeySource = "own" | "managed";
export interface Member {
  id: string;
  email: string;
  profile: string;
  person: string;
  createdAt: string;
  status: "active" | "disabled";
  provider: MemberProviderConfig | null;
  keyName: string | null;
  voiceKeyName: string | null;
  keySource: MemberKeySource;
  billing: { stripeCustomerId: string | null };
}
export interface ManagedStatus {
  enabled: boolean;
  turnsUsed: number;
  tokensUsed: number;
  maxTurns: number;
  maxTokens: number;
  spent: boolean;
}
export interface MemberView {
  id: string;
  email: string;
  profile: string;
  person: string;
  createdAt: string;
  status: "active" | "disabled";
  hasKey: boolean;
  hasVoiceKey: boolean;
  /** Turn-by-turn voice rides the member's own MiniMax chat key
   *  (member-mm-voice.ts): true when that key is in the vault, so
   *  the app can light the mode up with no extra deposit. */
  hasMmVoice: boolean;
  provider: MemberProviderConfig | null;
  keySource: MemberKeySource;
  managed: ManagedStatus;
  billingConnected: boolean;
}
interface MagicToken { hash: string; memberId: string; createdAt: string; expiresAt: string }
interface MemberSession { hash: string; memberId: string; createdAt: string; expiresAt: string }

function membersDbFile(root: string): string { return join(resolve(root), ".sam", "members.db"); }
function storeExists(root: string): boolean { return existsSync(membersDbFile(root)); }

// Failure visibility (the house pattern): a dead members store
// ledgers ONE member-store-failed line (phase read/write, actor
// sam, the verbatim reason collapsed and capped, never any member
// record - emails and profile names are people's data) and
// rethrows exactly, so readers fail closed: a dead store never
// reads as "no such member" (which would lock a real member out
// dressed as a bad token) and never as a member.
export type MemberStorePhase = "read" | "write";
export function memberStoreFailureSummary(phase: MemberStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Member store " + phase + " failed: " + clean).slice(0, 200);
}
export function recordMemberStoreFailure(root: string, phase: MemberStorePhase, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "member-store-failed", memberStoreFailureSummary(phase, reason));
}
function tagMemberStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { memberStoreLedgered?: boolean }).memberStoreLedgered = true;
  }
}
export function isMemberStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { memberStoreLedgered?: boolean }).memberStoreLedgered === true;
}
const MEMBER_VALIDATION = [/^Invalid email/, /^Member account limit/, /^Account is disabled/, /^Invalid model/, /^Model endpoint must be/, /^Wildcard model endpoint/, /^Vault credential/];
function isMemberValidation(error: unknown): boolean {
  return error instanceof Error && MEMBER_VALIDATION.some(re => re.test(error.message));
}
function failMemberStore(root: string, phase: MemberStorePhase, error: unknown): never {
  if (!isMemberStoreLedgered(error) && !isMemberValidation(error)) recordMemberStoreFailure(root, phase, error);
  if (!isMemberValidation(error)) tagMemberStoreLedgered(error);
  throw error;
}
function openMembersStore(root: string): Database.Database {
  const dir = join(resolve(root), ".sam");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe SAM state directory");
  const db = openDatabase(membersDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS member_tokens (hash TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS member_sessions (hash TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS member_api_tokens (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  return db;
}
function openMembersGuarded(root: string, phase: MemberStorePhase): Database.Database {
  try { return openMembersStore(root); }
  catch (error) { failMemberStore(root, phase, error); }
}
function rowToMember(data: string): Member | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object") return null;
    const m = value as Partial<Member>;
    if (typeof m.id !== "string" || typeof m.email !== "string" || typeof m.profile !== "string") return null;
    return {
      id: m.id, email: m.email, profile: m.profile,
      person: typeof m.person === "string" ? m.person : "Member",
      createdAt: typeof m.createdAt === "string" ? m.createdAt : "",
      status: m.status === "disabled" ? "disabled" : "active",
      provider: m.provider && typeof m.provider === "object" ? m.provider : null,
      keyName: typeof m.keyName === "string" ? m.keyName : null,
      voiceKeyName: typeof m.voiceKeyName === "string" ? m.voiceKeyName : null,
      keySource: m.keySource === "managed" ? "managed" : "own",
      billing: { stripeCustomerId: m.billing && typeof m.billing.stripeCustomerId === "string" ? m.billing.stripeCustomerId : null },
    };
  } catch { return null; }
}
function readMembers(db: Database.Database): Member[] {
  const rows = db.prepare("SELECT data FROM members ORDER BY rowid").all() as Array<{ data: string }>;
  const out: Member[] = [];
  for (const row of rows) { const m = rowToMember(row.data); if (m) out.push(m); }
  return out;
}
function findMemberRow(db: Database.Database, id: string): Member | null {
  const row = db.prepare("SELECT data FROM members WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? rowToMember(row.data) : null;
}
function saveMemberRow(db: Database.Database, member: Member): void {
  db.prepare("INSERT INTO members (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
    .run(member.id, JSON.stringify(member));
}

export function normalizeEmail(raw: string): string {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) throw new Error("Invalid email address");
  return email;
}
function personFromEmail(email: string): string {
  const local = email.split("@")[0].replace(/[^a-z0-9]+/gi, " ").trim();
  const person = (local || "Member").slice(0, 40).trim();
  return person || "Member";
}
export function memberInstructions(person: string): string {
  return "You are SAM (Secret Agent Man), the personal AI assistant for " + person + ". " +
    "You work for them: remember what they tell you, help them run their work and their days, " +
    "and when they ask for something to keep - a brief, a plan, a page, a report - make it as an artifact instead of pasting it into the chat. " +
    "Anything consequential (sending, spending, changing a standing rule) is a proposal they approve first. " +
    "Speak in plain words, no jargon, no machinery. You know only their world: never mention other people, other accounts, or how you are built.";
}

/** The account for an email, creating it (and its scoped SAM) on
 *  first sight. Signup and login are the same act, so no surface
 *  can enumerate accounts by watching which emails "exist". */
export function findOrCreateMember(root: string, rawEmail: string): { member: Member; created: boolean } {
  const email = normalizeEmail(rawEmail);
  if (!storeExists(root)) return createMember(root, email);
  const db = openMembersGuarded(root, "read");
  try {
    const found = readMembers(db).find(m => m.email === email);
    if (found) return { member: found, created: false };
  } catch (error) { failMemberStore(root, "read", error); }
  finally { db.close(); }
  return createMember(root, email);
}
function createMember(root: string, email: string): { member: Member; created: boolean } {
  const existing = storeExists(root) ? listMembers(root) : [];
  if (existing.length >= MAX_MEMBERS) throw new Error("Member account limit reached");
  const id = randomUUID();
  const profile = "member-" + id.slice(0, 8);
  if (existing.some(m => m.profile === profile) || minis(root).some(m => m.name === profile)) {
    // A uuid-prefix collision is vanishingly unlikely; fail loudly
    // rather than ever merging two people's worlds.
    throw new Error("Member profile collision - try again");
  }
  const person = personFromEmail(email);
  spawnMini(root, { name: profile, person, instructions: memberInstructions(person) });
  const member: Member = { id, email, profile, person, createdAt: new Date().toISOString(), status: "active", provider: null, keyName: null, voiceKeyName: null, keySource: "own", billing: { stripeCustomerId: null } };
  const db = openMembersGuarded(root, "write");
  try { saveMemberRow(db, member); }
  catch (error) { failMemberStore(root, "write", error); }
  finally { db.close(); }
  recordActivity(root, "sam", "member-joined", "A new member account was created for profile " + profile);
  return { member, created: true };
}
export function listMembers(root: string): Member[] {
  if (!storeExists(root)) return [];
  const db = openMembersGuarded(root, "read");
  try { return readMembers(db); }
  catch (error) { failMemberStore(root, "read", error); }
  finally { db.close(); }
}
export function memberById(root: string, id: string): Member | null {
  if (!storeExists(root)) return null;
  const db = openMembersGuarded(root, "read");
  try { return findMemberRow(db, id); }
  catch (error) { failMemberStore(root, "read", error); }
  finally { db.close(); }
}
export function memberByEmail(root: string, rawEmail: string): Member | null {
  let email: string;
  try { email = normalizeEmail(rawEmail); } catch { return null; }
  return listMembers(root).find(m => m.email === email) ?? null;
}
export function memberForProfile(root: string, profileName: string): Member | null {
  if (!profileName || !storeExists(root)) return null;
  return listMembers(root).find(m => m.profile === profileName) ?? null;
}
export function isMemberProfile(root: string, profileName: string): boolean {
  return memberForProfile(root, profileName) !== null;
}
export function setMemberStatus(root: string, id: string, status: "active" | "disabled"): Member | null {
  const member = memberById(root, id);
  if (!member) return null;
  const next: Member = { ...member, status };
  const db = openMembersGuarded(root, "write");
  try { saveMemberRow(db, next); }
  catch (error) { failMemberStore(root, "write", error); }
  finally { db.close(); }
  recordActivity(root, "sam", status === "disabled" ? "member-disabled" : "member-enabled", "Member account for profile " + member.profile + " was " + status);
  return next;
}

// --- Magic links and sessions -------------------------------------

function hashToken(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }
function hashMatches(storedHex: string, raw: string): boolean {
  const wanted = Buffer.from(hashToken(raw), "hex");
  const stored = Buffer.from(storedHex, "hex");
  return stored.length === wanted.length && timingSafeEqual(stored, wanted);
}

/** Mint a magic-link token for a member. The RAW token is returned
 *  once, for the mailer (or the operator's CLI) to deliver; the
 *  store keeps only its hash. Minting replaces any live token for
 *  the member, so the newest email is the only working link. */
export function mintMagicToken(root: string, member: Member): string {
  const raw = randomBytes(32).toString("hex");
  const now = Date.now();
  const record: MagicToken = { hash: hashToken(raw), memberId: member.id, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + MEMBER_LINK_TTL_MS).toISOString() };
  const db = openMembersGuarded(root, "write");
  try {
    const rows = db.prepare("SELECT hash, data FROM member_tokens").all() as Array<{ hash: string; data: string }>;
    for (const row of rows) {
      try { const t = JSON.parse(row.data) as MagicToken; if (t.memberId === member.id) db.prepare("DELETE FROM member_tokens WHERE hash = ?").run(row.hash); } catch { /* torn row: leave it */ }
    }
    db.prepare("INSERT INTO member_tokens (hash, data) VALUES (?, ?)").run(record.hash, JSON.stringify(record));
  } catch (error) { failMemberStore(root, "write", error); }
  finally { db.close(); }
  return raw;
}

/** Redeem a magic-link token: single use, 30-minute life. Returns
 *  a fresh session token (raw, shown once) and the member. */
export function redeemMagicToken(root: string, raw: string): { sessionToken: string; member: Member } | null {
  if (!/^[0-9a-f]{64}$/.test(raw ?? "") || !storeExists(root)) return null;
  const db = openMembersGuarded(root, "write");
  try {
    const rows = db.prepare("SELECT hash, data FROM member_tokens").all() as Array<{ hash: string; data: string }>;
    let found: MagicToken | null = null;
    for (const row of rows) {
      let t: MagicToken | null = null;
      try { t = JSON.parse(row.data) as MagicToken; } catch { t = null; }
      if (t && hashMatches(row.hash, raw)) { found = t; break; }
    }
    if (!found) return null;
    db.prepare("DELETE FROM member_tokens WHERE hash = ?").run(found.hash);
    if (Date.now() >= Date.parse(found.expiresAt)) return null;
    const member = findMemberRow(db, found.memberId);
    if (!member || member.status !== "active") return null;
    const sessionRaw = randomBytes(32).toString("hex");
    const now = Date.now();
    const session: MemberSession = { hash: hashToken(sessionRaw), memberId: member.id, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + MEMBER_SESSION_TTL_MS).toISOString() };
    db.prepare("INSERT INTO member_sessions (hash, data) VALUES (?, ?)").run(session.hash, JSON.stringify(session));
    recordActivity(root, member.profile, "member-signed-in", "A member signed in with a magic link");
    return { sessionToken: sessionRaw, member };
  } catch (error) { failMemberStore(root, "write", error); }
  finally { db.close(); }
}

export function memberForSession(root: string, raw: string): Member | null {
  if (!/^[0-9a-f]{64}$/.test(raw ?? "") || !storeExists(root)) return null;
  const db = openMembersGuarded(root, "read");
  try {
    const rows = db.prepare("SELECT hash, data FROM member_sessions").all() as Array<{ hash: string; data: string }>;
    for (const row of rows) {
      let s: MemberSession | null = null;
      try { s = JSON.parse(row.data) as MemberSession; } catch { s = null; }
      if (!s || !hashMatches(row.hash, raw)) continue;
      if (Date.now() >= Date.parse(s.expiresAt)) return null;
      const member = findMemberRow(db, s.memberId);
      return member && member.status === "active" ? member : null;
    }
    return null;
  } catch (error) { failMemberStore(root, "read", error); }
  finally { db.close(); }
}
export function revokeSession(root: string, raw: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(raw ?? "") || !storeExists(root)) return false;
  const db = openMembersGuarded(root, "write");
  try {
    const rows = db.prepare("SELECT hash FROM member_sessions").all() as Array<{ hash: string }>;
    for (const row of rows) {
      if (hashMatches(row.hash, raw)) { db.prepare("DELETE FROM member_sessions WHERE hash = ?").run(row.hash); return true; }
    }
    return false;
  } catch (error) { failMemberStore(root, "write", error); }
  finally { db.close(); }
}

// --- Bring your own key --------------------------------------------

export function memberKeyName(member: Member): string {
  return "member-" + member.id.slice(0, 8) + "-key";
}
export function memberHasKey(root: string, member: Member): boolean {
  if (!member.keyName) return false;
  return listVaultCredentials(root).some(c => c.name === member.keyName);
}
export function memberVoiceKeyName(member: Member): string {
  return "member-" + member.id.slice(0, 8) + "-voice-key";
}
export function memberHasVoiceKey(root: string, member: Member): boolean {
  if (!member.voiceKeyName) return false;
  return listVaultCredentials(root).some(c => c.name === member.voiceKeyName);
}
export function memberView(root: string, member: Member, env: NodeJS.ProcessEnv = process.env): MemberView {
  return {
    id: member.id, email: member.email, profile: member.profile, person: member.person,
    createdAt: member.createdAt, status: member.status,
    hasKey: memberHasKey(root, member),
    hasVoiceKey: memberHasVoiceKey(root, member),
    hasMmVoice: memberHasKey(root, member) && member.provider?.kind === "minimax",
    provider: member.provider,
    keySource: member.keySource,
    managed: memberManagedStatus(root, member, env),
    billingConnected: member.billing.stripeCustomerId !== null,
  };
}

// --- Managed path: house key, metered, capped by config -----------

export interface ManagedConfig { enabled: boolean; maxTurnsPerDay: number; maxTokensPerDay: number }
export function managedConfig(env: NodeJS.ProcessEnv = process.env): ManagedConfig {
  const turns = Number(env.SAM_MEMBER_MANAGED_DAILY_TURNS ?? "");
  const tokens = Number(env.SAM_MEMBER_MANAGED_DAILY_TOKENS ?? "");
  return {
    enabled: env.SAM_MEMBER_MANAGED === "1",
    maxTurnsPerDay: Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : 50,
    maxTokensPerDay: Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 250000,
  };
}
/** Today's usage for one member, summed over their own chats from
 *  the same session-cap ledger every turn already writes - the
 *  meter is the engine's own bookkeeping, not a second guess. */
export function memberUsageToday(root: string, member: Member): { turns: number; tokens: number } {
  const store = new ChatStore(root);
  let chatIds: Set<string>;
  try { chatIds = new Set(store.list({ includeArchived: true }).filter(c => c.agent_name === member.profile).map(c => c.id)); }
  finally { store.close(); }
  let turns = 0;
  let tokens = 0;
  for (const row of sessionUsageToday(root)) {
    if (chatIds.has(row.chatId)) { turns += row.turns; tokens += row.tokens; }
  }
  return { turns, tokens };
}
export function memberManagedStatus(root: string, member: Member, env: NodeJS.ProcessEnv = process.env): ManagedStatus {
  const cfg = managedConfig(env);
  let usage = { turns: 0, tokens: 0 };
  try { usage = memberUsageToday(root, member); } catch { usage = { turns: 0, tokens: 0 }; }
  return {
    enabled: cfg.enabled,
    turnsUsed: usage.turns,
    tokensUsed: usage.tokens,
    maxTurns: cfg.maxTurnsPerDay,
    maxTokens: cfg.maxTokensPerDay,
    spent: usage.turns >= cfg.maxTurnsPerDay || usage.tokens >= cfg.maxTokensPerDay,
  };
}
export function setMemberKeySource(root: string, member: Member, source: MemberKeySource, env: NodeJS.ProcessEnv = process.env): MemberView {
  if (source === "managed" && !managedConfig(env).enabled) {
    throw new Error("Running on our key is not open yet. Add your own key and SAM is ready today.");
  }
  const next: Member = { ...member, keySource: source };
  const db = openMembersGuarded(root, "write");
  try { saveMemberRow(db, next); }
  catch (error) { failMemberStore(root, "write", error); }
  finally { db.close(); }
  recordActivity(root, member.profile, "member-key-source", source === "managed" ? "The member chose to run SAM on the house key (metered)" : "The member chose to run SAM on their own key");
  return memberView(root, next, env);
}

// --- API tokens (the developer door) --------------------------------
// A member can mint named API tokens for scripts and tools. Same
// discipline as sessions: the raw token is shown once at minting,
// the store keeps its hash, revocation is instant, and a token
// carries exactly the member's own scope - nothing more exists
// for it to reach.

export interface MemberApiTokenView { id: string; name: string; createdAt: string }
interface MemberApiToken { id: string; hash: string; memberId: string; name: string; createdAt: string }
const MAX_API_TOKENS_PER_MEMBER = 10;

export function mintApiToken(root: string, member: Member, name: string): { token: string; view: MemberApiTokenView } {
  const clean = (name ?? "").trim().slice(0, 60) || "API token";
  const db = openMembersGuarded(root, "write");
  try {
    const rows = db.prepare("SELECT data FROM member_api_tokens").all() as Array<{ data: string }>;
    let mine = 0;
    for (const row of rows) { try { if ((JSON.parse(row.data) as MemberApiToken).memberId === member.id) mine++; } catch { /* torn row */ } }
    if (mine >= MAX_API_TOKENS_PER_MEMBER) throw new Error("Token limit reached - revoke one first");
    const raw = "sam_" + randomBytes(24).toString("hex");
    const record: MemberApiToken = { id: randomUUID(), hash: hashToken(raw), memberId: member.id, name: clean, createdAt: new Date().toISOString() };
    db.prepare("INSERT INTO member_api_tokens (id, data) VALUES (?, ?)").run(record.id, JSON.stringify(record));
    recordActivity(root, member.profile, "member-api-token-minted", "The member minted an API token named " + clean);
    return { token: raw, view: { id: record.id, name: record.name, createdAt: record.createdAt } };
  } catch (error) { failMemberStore(root, "write", error); }
  finally { db.close(); }
}
export function listApiTokens(root: string, member: Member): MemberApiTokenView[] {
  if (!storeExists(root)) return [];
  const db = openMembersGuarded(root, "read");
  try {
    const rows = db.prepare("SELECT data FROM member_api_tokens ORDER BY rowid").all() as Array<{ data: string }>;
    const out: MemberApiTokenView[] = [];
    for (const row of rows) {
      try { const t = JSON.parse(row.data) as MemberApiToken; if (t.memberId === member.id) out.push({ id: t.id, name: t.name, createdAt: t.createdAt }); } catch { /* torn row */ }
    }
    return out;
  } catch (error) { failMemberStore(root, "read", error); }
  finally { db.close(); }
}
export function revokeApiToken(root: string, member: Member, id: string): boolean {
  if (!storeExists(root)) return false;
  const db = openMembersGuarded(root, "write");
  try {
    const row = db.prepare("SELECT data FROM member_api_tokens WHERE id = ?").get(id) as { data: string } | undefined;
    if (!row) return false;
    let t: MemberApiToken | null = null;
    try { t = JSON.parse(row.data) as MemberApiToken; } catch { t = null; }
    if (!t || t.memberId !== member.id) return false;
    db.prepare("DELETE FROM member_api_tokens WHERE id = ?").run(id);
    recordActivity(root, member.profile, "member-api-token-revoked", "The member revoked an API token named " + t.name);
    return true;
  } catch (error) { failMemberStore(root, "write", error); }
  finally { db.close(); }
}
export function memberForApiToken(root: string, raw: string): Member | null {
  if (!/^sam_[0-9a-f]{48}$/.test(raw ?? "") || !storeExists(root)) return null;
  const db = openMembersGuarded(root, "read");
  try {
    const rows = db.prepare("SELECT data FROM member_api_tokens").all() as Array<{ data: string }>;
    for (const row of rows) {
      let t: MemberApiToken | null = null;
      try { t = JSON.parse(row.data) as MemberApiToken; } catch { t = null; }
      if (!t) continue;
      const stored = Buffer.from(t.hash, "hex");
      const wanted = Buffer.from(hashToken(raw), "hex");
      if (stored.length === wanted.length && timingSafeEqual(stored, wanted)) {
        const member = findMemberRow(db, t.memberId);
        return member && member.status === "active" ? member : null;
      }
    }
    return null;
  } catch (error) { failMemberStore(root, "read", error); }
  finally { db.close(); }
}
export interface SetMemberKeyInput { apiKey: string; kind?: "minimax" | "custom"; endpoint?: string; model?: string }
/** Store the member's own model key in the vault, scoped to their
 *  account, and record the routing facts (endpoint + model - never
 *  the key) on the member record. The value is never returned,
 *  never logged, and leaves the vault only inside a model request
 *  on this member's own turns. */
export function setMemberKey(root: string, member: Member, input: SetMemberKeyInput): MemberView {
  if (member.status !== "active") throw new Error("Account is disabled");
  const kind = input.kind === "custom" ? "custom" : "minimax";
  let endpoint = MINIMAX_CHAT_ENDPOINT;
  let model = MINIMAX_DEFAULT_MODEL;
  if (kind === "custom") {
    endpoint = assertChatCompletionsUrl((input.endpoint ?? "").trim());
    model = (input.model ?? "").trim();
    if (!MODEL_RE.test(model)) throw new Error("Invalid model name");
  } else if (input.model && input.model.trim()) {
    const supplied = input.model.trim();
    // Only a model on the current MiniMax list is stored as-is.
    // Anything else (the "Minimax" provider label, a retired or
    // mistyped name) normalizes to the default: an unusable model
    // string makes the API reject every turn with a 400, so it is
    // never stored.
    if (MINIMAX_MODELS.includes(supplied)) model = supplied;
  }
  const keyName = memberKeyName(member);
  let host = "";
  try { host = new URL(endpoint).hostname; } catch { host = ""; }
  setVaultCredential(root, "member-door", keyName, input.apiKey, {
    purpose: "Model key for member profile " + member.profile + " (their own key, spent only on their turns)",
    hosts: host ? [host] : [],
  });
  const next: Member = { ...member, provider: { kind, endpoint, model }, keyName };
  const db = openMembersGuarded(root, "write");
  try { saveMemberRow(db, next); }
  catch (error) { failMemberStore(root, "write", error); }
  finally { db.close(); }
  recordActivity(root, member.profile, "member-key-set", "The member added their own model key (" + kind + ", model " + model + ")");
  return memberView(root, next);
}
export function removeMemberKey(root: string, member: Member): MemberView {
  if (member.keyName) removeVaultCredential(root, "member-door", member.keyName);
  const next: Member = { ...member, provider: null, keyName: null };
  const db = openMembersGuarded(root, "write");
  try { saveMemberRow(db, next); }
  catch (error) { failMemberStore(root, "write", error); }
  finally { db.close(); }
  recordActivity(root, member.profile, "member-key-removed", "The member removed their model key");
  return memberView(root, next);
}

// --- The voice key: a second, separate key slot ---------------------
// Real-time voice rides OpenAI's Realtime API, so a member who
// wants to TALK to their SAM brings an OpenAI key alongside their
// chat key (Dip ruling 2026-11-16: "real time voice with their
// chat GPT token at least"). Same posture as the chat key, its own
// vault credential: stored under its own name, never returned,
// never logged, and it leaves the vault only inside the door's
// server-side call that mints a short-lived voice session secret
// (member-voice.ts). The browser never sees this key - it receives
// only the ephemeral secret the mint hands back.

export function setMemberVoiceKey(root: string, member: Member, apiKey: string): MemberView {
  if (member.status !== "active") throw new Error("Account is disabled");
  const value = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!value) throw new Error("Paste your OpenAI key first.");
  const voiceKeyName = memberVoiceKeyName(member);
  setVaultCredential(root, "member-door", voiceKeyName, value, {
    purpose: "OpenAI voice key for member profile " + member.profile + " (real-time voice sessions, spent only on their calls)",
    hosts: ["api.openai.com"],
  });
  const next: Member = { ...member, voiceKeyName };
  const db = openMembersGuarded(root, "write");
  try { saveMemberRow(db, next); }
  catch (error) { failMemberStore(root, "write", error); }
  finally { db.close(); }
  recordActivity(root, member.profile, "member-voice-key-set", "The member added their OpenAI voice key");
  return memberView(root, next);
}
export function removeMemberVoiceKey(root: string, member: Member): MemberView {
  if (member.voiceKeyName) removeVaultCredential(root, "member-door", member.voiceKeyName);
  const next: Member = { ...member, voiceKeyName: null };
  const db = openMembersGuarded(root, "write");
  try { saveMemberRow(db, next); }
  catch (error) { failMemberStore(root, "write", error); }
  finally { db.close(); }
  recordActivity(root, member.profile, "member-voice-key-removed", "The member removed their OpenAI voice key");
  return memberView(root, next);
}

/** The connection facts a member turn rides: endpoint + model from
 *  the member record, the key by vault NAME only. Null when the
 *  member cannot think yet (no key) or may not run (disabled). */
export function memberConnection(root: string, member: Member): { endpoint: string; model: string; vaultKey: string } | { unavailable: string } {
  if (member.status !== "active") return { unavailable: "This account is paused. Talk to the operator to turn it back on." };
  if (!member.provider || !member.keyName || !memberHasKey(root, member)) {
    return { unavailable: "SAM cannot think yet: add your key in Settings and SAM will be ready." };
  }
  if (!getVaultCredentialValue(root, member.keyName)) {
    return { unavailable: "SAM cannot think yet: add your key in Settings and SAM will be ready." };
  }
  return { endpoint: member.provider.endpoint, model: member.provider.model, vaultKey: member.keyName };
}

/** Why this member's SAM cannot think right now, in the plain
 *  words the member reads - or null when it can think. One source
 *  for the door's direct answer and every surface that explains
 *  the state; the router (failover.ts) carries the same words on
 *  its unavailable routes for turns that arrive by other paths. */
export function memberThinkBlock(root: string, member: Member, env: NodeJS.ProcessEnv = process.env): string | null {
  if (member.status !== "active") return "This account is paused. Talk to the operator to turn it back on.";
  if (member.keySource === "managed") {
    if (!managedConfig(env).enabled) return "Running on our key is not open yet. Add your own key and SAM is ready today.";
    if (memberManagedStatus(root, member, env).spent) return "Today's included usage is used up. Add your own key to keep going, or come back tomorrow.";
    return null;
  }
  const conn = memberConnection(root, member);
  return "unavailable" in conn ? conn.unavailable : null;
}

/** The operator kill switch for the whole member door: an env flag
 *  or a flag file the operator can touch without a deploy. */
export function memberDoorPaused(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SAM_MEMBER_DOOR_OFF === "1") return true;
  return existsSync(join(resolve(root), ".sam", "member-door.off"));
}
