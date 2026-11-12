import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { exchangeCodexCode, refreshCodexAccess, startCodexDevice, startCodexLogin, codexAuthState, CODEX_CLIENT_ID } from "./codex-auth.js";
import { authStatus } from "./auth-status.js";

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-codex-")); }

// POSIX mode 0600 is not a Windows fact: the same write lands, but
// stat mode bits are not owner-only there. The assertion is gated
// on the platform argument so a Linux run can prove the win32 skip.
function assertOwnerMode(file: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  assert.equal(statSync(file).mode & 0o777, 0o600);
}

test("codex login prints a ChatGPT authorize URL and stores only the pending verifier", () => {
  const root = scratch();
  try {
    const started = startCodexLogin(root);
    const url = new URL(started.url);
    assert.equal(url.origin + url.pathname, "https://auth.openai.com/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), CODEX_CLIENT_ID);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("state"), started.state);
    assert.ok(url.searchParams.get("code_challenge"));
    const pendingFile = join(root, ".sam", "codex-pending.json");
    assertOwnerMode(pendingFile);
    const state = codexAuthState(root);
    assert.equal(state.pending, true);
    assert.equal(state.loggedIn, false);
    assert.equal(state.flow, "chatgpt-oauth");
    assert.ok(!JSON.stringify(state).includes("verifier"));
    const raw = readFileSync(pendingFile, "utf8");
    assert.ok(raw.includes("verifier"));
    assert.equal(authStatus(root, { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/no", SAM_GOG_BIN: "/no" }).codex.pending, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("codex exchange stores tokens at 0600 and refresh is single-flight", async () => {
  const root = scratch();
  try {
    const started = startCodexLogin(root);
    let exchanges = 0;
    const state = await exchangeCodexCode(root, "auth-code", started.state, {
      now: 1_700_000_000_000,
      fetchImpl: async () => {
        exchanges++;
        return new Response(JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 30 }), { status: 200 });
      },
    });
    assert.equal(exchanges, 1);
    assert.equal(state.loggedIn, true);
    assert.equal(state.pending, false);
    const tokenFile = join(root, ".sam", "codex-tokens.json");
    assertOwnerMode(tokenFile);
    const status = codexAuthState(root);
    assert.ok(!JSON.stringify(status).includes("access-secret"));
    assert.ok(!JSON.stringify(status).includes("refresh-secret"));
    let refreshes = 0;
    const fetchImpl: typeof fetch = async () => {
      refreshes++;
      await new Promise(r => setTimeout(r, 30));
      return new Response(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }), { status: 200 });
    };
    const now = Date.parse(status.expiresAt!) + 120_000;
    const [a, b] = await Promise.all([
      refreshCodexAccess(root, { fetchImpl, now }),
      refreshCodexAccess(root, { fetchImpl, now }),
    ]);
    assert.equal(refreshes, 1, "concurrent refreshes share one token request");
    assert.equal(a.refreshed || b.refreshed, true);
    assert.equal(a.refreshed && b.refreshed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("device start reads a verification URL from the token endpoint response and does not run on login", async () => {
  let called = 0;
  const started = await startCodexDevice(async () => {
    called++;
    return new Response(JSON.stringify({ verification_uri: "https://auth.openai.com/codex/device", user_code: "ABCD-EFGH", device_code: "dev" }), { status: 200 });
  });
  assert.equal(called, 1);
  assert.equal(started.verificationUri, "https://auth.openai.com/codex/device");
  assert.equal(started.userCode, "ABCD-EFGH");
});

test("CLI: sam codex login prints the auth URL and does not create a token file", () => {
  const root = scratch();
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  try {
    const run = spawnSync(process.execPath, [cli, "--workspace", root, "codex", "login"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
    assert.match(run.stdout, /code_challenge=/);
    assert.equal(codexAuthState(root).pending, true);
    assert.equal(codexAuthState(root).loggedIn, false);
    const status = spawnSync(process.execPath, [cli, "--workspace", root, "--json", "codex", "status"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.loggedIn, false);
    assert.ok(!status.stdout.includes("verifier"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("codex 0600 mode assertion is skipped on win32", () => {
  const root = scratch();
  try {
    const file = join(root, "wide.json");
    writeFileSync(file, "{}");
    if (process.platform !== "win32") chmodSync(file, 0o644);
    assert.doesNotThrow(() => assertOwnerMode(file, "win32"));
    if (process.platform !== "win32") assert.throws(() => assertOwnerMode(file, "linux"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
