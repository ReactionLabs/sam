import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProvider, findRemovableProvider, providerRemoveBlocker, readFileProviders, removeProvider } from "./providers.js";

// The provider gate for the remove door: file-configured
// providers are registered by exact id and listed by that
// id, and this module's pin door already reads the registry
// through providerPinBlocker with the fold correction, but
// `sam providers remove <id>` rode removeProvider alone, so
// an unknown or folded id ("Open AI" or "OPENAI" for the
// file-configured "openai") silently returned
// {removed:false}, naming nothing, at the door that deletes
// a provider's endpoint and key-env registration.
// providerPinBlocker is NOT this door's source: its registry
// is listProviders, which includes the environment provider,
// and the environment provider is not stored here and must
// never read as removable. The CLI remove door now resolves
// through findRemovableProvider (throwing
// providerRemoveBlocker, the ONE source over the
// file-configured providers alone, before anything is
// removed) and removes by the resolved id; removeProvider
// keeps its boolean contract (false on a miss) for internal
// callers - the store seam stays permissive by design.

const ENV: NodeJS.ProcessEnv = {};

function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-provider-remove-gate-"));
  addProvider(root, { id: "openai", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", model: "gpt-4.1" }, ENV);
  addProvider(root, { id: "anthropic", endpoint: "https://api.anthropic.com/v1/chat/completions", keyEnv: "ANTHROPIC_API_KEY", model: "claude-x" }, ENV);
  return root;
}

test("provider remove gate: an exact file id reads no blocker and removes by the resolved id", () => {
  const root = fresh();
  try {
    assert.equal(providerRemoveBlocker(root, "openai", ENV), null);
    const resolved = findRemovableProvider(root, "openai", ENV);
    assert.equal(resolved.id, "openai");
    assert.equal(removeProvider(root, resolved.id), true);
    assert.deepEqual(readFileProviders(root).map(p => p.id), ["anthropic"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider remove gate: a folded id is refused with the correction and removes nothing", () => {
  const root = fresh();
  try {
    const blocker = providerRemoveBlocker(root, "Open AI", ENV)!;
    assert.equal(
      blocker,
      "Provider not found: \"Open AI\". File-configured providers: openai, anthropic. Did you mean \"openai\"?",
    );
    assert.throws(() => findRemovableProvider(root, "Open AI", ENV), (e: unknown) => e instanceof Error && e.message === blocker);
    assert.deepEqual(readFileProviders(root).map(p => p.id), ["openai", "anthropic"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider remove gate: an upper-case fold corrects the same way", () => {
  const root = fresh();
  try {
    const blocker = providerRemoveBlocker(root, "ANTHROPIC", ENV)!;
    assert.match(blocker, /Did you mean "anthropic"\?$/);
    assert.equal(readFileProviders(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider remove gate: the environment provider is refused as the environment provider", () => {
  const root = fresh();
  try {
    const blocker = providerRemoveBlocker(root, "default", ENV)!;
    assert.equal(
      blocker,
      "Provider \"default\" is the environment provider: it is not stored here and cannot be removed. File-configured providers: openai, anthropic",
    );
    assert.throws(() => findRemovableProvider(root, "default", ENV));
    assert.equal(readFileProviders(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider remove gate: an unknown id names the registry with no correction", () => {
  const root = fresh();
  try {
    const blocker = providerRemoveBlocker(root, "ghost", ENV)!;
    assert.equal(blocker, "Provider not found: \"ghost\". File-configured providers: openai, anthropic");
    assert.throws(() => findRemovableProvider(root, "ghost", ENV));
    assert.equal(readFileProviders(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider remove gate: an empty registry names none registered", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-provider-remove-gate-"));
  try {
    assert.equal(providerRemoveBlocker(root, "ghost", ENV), "Provider not found: \"ghost\". File-configured providers: none registered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider remove gate: an ambiguous fold offers no correction", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-provider-remove-gate-"));
  try {
    addProvider(root, { id: "a-bc", endpoint: "https://a.example.com/v1/chat/completions", keyEnv: "A_API_KEY", model: "m-a" }, ENV);
    addProvider(root, { id: "ab-c", endpoint: "https://b.example.com/v1/chat/completions", keyEnv: "B_API_KEY", model: "m-b" }, ENV);
    const blocker = providerRemoveBlocker(root, "ABC", ENV)!;
    assert.doesNotMatch(blocker, /Did you mean/);
    assert.equal(readFileProviders(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider remove gate: the store seam keeps its boolean contract", () => {
  const root = fresh();
  try {
    assert.equal(removeProvider(root, "nope"), false);
    assert.equal(removeProvider(root, "anthropic"), true);
    assert.equal(removeProvider(root, "anthropic"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
