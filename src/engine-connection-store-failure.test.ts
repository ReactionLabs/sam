import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import { connectEngine, disconnectEngine, engineConnectStatus, engineProvider, readEngineConnection, readEngineProviderRecord, setEngineProvider, type EngineAuthRunner } from "./engine-connect.js";
import { engineConnectionStoreFailureSummary, isEngineConnectionStoreLedgered } from "./engine-connection-failure.js";
import { selectedEngineProvider } from "./engine.js";
import { classifyDefect } from "./self-work.js";

// Engine connection store failure visibility (gap found
// 2026-11-15, hourly run 13:04): the engine-connection store
// (.sam/engine-connection.db - the non-secret route marker
// plus the provider choice for the C6 managed coding engine)
// touched its file raw at every door in engine-connect.ts, so
// a dead store threw with the seam unnamed into every status
// surface, and the run layer's read-only mirror in engine.ts
// folded every failure to the claude-code default, silently
// running the wrong provider on a Codex-selected install.
// Each touch now ledgers ONE engine-connection-store-failed
// line (read doors at phase read, write doors at phase
// write, the folding mirror at phase resolve) and rethrows
// exactly, tagged; the mirror still folds exactly as before,
// now countable.
function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-engine-connection-fail-")); }
function fakeBinary(root: string, name = "claude"): string {
  const bin = join(root, name);
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  return bin;
}
function envWith(bin: string): NodeJS.ProcessEnv { return { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: bin }; }
const SIGNED_IN_JSON = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "owner@example.test" });
const runnerReturning = (output: string, exitCode: number | null = 0): EngineAuthRunner => async () => ({ exitCode, output });

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "engine-connection-store-failed" });
}

function plantDeadStore(root: string): void {
  mkdirSync(join(root, ".sam", "engine-connection.db"), { recursive: true });
}

test("engine-connection-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(engineConnectionStoreFailureSummary("read", "unable to open\n  database   file"), "Engine connection store read failed: unable to open database file");
  assert.equal(engineConnectionStoreFailureSummary("write", "disk gone"), "Engine connection store write failed: disk gone");
  assert.equal(engineConnectionStoreFailureSummary("resolve", "disk gone"), "Engine connection store resolve failed: disk gone");
  assert.equal(engineConnectionStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write", "resolve"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "engine-connection-store-failed", summary: engineConnectionStoreFailureSummary(phase, "boom") }),
      { key: "engine-connection-store-failed:" + phase, label: "engine connection store failures (" + phase + " step)" },
    );
  }
});

test("engine-connection-store-failed: a healthy round trip ledgers nothing", async () => {
  const root = fresh();
  try {
    const bin = fakeBinary(root);
    const run = await connectEngine(root, envWith(bin), runnerReturning(SIGNED_IN_JSON));
    assert.equal(run.connected, true);
    assert.equal(readEngineConnection(root)?.binary, bin);
    assert.equal(engineConnectStatus(root, envWith(bin)).connected, true);
    setEngineProvider(root, "codex");
    assert.equal(readEngineProviderRecord(root)?.provider, "codex");
    assert.equal(engineProvider(root), "codex");
    assert.equal(selectedEngineProvider(root), "codex");
    assert.equal(disconnectEngine(root).disconnected, true);
    assert.equal(readEngineConnection(root), null);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine-connection-store-failed: an absent store reads as no connection / default provider, creates nothing, and ledgers nothing", () => {
  const root = fresh();
  try {
    assert.equal(readEngineConnection(root), null);
    assert.equal(readEngineProviderRecord(root), null);
    assert.equal(engineProvider(root), "claude-code");
    assert.equal(selectedEngineProvider(root), "claude-code");
    assert.equal(disconnectEngine(root).disconnected, false);
    assert.equal(existsSync(join(root, ".sam")), false);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine-connection-store-failed: a dead store at read ledgers exactly one read line, tagged, rethrows, and carries no marker content", () => {
  const root = fresh();
  try {
    plantDeadStore(root);
    assert.throws(() => readEngineConnection(root), (e: unknown) => isEngineConnectionStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Engine connection store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "engine-connection-store-failed:read", label: "engine connection store failures (read step)" });
    // The provider door rides the same store: one more touch,
    // one more line, still tagged.
    assert.throws(() => engineProvider(root), (e: unknown) => isEngineConnectionStoreLedgered(e));
    assert.equal(failedLines(root).length, 2, "one line per failed touch - the recurrence is the countable signal");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine-connection-store-failed: the run-layer mirror still folds to the default on a dead store, ledgering one resolve line per touch", () => {
  const root = fresh();
  try {
    plantDeadStore(root);
    assert.equal(selectedEngineProvider(root), "claude-code");
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Engine connection store resolve failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "engine-connection-store-failed:resolve", label: "engine connection store failures (resolve step)" });
    assert.equal(selectedEngineProvider(root), "claude-code");
    assert.equal(failedLines(root).length, 2, "one line per failed touch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine-connection-store-failed: a dead store at write ledgers exactly one write line, tagged, and rethrows", async () => {
  const root = fresh();
  try {
    plantDeadStore(root);
    assert.throws(() => setEngineProvider(root, "codex"), (e: unknown) => isEngineConnectionStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Engine connection store write failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "engine-connection-store-failed:write", label: "engine connection store failures (write step)" });
    // A verified connect's save rides the same write door:
    // pass the provider explicitly so the read door is not
    // touched first, and the save's failure is the one line.
    const bin = fakeBinary(root);
    await assert.rejects(
      connectEngine(root, envWith(bin), runnerReturning(SIGNED_IN_JSON), "claude-code"),
      (e: unknown) => isEngineConnectionStoreLedgered(e),
    );
    assert.equal(failedLines(root).length, 2, "one line per failed touch");
    assert.ok(failedLines(root)[1].summary.startsWith("Engine connection store write failed: "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine-connection-store-failed: disconnect on a dead store dies at its read door with exactly one read line", () => {
  const root = fresh();
  try {
    plantDeadStore(root);
    assert.throws(() => disconnectEngine(root), (e: unknown) => isEngineConnectionStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].summary.startsWith("Engine connection store read failed: "), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine-connection-store-failed: an invalid provider refusal is not a store failure and ledgers nothing", () => {
  const root = fresh();
  try {
    assert.throws(() => setEngineProvider(root, "bogus" as never), /Invalid engine provider/);
    assert.equal(failedLines(root).length, 0);
    assert.equal(existsSync(join(root, ".sam")), false, "a refused provider choice creates nothing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine-connection-store-failed: torn rows still parse forgiving and ledger nothing", async () => {
  const root = fresh();
  try {
    const bin = fakeBinary(root);
    const run = await connectEngine(root, envWith(bin), runnerReturning(SIGNED_IN_JSON));
    assert.equal(run.connected, true);
    const db = openDatabase(join(root, ".sam", "engine-connection.db"));
    try {
      db.prepare("UPDATE engine_connection SET data = ? WHERE id = 1").run("{ not json");
      db.prepare("UPDATE engine_provider SET data = ? WHERE id = 1").run("{ not json");
    } finally { db.close(); }
    assert.equal(readEngineConnection(root), null);
    assert.equal(readEngineProviderRecord(root), null);
    assert.equal(selectedEngineProvider(root), "claude-code");
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
