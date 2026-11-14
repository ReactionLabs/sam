import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile, readWorkspaceEnv, loadWorkspaceEnv, writeWorkspaceEnv, runSetup, type SetupIo } from "./setup.js";
import { readSetupRecord } from "./config-wizard.js";

// Program B (cold install): the workspace env file is the one
// configuration mechanism a fresh install has. These tests pin its
// contract: parsing, load precedence (the real environment wins),
// 0600 storage, verify-before-write, and absolute secret hygiene in
// everything setup prints. Env is built per test (never inherited).
function bareEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/nonexistent/claude", SAM_GOG_BIN: "/nonexistent/gog", ...extra };
}
function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-setup-")); }

const FAKE_KEY = "<redacted>";

function scriptedIo(answers: string[], secret: string): { io: SetupIo; printed: string[] } {
  const printed: string[] = [];
  const queue = [...answers];
  return {
    printed,
    io: {
      print: (line: string) => { printed.push(line); },
      ask: async () => queue.shift() ?? "",
      askSecret: async () => secret,
    },
  };
}

test("parseEnvFile: comments, blanks, export prefix, quotes, and garbage lines", () => {
  const parsed = parseEnvFile([
    "# a comment",
    "",
    "SAM_MODEL_PROVIDER=minimax",
    "export SAM_MODEL=MiniMax-M2.5",
    'MINIMAX_API_KEY="quoted value"',
    "SINGLE='sq value'",
    "not a line",
    "1BAD=nope",
    "EMPTY=",
  ].join("\n"));
  assert.deepEqual(parsed, {
    SAM_MODEL_PROVIDER: "minimax",
    SAM_MODEL: "MiniMax-M2.5",
    MINIMAX_API_KEY: "quoted value",
    SINGLE: "sq value",
    EMPTY: "",
  });
});

test("loadWorkspaceEnv: fills only what the real environment lacks", () => {
  const root = scratch();
  try {
    writeWorkspaceEnv(root, { SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: FAKE_KEY });
    const env = bareEnv({ SAM_MODEL: "Real-Env-Model" });
    const loaded = loadWorkspaceEnv(root, env);
    assert.deepEqual(loaded.sort(), ["MINIMAX_API_KEY", "SAM_MODEL_PROVIDER"]);
    assert.equal(env.SAM_MODEL, "Real-Env-Model");
    assert.equal(env.MINIMAX_API_KEY, FAKE_KEY);
    // No file at all loads nothing and does not throw.
    assert.deepEqual(loadWorkspaceEnv(join(root, "missing"), bareEnv()), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("writeWorkspaceEnv: owner-only permissions and a round-trip read", () => {
  const root = scratch();
  try {
    const file = writeWorkspaceEnv(root, { SAM_MODEL: "MiniMax-M2.5" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readWorkspaceEnv(root), { SAM_MODEL: "MiniMax-M2.5" });
    // Rewriting a loose-permission file tightens it back to 0600.
    writeFileSync(file, "SAM_MODEL=MiniMax-M2.5\n", { mode: 0o644 });
    writeWorkspaceEnv(root, { SAM_MODEL: "MiniMax-M2.5" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runSetup: a verified key is written to sam.env at 0600, the baseline is recorded, and the key is never printed", async () => {
  const root = scratch();
  try {
    const { io, printed } = scriptedIo(["", ""], FAKE_KEY);
    const result = await runSetup(root, io, { env: bareEnv(), completer: async () => "ready" });
    assert.equal(result.status, "configured");
    const file = join(root, "sam.env");
    assert.equal(existsSync(file), true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const stored = readWorkspaceEnv(root);
    assert.equal(stored?.SAM_MODEL_PROVIDER, "minimax");
    assert.equal(stored?.SAM_MODEL, "MiniMax-M2.5");
    assert.equal(stored?.MINIMAX_API_KEY, FAKE_KEY);
    assert.ok(readSetupRecord(root), "verified setup baseline recorded");
    assert.ok(printed.some(l => l.includes("dashboard")), "next steps name the dashboard");
    assert.ok(printed.some(l => l.includes("chats send")), "next steps name the first chat");
    assert.ok(!printed.join("\n").includes(FAKE_KEY), "setup output never contains the key");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runSetup: a key that fails verification writes nothing at all", async () => {
  const root = scratch();
  try {
    const { io, printed } = scriptedIo(["", ""], FAKE_KEY);
    const result = await runSetup(root, io, {
      env: bareEnv(),
      completer: async () => { throw new Error("HTTP 401"); },
    });
    assert.equal(result.status, "verify-failed");
    assert.equal(existsSync(join(root, "sam.env")), false);
    assert.equal(readSetupRecord(root), null);
    assert.ok(!printed.join("\n").includes(FAKE_KEY));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runSetup: a failed reconfigure never clobbers a working sam.env", async () => {
  const root = scratch();
  try {
    writeWorkspaceEnv(root, { SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "the-good-key" });
    const { io } = scriptedIo([], "the-bad-key");
    const result = await runSetup(root, io, {
      env: bareEnv(),
      force: true,
      completer: async () => { throw new Error("HTTP 401"); },
    });
    assert.equal(result.status, "verify-failed");
    assert.equal(readWorkspaceEnv(root)?.MINIMAX_API_KEY, "the-good-key");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runSetup: --key-env takes the key from the environment and never prompts", async () => {
  const root = scratch();
  try {
    const io: SetupIo = {
      print: () => {},
      ask: async () => { throw new Error("must not prompt for answers in key-env mode"); },
      askSecret: async () => { throw new Error("must not prompt for the key in key-env mode"); },
    };
    const result = await runSetup(root, io, {
      env: bareEnv({ WALK_KEY: FAKE_KEY }),
      keyEnv: "WALK_KEY",
      provider: "minimax",
      model: "MiniMax-M2.5",
      completer: async () => "ready",
    });
    assert.equal(result.status, "configured");
    assert.equal(readWorkspaceEnv(root)?.MINIMAX_API_KEY, FAKE_KEY);
    // A named env var that is missing aborts without writing.
    const root2 = scratch();
    try {
      const aborted = await runSetup(root2, io, { env: bareEnv(), keyEnv: "WALK_KEY", provider: "minimax", model: "MiniMax-M2.5", completer: async () => "ready" });
      assert.equal(aborted.status, "aborted");
      assert.equal(existsSync(join(root2, "sam.env")), false);
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runSetup: an existing sam.env without force offers reconfigure and changes nothing when declined", async () => {
  const root = scratch();
  try {
    writeWorkspaceEnv(root, { SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "the-good-key" });
    const before = readFileSync(join(root, "sam.env"), "utf8");
    const { io } = scriptedIo(["n"], "some-other-key");
    const result = await runSetup(root, io, { env: bareEnv(), completer: async () => "ready" });
    assert.equal(result.status, "already-configured");
    assert.equal(readFileSync(join(root, "sam.env"), "utf8"), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
