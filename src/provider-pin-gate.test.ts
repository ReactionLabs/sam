import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { addProvider, providerPinBlocker } from "./providers.js";
import { addFallbackRoute, fallbackRoutes } from "./failover.js";
import { ChatStore } from "./chats.js";

// The provider pin gate: two doors named a provider
// against the configured provider registry and each
// improvised the same refusal ("Unknown provider \"X\".
// Configured providers: <ids>") with no fold correction -
// the CLI agents set-provider door inline in cli.ts, and
// failover's validateRoute, which addFallbackRoute /
// updateFallbackRoutes and the ONE gate's failover
// proposal validation ride. providerPinBlocker in
// providers.ts is now the ONE source carrying the refusal
// text (the connectorPinBlocker pattern in connectors.ts):
// the registry listed, a fold correction when exactly one
// configured id matches folded for case and separators.
// Both doors throw it before anything is pinned or
// routed. The ChatStore provider setter and
// resolveTurnConnection stay permissive by design and are
// NOT gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-provider-pin-gate-")); }

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "x", OPENAI_API_KEY: "y", ...extra };
}

function addOpenAi(root: string, e: NodeJS.ProcessEnv): void {
  addProvider(root, { id: "openai", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", model: "gpt-4.1" }, e);
}

test("provider pin gate: a configured provider id and an empty value read no blocker", () => {
  const root = fresh();
  const e = env();
  try {
    addOpenAi(root, e);
    assert.equal(providerPinBlocker(root, "openai", e), null);
    assert.equal(providerPinBlocker(root, "minimax", e), null);
    assert.equal(providerPinBlocker(root, null, e), null);
    assert.equal(providerPinBlocker(root, "", e), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider pin gate: an unknown provider refuses in the ONE source's words, naming the configured providers", () => {
  const root = fresh();
  const e = env();
  try {
    addOpenAi(root, e);
    assert.equal(
      providerPinBlocker(root, "nope", e),
      "Unknown provider \"nope\" in provider pin. Configured providers: minimax, openai",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider pin gate: a folded provider id refuses with the correction", () => {
  const root = fresh();
  const e = env();
  try {
    addOpenAi(root, e);
    assert.equal(
      providerPinBlocker(root, "Open AI", e),
      "Unknown provider \"Open AI\" in provider pin. Configured providers: minimax, openai. Did you mean \"openai\"?",
    );
    assert.equal(
      providerPinBlocker(root, "MINIMAX", e),
      "Unknown provider \"MINIMAX\" in provider pin. Configured providers: minimax, openai. Did you mean \"minimax\"?",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider pin gate: an ambiguous fold names no correction", () => {
  const root = fresh();
  const e = env();
  try {
    addOpenAi(root, e);
    addProvider(root, { id: "open-ai", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", model: "gpt-4.1" }, e);
    assert.equal(
      providerPinBlocker(root, "Open AI", e),
      "Unknown provider \"Open AI\" in provider pin. Configured providers: minimax, openai, open-ai",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider pin gate: the failover door throws the ONE source before routing anything, and a passing route still adds", () => {
  const root = fresh();
  const e = env();
  try {
    addOpenAi(root, e);
    assert.throws(
      () => addFallbackRoute(root, "sam", { provider: "open-ai", model: "gpt-4.1" }, e),
      new Error("Unknown provider \"open-ai\" in provider pin. Configured providers: minimax, openai. Did you mean \"openai\"?"),
    );
    // A malformed id still dies on the shape check in front of the blocker.
    assert.throws(
      () => addFallbackRoute(root, "sam", { provider: "Open AI", model: "gpt-4.1" }, e),
      new Error("Invalid provider id"),
    );
    assert.deepEqual(fallbackRoutes(root, "sam"), []);
    assert.deepEqual(addFallbackRoute(root, "sam", { provider: "openai", model: "gpt-4.1" }, e), [{ provider: "openai", model: "gpt-4.1" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider pin gate: the CLI set-provider door throws the ONE source before re-pinning anything", () => {
  const root = fresh();
  const e = env();
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "--workspace", root, "--json", ...args], { encoding: "utf8", env: e });
  try {
    addOpenAi(root, e);
    const db = new ChatStore(root);
    try { db.createAgent("trading", "Trade desk."); } finally { db.close(); }
    const refused = run("agents", "set-provider", "trading", "Open AI");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Unknown provider "Open AI" in provider pin\. Configured providers: minimax, openai\. Did you mean "openai"\?/);
    const db2 = new ChatStore(root);
    try { assert.equal(db2.agents().find(a => a.name === "trading")?.provider ?? null, null); } finally { db2.close(); }
    const pinned = run("agents", "set-provider", "trading", "openai");
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal(JSON.parse(pinned.stdout).provider, "openai");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
