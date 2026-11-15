import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import { authProbesStoreFailureSummary, isAuthProbesStoreLedgered, probeAuth, readProbeStore } from "./auth-status.js";
import { classifyDefect } from "./self-work.js";

// Auth probes store failure visibility (gap found
// 2026-11-15, hourly run 16:04): the auth probes store
// (.sam/auth-probes.db - the one row holding the last probe
// run's verdicts that auth status and the --check contract
// read back) touched its file raw at readProbeStore and
// saveProbeStore, so a dead store threw with the seam
// unnamed into auth status, the dashboard status payload,
// and the CLI overview. Each touch now ledgers ONE
// auth-probes-store-failed line (read door at phase read,
// write door at phase write) and rethrows exactly, tagged;
// every caller's handling is unchanged and reads still fail
// closed (never folded as no probes, which would silently
// erase a failed chat route's latest verdict dressed as
// never-probed, so the check passed it again).
function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-auth-probes-store-fail-")); }

function configuredEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/nonexistent/claude", SAM_GOG_BIN: "/nonexistent/gog", SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "<redacted>", ...extra };
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "auth-probes-store-failed" });
}

function plantDeadStore(root: string): void {
  mkdirSync(join(root, ".sam", "auth-probes.db"), { recursive: true });
}

test("auth-probes-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(authProbesStoreFailureSummary("read", "unable to open\n  database   file"), "Auth probes store read failed: unable to open database file");
  assert.equal(authProbesStoreFailureSummary("write", "disk gone"), "Auth probes store write failed: disk gone");
  assert.equal(authProbesStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "auth-probes-store-failed", summary: authProbesStoreFailureSummary(phase, "boom") }),
      { key: "auth-probes-store-failed:" + phase, label: "auth probes store failures (" + phase + " step)" },
    );
  }
});

test("auth-probes-store-failed: a healthy probe round trip ledgers no failure line", async () => {
  const root = fresh();
  try {
    const run = await probeAuth(root, configuredEnv(), async () => "ready");
    assert.equal(run.ok, true);
    assert.deepEqual(readProbeStore(root), { at: run.at, results: run.results });
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("auth-probes-store-failed: an absent store reads as no probes, creates nothing, and ledgers nothing", () => {
  const root = fresh();
  try {
    assert.equal(readProbeStore(root), null);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("auth-probes-store-failed: a torn row still parses forgiving to null and ledgers nothing", async () => {
  const root = fresh();
  try {
    const run = await probeAuth(root, configuredEnv(), async () => "ready");
    assert.equal(run.ok, true);
    const db = openDatabase(join(root, ".sam", "auth-probes.db"));
    try { db.prepare("UPDATE auth_probes SET data = ? WHERE id = 1").run("{ not json"); } finally { db.close(); }
    assert.equal(readProbeStore(root), null);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("auth-probes-store-failed: a dead store at read ledgers exactly one read line, tagged, and rethrows", () => {
  const root = fresh();
  try {
    plantDeadStore(root);
    assert.throws(() => readProbeStore(root), (e: unknown) => isAuthProbesStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Auth probes store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "auth-probes-store-failed:read", label: "auth probes store failures (read step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("auth-probes-store-failed: a dead store at write ledgers exactly one write line, tagged, rethrows, and carries no probe record content", async () => {
  const root = fresh();
  try {
    plantDeadStore(root);
    await assert.rejects(
      probeAuth(root, configuredEnv(), async () => "ready"),
      (e: unknown) => isAuthProbesStoreLedgered(e),
    );
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Auth probes store write failed: "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("MiniMax-M2.5"), "the probed model is the install's data, not failure data");
    assert.deepEqual(classifyDefect(lines[0]), { key: "auth-probes-store-failed:write", label: "auth probes store failures (write step)" });
    // The save died, so the probe's own auth-probe line never
    // landed: the failed touch is the only trace.
    assert.equal(readActivity(root, 100, { kind: "auth-probe" }).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
