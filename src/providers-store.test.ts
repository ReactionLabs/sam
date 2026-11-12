import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProvider, listProviders, readFileProviders, removeProvider, resolveTurnConnection, updateProvider, type FileProvider } from "./providers.js";

// State convergence (UNIFICATION item 4, twenty-fourth store): the
// provider registry migrated from whole-file providers.json rewrites
// to one-row-per-provider SQLite. These tests pin the migration
// contract: legacy files import in order with every field intact,
// are renamed (never deleted), a malformed or over-cap file imports
// nothing and stays put (reading as no file providers instead of
// throwing), a pure read creates nothing, single-row mutations
// cannot lose each other, and a pinned connection still resolves
// through the migrated store.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-providers-store-")); }

const ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "k" };

function legacyProvider(id: string, deepModel: string | null): FileProvider {
  return {
    id,
    endpoint: "https://api." + id + ".example/v1/chat/completions",
    keyEnv: (id.toUpperCase().replace(/-/g, "_")) + "_API_KEY",
    model: id + "-base",
    cheapModel: id + "-mini",
    deepModel,
  };
}

test("providers store: a legacy providers.json imports in order, fields intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const first = legacyProvider("alpha", "alpha-deep");
    const second = legacyProvider("beta", null);
    writeFileSync(join(root, ".sam", "providers.json"), JSON.stringify([first, second], null, 2));
    assert.deepEqual(readFileProviders(root), [first, second]);
    assert.deepEqual(listProviders(root, ENV).map(p => p.id), ["minimax", "alpha", "beta"]);
    assert.equal(existsSync(join(root, ".sam", "providers.db")), true);
    assert.equal(existsSync(join(root, ".sam", "providers.json")), false);
    assert.equal(existsSync(join(root, ".sam", "providers.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "providers.json.migrated"), "utf8")) as unknown[];
    assert.equal(kept.length, 2);
    addProvider(root, { id: "gamma", endpoint: "https://api.gamma.example/v1/chat/completions", keyEnv: "GAMMA_API_KEY", model: "gamma-base" }, ENV);
    assert.deepEqual(readFileProviders(root).map(p => p.id), ["alpha", "beta", "gamma"]);
    assert.equal(existsSync(join(root, ".sam", "providers.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("providers store: a malformed or over-cap legacy file imports nothing and is left in place", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "providers.json"), "{ not json");
    assert.deepEqual(readFileProviders(root), []);
    assert.deepEqual(listProviders(root, ENV).map(p => p.id), ["minimax"]);
    assert.equal(existsSync(join(root, ".sam", "providers.json")), true);
    assert.equal(existsSync(join(root, ".sam", "providers.json.migrated")), false);
    writeFileSync(join(root, ".sam", "providers.json"), JSON.stringify({ id: "x" }));
    assert.deepEqual(readFileProviders(root), []);
    assert.equal(existsSync(join(root, ".sam", "providers.json.migrated")), false);
    const over: FileProvider[] = [];
    for (let i = 0; i < 17; i++) over.push(legacyProvider("p" + String(i).padStart(2, "0"), null));
    writeFileSync(join(root, ".sam", "providers.json"), JSON.stringify(over));
    assert.deepEqual(readFileProviders(root), []);
    assert.equal(existsSync(join(root, ".sam", "providers.json.migrated")), false);
    const added = addProvider(root, { id: "solo", endpoint: "https://api.solo.example/v1/chat/completions", keyEnv: "SOLO_API_KEY", model: "solo-base" }, ENV);
    assert.equal(added.source, "file");
    assert.deepEqual(readFileProviders(root).map(p => p.id), ["solo"]);
    assert.equal(existsSync(join(root, ".sam", "providers.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("providers store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.deepEqual(readFileProviders(root), []);
    assert.deepEqual(listProviders(root, ENV).map(p => p.id), ["minimax"]);
    assert.equal(updateProvider(root, "nope", { model: "x-base" }, ENV), null);
    assert.equal(removeProvider(root, "nope"), false);
    assert.equal(existsSync(join(root, ".sam", "providers.db")), false);
    assert.equal(existsSync(join(root, ".sam", "providers.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("providers store: interleaved add, update, and remove all survive (no whole-file lost update)", () => {
  const root = fresh();
  try {
    addProvider(root, { id: "alpha", endpoint: "https://api.alpha.example/v1/chat/completions", keyEnv: "ALPHA_API_KEY", model: "alpha-base", cheapModel: "alpha-mini" }, ENV);
    addProvider(root, { id: "beta", endpoint: "https://api.beta.example/v1/chat/completions", keyEnv: "BETA_API_KEY", model: "beta-base" }, ENV);
    const patched = updateProvider(root, "alpha", { endpoint: "https://api2.alpha.example/v1/chat/completions", deepModel: "alpha-deep" }, ENV);
    assert.equal(patched?.endpoint, "https://api2.alpha.example/v1/chat/completions");
    assert.equal(patched?.deepModel, "alpha-deep");
    assert.equal(patched?.cheapModel, "alpha-mini");
    assert.equal(patched?.model, "alpha-base");
    const cleared = updateProvider(root, "alpha", { deepModel: null }, ENV);
    assert.equal(cleared?.deepModel, null);
    assert.equal(updateProvider(root, "ghost", { model: "x-base" }, ENV), null);
    assert.throws(() => updateProvider(root, "alpha", { keyEnv: "sk-not-a-name" }, ENV), /keyEnv/);
    assert.equal(removeProvider(root, "beta"), true);
    assert.equal(removeProvider(root, "beta"), false);
    assert.deepEqual(readFileProviders(root).map(p => p.id), ["alpha"]);
    assert.equal(readFileProviders(root)[0].endpoint, "https://api2.alpha.example/v1/chat/completions");
    assert.throws(() => addProvider(root, { id: "alpha", endpoint: "https://api.alpha.example/v1/chat/completions", keyEnv: "ALPHA_API_KEY", model: "alpha-base" }, ENV), /already exists/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("providers store: a pinned connection resolves through the migrated store and a removal stays removed", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacy = legacyProvider("legacy", "legacy-deep");
    writeFileSync(join(root, ".sam", "providers.json"), JSON.stringify([legacy], null, 2));
    const before = resolveTurnConnection(root, { ...ENV, LEGACY_API_KEY: "k" }, { provider: "legacy", model: null }, "chat");
    assert.equal(before.providerId, "legacy");
    assert.equal(before.endpoint, legacy.endpoint);
    assert.equal(before.keyEnv, "LEGACY_API_KEY");
    assert.equal(before.key, "present");
    const patched = updateProvider(root, "legacy", { model: "legacy-v2" }, ENV);
    assert.equal(patched?.model, "legacy-v2");
    const after = resolveTurnConnection(root, ENV, { provider: "legacy", model: null }, "chat");
    assert.equal(after.model, "legacy-v2");
    assert.equal(removeProvider(root, "legacy"), true);
    const gone = resolveTurnConnection(root, ENV, { provider: "legacy", model: null }, "chat");
    assert.equal(gone.unavailable, "Profile provider unavailable: legacy");
    assert.deepEqual(readFileProviders(root), []);
    assert.equal(existsSync(join(root, ".sam", "providers.json")), false);
    assert.equal(existsSync(join(root, ".sam", "providers.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
