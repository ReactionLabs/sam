import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Codex OAuth (sprint item 5). This is the ChatGPT-backend login the
// Codex CLI uses, not an OpenAI API key. SAM stores tokens in the
// workspace credential file with mode 0600 and never prints them.
// `sam codex login` only prints the authorization URL. Completing the
// browser login needs the owner present, so this module stops there
// unless a test (or a later owner session) hands it an authorization code.

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_DEVICE_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
export const CODEX_SCOPE = "openid profile email offline_access";

export interface CodexLogin {
  url: string;
  state: string;
  redirectUri: string;
}

export interface CodexAuthState {
  flow: "chatgpt-oauth";
  loggedIn: boolean;
  pending: boolean;
  expiresAt: string | null;
}

interface PendingLogin { state: string; verifier: string; redirectUri: string; createdAt: string }
interface StoredTokens { accessToken: string; refreshToken: string; expiresAt: string; obtainedAt: string }

function b64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
function samDir(root: string): string { return join(resolve(root), ".sam"); }
function pendingPath(root: string): string { return join(samDir(root), "codex-pending.json"); }
function tokenPath(root: string): string { return join(samDir(root), "codex-tokens.json"); }
function lockPath(root: string): string { return join(samDir(root), "codex-refresh.lock"); }

function writeSecret(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}
function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return null; }
}

export function buildCodexAuthorizeUrl(input: { state: string; challenge: string; redirectUri?: string }): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: input.redirectUri ?? CODEX_REDIRECT_URI,
    scope: CODEX_SCOPE,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "sam",
  });
  return CODEX_AUTHORIZE_URL + "?" + params.toString();
}

// No network. The owner opens the URL.
export function startCodexLogin(root: string): CodexLogin {
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const pending: PendingLogin = { state, verifier, redirectUri: CODEX_REDIRECT_URI, createdAt: new Date().toISOString() };
  writeSecret(pendingPath(root), pending);
  return { url: buildCodexAuthorizeUrl({ state, challenge }), state, redirectUri: CODEX_REDIRECT_URI };
}

export function codexAuthState(root: string): CodexAuthState {
  const pending = readJson<PendingLogin>(pendingPath(root));
  const tokens = readJson<StoredTokens>(tokenPath(root));
  const loggedIn = !!tokens?.accessToken && !!tokens?.refreshToken && !!tokens?.expiresAt;
  return { flow: "chatgpt-oauth", loggedIn, pending: !!pending?.state && !!pending?.verifier, expiresAt: loggedIn ? tokens!.expiresAt : null };
}

export interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; error?: string }

function storeFromResponse(body: TokenResponse, previousRefresh: string | null, now: number): StoredTokens {
  if (!body.access_token || typeof body.access_token !== "string") throw new Error("Codex token response had no access token");
  const refresh = body.refresh_token || previousRefresh;
  if (!refresh) throw new Error("Codex token response had no refresh token");
  const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return { accessToken: body.access_token, refreshToken: refresh, expiresAt: new Date(now + seconds * 1000).toISOString(), obtainedAt: new Date(now).toISOString() };
}

async function postForm(url: string, fields: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const body = await response.json() as TokenResponse;
  if (!response.ok) throw new Error("Codex token request failed (HTTP " + response.status + ")");
  return body;
}

// Used when the owner pastes a code, and by tests with a fake token endpoint.
export async function exchangeCodexCode(root: string, code: string, state: string, opts?: { fetchImpl?: typeof fetch; now?: number }): Promise<CodexAuthState> {
  const pending = readJson<PendingLogin>(pendingPath(root));
  if (!pending) throw new Error("No Codex login is pending. Run `sam codex login` first.");
  if (state !== pending.state) throw new Error("Codex login state did not match");
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const body = await postForm(CODEX_TOKEN_URL, {
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirectUri,
    client_id: CODEX_CLIENT_ID,
    code_verifier: pending.verifier,
  }, fetchImpl);
  writeSecret(tokenPath(root), storeFromResponse(body, null, opts?.now ?? Date.now()));
  rmSync(pendingPath(root), { force: true });
  return codexAuthState(root);
}

let refreshQueue: Promise<unknown> = Promise.resolve();

async function withRefreshLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const run = refreshQueue.then(async () => {
    const lock = lockPath(root);
    mkdirSync(samDir(root), { recursive: true });
    for (let attempt = 0; attempt < 50; attempt++) {
      try { mkdirSync(lock); break; }
      catch { await new Promise(resolveWait => setTimeout(resolveWait, 10)); }
    }
    try { return await fn(); }
    finally { rmSync(lock, { recursive: true, force: true }); }
  });
  refreshQueue = run.then(() => undefined, () => undefined);
  return run;
}

// One refresh at a time. A second caller that arrives while the first
// is in flight waits, then sees the new expiry and does not refresh again.
export async function refreshCodexAccess(root: string, opts?: { fetchImpl?: typeof fetch; now?: number; skewMs?: number }): Promise<{ refreshed: boolean; expiresAt: string }> {
  return withRefreshLock(root, async () => {
    const tokens = readJson<StoredTokens>(tokenPath(root));
    if (!tokens?.refreshToken) throw new Error("Codex is not logged in");
    const now = opts?.now ?? Date.now();
    const skew = opts?.skewMs ?? 60_000;
    if (Date.parse(tokens.expiresAt) - now > skew) return { refreshed: false, expiresAt: tokens.expiresAt };
    const fetchImpl = opts?.fetchImpl ?? fetch;
    const body = await postForm(CODEX_TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: CODEX_CLIENT_ID,
    }, fetchImpl);
    const next = storeFromResponse(body, tokens.refreshToken, now);
    writeSecret(tokenPath(root), next);
    return { refreshed: true, expiresAt: next.expiresAt };
  });
}

// Device-code start. Needs a live POST to obtain the user code, so the
// login command does not call it. Tests pass a fake fetch.
export async function startCodexDevice(fetchImpl: typeof fetch): Promise<{ verificationUri: string; userCode: string }> {
  const { challenge } = pkce();
  const response = await fetchImpl(CODEX_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CODEX_CLIENT_ID, scope: CODEX_SCOPE, code_challenge: challenge, code_challenge_method: "S256" }).toString(),
  });
  const body = await response.json() as { verification_uri?: string; user_code?: string; device_code?: string };
  if (!response.ok || !body.verification_uri || !body.user_code) throw new Error("Codex device authorization did not return a URL");
  return { verificationUri: body.verification_uri, userCode: body.user_code };
}
