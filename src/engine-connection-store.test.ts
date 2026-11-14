import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectEngine, disconnectEngine, engineConnectStatus, readEngineConnection, type EngineAuthRunner, type EngineConnection } from "./engine-connect.js";

// State convergence (UNIFICATION item 4, thirtieth store):
// the Claude Code engine route marker migrated from whole-file
// engine-connection.json rewrites (a torn write silently erased
// the connection, so a verified signed-in install read as
// never-connected) to a one-row SQLite singleton. These tests
// pin the migration contract: a legacy file imports with every
// field intact (identity-shaped extras the old reader parsed
// past never enter the store), is renamed (never deleted), a
// malformed / misshapen file imports nothing and stays put
// while reading as no connection, a pure read creates nothing,
// a non-signed-in verdict still saves nothing
// (verify-before-save untouched), connects ride the DB as
// single-row UPSERTs, and disconnect is a single-row DELETE
// that never resurrects a migrated legacy marker.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-engine-connection-store-")); }
function fakeBinary(root: string, name = "claude"): string {
  const bin = join(root, name);
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  return bin;
}
function envWith(bin: string): NodeJS.ProcessEnv { return { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: bin }; }
const SIGNED_IN_JSON = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "owner@example.test", orgId: "org-secret-id" });
const SIGNED_OUT_JSON = JSON.stringify({ loggedIn: false });
const runnerReturning = (output: string, exitCode: number | null = 0): EngineAuthRunner => async () => ({ exitCode, output });

const LEGACY: EngineConnection = { route: "cli-reuse", provider: "claude-code", binary: "/opt/fake/claude", connectedAt: "2026-11-10T21:19:00.000Z", authState: "signed-in", authMethod: "claude.ai" };

test("engine connection store: a legacy engine-connection.json imports intact, file renamed not deleted", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    // The legacy payload carries identity-shaped extras the old
    // reader parsed past; the sanitized record is what imports.
    writeFileSync(join(root, ".sam", "engine-connection.json"), JSON.stringify({ ...LEGACY, email: "owner@example.test", orgId: "org-secret-id" }, null, 2));
    assert.deepEqual(readEngineConnection(root), LEGACY);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.db")), true);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.json")), false);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "engine-connection.json.migrated"), "utf8")) as Record<string, unknown>;
    assert.equal(kept.binary, LEGACY.binary);
    const dbBytes = readFileSync(join(root, ".sam", "engine-connection.db"), "utf8");
    assert.ok(!dbBytes.includes("owner@example.test") && !dbBytes.includes("org-secret-id"), "identity fields never enter the store");
    // Status reads the migrated marker back: stale (its binary
    // is not the detected one), not connected, record shown.
    const status = engineConnectStatus(root, { PATH: "/nonexistent-dir" });
    assert.equal(status.connected, false);
    assert.equal(status.stale, true);
    assert.deepEqual(status.connection, LEGACY);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine connection store: malformed and misshapen legacy files import nothing, stay in place, and read as no connection", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const payloads = [
      "{ not json",
      JSON.stringify({ ...LEGACY, route: "other" }),
      JSON.stringify({ ...LEGACY, binary: "" }),
      JSON.stringify({ ...LEGACY, binary: 42 }),
      JSON.stringify({ ...LEGACY, connectedAt: 42 }),
      JSON.stringify({ ...LEGACY, authState: "signed-out" }),
      JSON.stringify(["not", "an", "object"]),
    ];
    for (const payload of payloads) {
      writeFileSync(join(root, ".sam", "engine-connection.json"), payload);
      assert.equal(readEngineConnection(root), null, payload);
      assert.equal(existsSync(join(root, ".sam", "engine-connection.json")), true);
      assert.equal(existsSync(join(root, ".sam", "engine-connection.json.migrated")), false);
    }
    // A successful connect over an unimportable legacy file still
    // lands in the DB; the file itself is left exactly as found.
    const bin = fakeBinary(root);
    const run = await connectEngine(root, envWith(bin), runnerReturning(SIGNED_IN_JSON));
    assert.equal(run.connected, true);
    assert.equal(readEngineConnection(root)?.binary, bin);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.json")), true);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine connection store: a pure read on an empty install creates nothing, and a non-signed-in verdict saves nothing", async () => {
  const root = fresh();
  try {
    assert.equal(readEngineConnection(root), null);
    assert.equal(engineConnectStatus(root, { PATH: "/nonexistent-dir" }).connection, null);
    assert.equal(disconnectEngine(root).disconnected, false);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.db")), false);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.json")), false);
    assert.equal(existsSync(join(root, ".sam")), false);
    const bin = fakeBinary(root);
    const out = await connectEngine(root, envWith(bin), runnerReturning(SIGNED_OUT_JSON, 1));
    assert.equal(out.connected, false);
    assert.equal(readEngineConnection(root), null);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.db")), false);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine connection store: successive connects replace the marker through the DB, never resurrecting the older one", async () => {
  const root = fresh();
  try {
    const first = fakeBinary(root, "claude-one");
    const second = fakeBinary(root, "claude-two");
    const run1 = await connectEngine(root, envWith(first), runnerReturning(SIGNED_IN_JSON));
    assert.ok(run1.saved);
    const run2 = await connectEngine(root, envWith(second), runnerReturning(SIGNED_IN_JSON));
    assert.ok(run2.saved);
    const stored = readEngineConnection(root);
    assert.equal(stored?.binary, second);
    assert.equal(stored?.connectedAt, run2.saved!.connectedAt);
    assert.equal(engineConnectStatus(root, envWith(second)).connected, true);
    assert.equal(engineConnectStatus(root, envWith(first)).stale, true);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine connection store: disconnect over a migrated legacy marker removes the record and never resurrects it", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "engine-connection.json"), JSON.stringify(LEGACY, null, 2));
    assert.deepEqual(readEngineConnection(root), LEGACY);
    // A newer connect over the migrated baseline persists.
    const bin = fakeBinary(root);
    const run = await connectEngine(root, envWith(bin), runnerReturning(SIGNED_IN_JSON));
    assert.ok(run.saved);
    assert.equal(readEngineConnection(root)?.binary, bin);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.json.migrated")), true);
    // Disconnect deletes only the store row; the migrated file
    // stays as history and the legacy marker never comes back.
    assert.equal(disconnectEngine(root).disconnected, true);
    assert.equal(readEngineConnection(root), null);
    assert.equal(disconnectEngine(root).disconnected, false);
    assert.equal(readEngineConnection(root), null);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.json")), false);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.json.migrated")), true);
    assert.equal(existsSync(join(root, ".sam", "engine-connection.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
