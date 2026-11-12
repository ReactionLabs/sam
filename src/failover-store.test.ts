import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProvider } from "./providers.js";
import { addFallbackRoute, clearFallbackRoutes, fallbackRoutes, turnRoutes, updateFallbackRoutes, type FallbackRoute } from "./failover.js";

// State convergence (UNIFICATION item 4, twenty-fifth store): the
// failover routes store migrated from whole-file fallbacks.json
// rewrites to one-row-per-profile SQLite. These tests pin the
// migration contract: legacy files import in order with every
// field intact, are renamed (never deleted), a malformed file
// imports nothing and stays put (reading as no fallbacks instead
// of throwing), a pure read creates nothing, single-row mutations
// cannot lose each other, and turn routes resolve through the
// migrated store.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-failover-store-")); }

const ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "k", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" };

function seedProviders(root: string): void {
  addProvider(root, { id: "openai", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", model: "gpt-4.1" }, ENV);
  addProvider(root, { id: "anthropic", endpoint: "https://api.anthropic.com/v1/chat/completions", keyEnv: "ANTHROPIC_API_KEY", model: "claude-x" }, ENV);
}

test("failover store: a legacy fallbacks.json imports per profile in order, fields intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    seedProviders(root);
    mkdirSync(join(root, ".sam"), { recursive: true });
    const samRoutes: FallbackRoute[] = [{ provider: "openai", model: "gpt-4.1" }, { provider: "anthropic", model: "claude-x" }];
    const tradingRoutes: FallbackRoute[] = [{ provider: "anthropic", model: "claude-x" }];
    writeFileSync(join(root, ".sam", "fallbacks.json"), JSON.stringify({ sam: samRoutes, trading: tradingRoutes }, null, 2));
    assert.deepEqual(fallbackRoutes(root, "sam"), samRoutes);
    assert.deepEqual(fallbackRoutes(root, "trading"), tradingRoutes);
    assert.deepEqual(fallbackRoutes(root, "dip"), []);
    assert.equal(existsSync(join(root, ".sam", "fallbacks.db")), true);
    assert.equal(existsSync(join(root, ".sam", "fallbacks.json")), false);
    assert.equal(existsSync(join(root, ".sam", "fallbacks.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "fallbacks.json.migrated"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(kept), ["sam", "trading"]);
    const added = addFallbackRoute(root, "dip", { provider: "openai", model: "gpt-4.1" }, ENV);
    assert.deepEqual(added, [{ provider: "openai", model: "gpt-4.1" }]);
    assert.deepEqual(fallbackRoutes(root, "sam"), samRoutes);
    assert.equal(existsSync(join(root, ".sam", "fallbacks.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failover store: a malformed legacy file imports nothing and is left in place, reading as no fallbacks", () => {
  const root = fresh();
  try {
    seedProviders(root);
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "fallbacks.json"), "{ not json");
    assert.deepEqual(fallbackRoutes(root, "sam"), []);
    assert.equal(existsSync(join(root, ".sam", "fallbacks.json")), true);
    assert.equal(existsSync(join(root, ".sam", "fallbacks.json.migrated")), false);
    writeFileSync(join(root, ".sam", "fallbacks.json"), JSON.stringify(["not", "an", "object"]));
    assert.deepEqual(fallbackRoutes(root, "sam"), []);
    assert.equal(existsSync(join(root, ".sam", "fallbacks.json.migrated")), false);
    // A bad profile entry imports nothing for that profile; a good one still imports.
    writeFileSync(join(root, ".sam", "fallbacks.json"), JSON.stringify({ sam: "nope", trading: [{ provider: "openai", model: "gpt-4.1" }, { provider: 7, model: "x" }, "junk"] }));
    assert.deepEqual(fallbackRoutes(root, "sam"), []);
    assert.deepEqual(fallbackRoutes(root, "trading"), [{ provider: "openai", model: "gpt-4.1" }]);
    assert.equal(existsSync(join(root, ".sam", "fallbacks.json.migrated")), true);
    // A fresh add over an unimportable file still lands in the DB.
    const root2 = fresh();
    try {
      seedProviders(root2);
      mkdirSync(join(root2, ".sam"), { recursive: true });
      writeFileSync(join(root2, ".sam", "fallbacks.json"), "{ not json");
      const added = addFallbackRoute(root2, "sam", { provider: "openai", model: "gpt-4.1" }, ENV);
      assert.deepEqual(added, [{ provider: "openai", model: "gpt-4.1" }]);
      assert.deepEqual(fallbackRoutes(root2, "sam"), [{ provider: "openai", model: "gpt-4.1" }]);
      assert.equal(existsSync(join(root2, ".sam", "fallbacks.json")), true);
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failover store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(fallbackRoutes(root, "sam"), []);
    assert.equal(clearFallbackRoutes(root, "sam"), false);
    assert.equal(updateFallbackRoutes(root, "sam", [{ provider: "openai", model: "gpt-4.1" }], ENV), null);
    assert.equal(existsSync(join(root, ".sam", "fallbacks.db")), false);
    assert.equal(existsSync(join(root, ".sam", "fallbacks.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failover store: interleaved add, update, and clear all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    seedProviders(root);
    addFallbackRoute(root, "sam", { provider: "openai", model: "gpt-4.1" }, ENV);
    addFallbackRoute(root, "trading", { provider: "anthropic", model: "claude-x" }, ENV);
    // A duplicate add is a no-op for that profile only.
    assert.deepEqual(addFallbackRoute(root, "sam", { provider: "openai", model: "gpt-4.1" }, ENV), [{ provider: "openai", model: "gpt-4.1" }]);
    const replaced = updateFallbackRoutes(root, "sam", [{ provider: "anthropic", model: "claude-x" }, { provider: "openai", model: "gpt-4.1" }], ENV);
    assert.deepEqual(replaced, [{ provider: "anthropic", model: "claude-x" }, { provider: "openai", model: "gpt-4.1" }]);
    assert.deepEqual(fallbackRoutes(root, "trading"), [{ provider: "anthropic", model: "claude-x" }]);
    assert.equal(updateFallbackRoutes(root, "ghost", [{ provider: "openai", model: "gpt-4.1" }], ENV), null);
    assert.throws(() => updateFallbackRoutes(root, "sam", [{ provider: "nope", model: "x" }], ENV), /Unknown provider/);
    assert.throws(() => addFallbackRoute(root, "sam", { provider: "openai", model: "bad model!" }, ENV), /Invalid model/);
    // Cap: sam already holds 2, two more fit, the fifth refuses.
    addFallbackRoute(root, "sam", { provider: "openai", model: "gpt-4.1-mini" }, ENV);
    addFallbackRoute(root, "sam", { provider: "anthropic", model: "claude-y" }, ENV);
    assert.equal(fallbackRoutes(root, "sam").length, 4);
    assert.throws(() => addFallbackRoute(root, "sam", { provider: "openai", model: "gpt-5" }, ENV), /Fallback limit reached \(4\)/);
    assert.equal(clearFallbackRoutes(root, "trading"), true);
    assert.equal(clearFallbackRoutes(root, "trading"), false);
    assert.deepEqual(fallbackRoutes(root, "trading"), []);
    assert.equal(fallbackRoutes(root, "sam").length, 4);
    // Empty update deletes the row.
    assert.deepEqual(updateFallbackRoutes(root, "sam", [], ENV), []);
    assert.deepEqual(fallbackRoutes(root, "sam"), []);
    assert.equal(clearFallbackRoutes(root, "sam"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failover store: turn routes resolve through the migrated store and a clear stays cleared", () => {
  const root = fresh();
  try {
    seedProviders(root);
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "fallbacks.json"), JSON.stringify({ sam: [{ provider: "openai", model: "gpt-4.1" }] }, null, 2));
    const routes = turnRoutes(root, ENV, "sam", null, "chat");
    assert.deepEqual(routes.map(r => r.providerId), ["minimax", "openai"]);
    assert.equal(routes[1].model, "gpt-4.1");
    assert.equal(clearFallbackRoutes(root, "sam"), true);
    const after = turnRoutes(root, ENV, "sam", null, "chat");
    assert.deepEqual(after.map(r => r.providerId), ["minimax"]);
    assert.equal(existsSync(join(root, ".sam", "fallbacks.json")), false);
    assert.equal(existsSync(join(root, ".sam", "fallbacks.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
