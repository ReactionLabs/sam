import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { addProvider } from "./providers.js";
import { addFallbackRoute, clearFallbackRoutes, failoverProfileBlocker, fallbackRoutes } from "./failover.js";

// The profile gate for the failover route doors: every
// profile-naming creation, queue, propose, and
// standing-instruction door reads the profile registry
// before writing anything, and the skill-allowlist pair
// taught the audit that a set without its clear is half a
// sweep - but CLI `agents clear-fallbacks` passed the raw
// name into clearFallbackRoutes with no registry check at
// all, while its pair door `agents add-fallback` checked
// the registry inline. A phantom's cleared:false is
// byte-identical to a real profile with no routes to
// clear, so a folded typo ("Second Shift" for
// "second-shift") silently cleared nothing while the real
// profile's failover routes stood, and the operator could
// not tell the typo from nothing-to-clear.
// failoverProfileBlocker is now the ONE source carrying
// the refusal text: BOTH CLI failover doors throw it
// before adding or clearing anything (the add door's older
// inline check is replaced, so the pair carries one
// refusal). clearFallbackRoutes itself stays permissive
// by design (a profile removed after routes name it keeps
// its stored row, and a later store-level clear under
// that name must still be able to lift it; turnRoutes
// names its profile by construction), so it is NOT gated
// here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-failover-profile-gate-")); }

const ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "k", OPENAI_API_KEY: "o" };

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

function seedProviders(root: string): void {
  addProvider(root, { id: "openai", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", model: "gpt-4.1" }, ENV);
}

test("failover profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(failoverProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(failoverProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failover profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      failoverProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in failover route detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      failoverProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in failover route detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      failoverProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in failover route detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failover profile gate: the door's check clears nothing for a bogus profile", () => {
  const root = fresh();
  try {
    seedProviders(root);
    register(root, "second-shift");
    addFallbackRoute(root, "second-shift", { provider: "openai", model: "gpt-4.1" }, ENV);
    const blocker = failoverProfileBlocker(root, "Second Shift");
    assert.ok(blocker);
    // The door throws this text before calling
    // clearFallbackRoutes; pin that the check alone leaves
    // the real profile's routes standing.
    assert.deepEqual(fallbackRoutes(root, "second-shift"), [{ provider: "openai", model: "gpt-4.1" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failover profile gate: a registered profile passes the check and its clear really clears", () => {
  const root = fresh();
  try {
    seedProviders(root);
    register(root, "second-shift");
    assert.equal(failoverProfileBlocker(root, "second-shift"), null);
    addFallbackRoute(root, "second-shift", { provider: "openai", model: "gpt-4.1" }, ENV);
    assert.equal(clearFallbackRoutes(root, "second-shift"), true);
    assert.deepEqual(fallbackRoutes(root, "second-shift"), []);
    assert.equal(clearFallbackRoutes(root, "second-shift"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failover profile gate: clearFallbackRoutes stays permissive - routes may name a profile removed later", () => {
  const root = fresh();
  try {
    seedProviders(root);
    addFallbackRoute(root, "trading", { provider: "openai", model: "gpt-4.1" }, ENV);
    assert.equal(clearFallbackRoutes(root, "trading"), true);
    assert.deepEqual(fallbackRoutes(root, "trading"), []);
    assert.equal(existsSync(join(root, ".sam", "fallbacks.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
