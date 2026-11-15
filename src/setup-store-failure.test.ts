import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import { isSetupStoreLedgered, readSetupRecord, setupStoreFailureSummary, verifyAndSaveSetup } from "./config-wizard.js";
import { classifyDefect } from "./self-work.js";

// Setup store failure visibility (gap found 2026-11-15,
// hourly run 15:04): the setup store (.sam/setup.db - the
// verified setup baseline, the one row recording that this
// install's model route was proven with a real completion)
// touched its file raw at readSetupRecord and
// saveSetupRecord, so a dead store threw with the seam
// unnamed into auth status, the dashboard status payload,
// the CLI overview and config views, and the setup flow's
// own save after a successful verification. Each touch now
// ledgers ONE setup-store-failed line (read door at phase
// read, write door at phase write) and rethrows exactly,
// tagged; every caller's handling is unchanged and reads
// still fail closed (never folded as no baseline, which
// would silently un-verify a verified install dressed as a
// first run).
function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-setup-store-fail-")); }

function configuredEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/nonexistent/claude", SAM_GOG_BIN: "/nonexistent/gog", SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "<redacted>", ...extra };
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "setup-store-failed" });
}

function plantDeadStore(root: string): void {
  mkdirSync(join(root, ".sam", "setup.db"), { recursive: true });
}

test("setup-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(setupStoreFailureSummary("read", "unable to open\n  database   file"), "Setup store read failed: unable to open database file");
  assert.equal(setupStoreFailureSummary("write", "disk gone"), "Setup store write failed: disk gone");
  assert.equal(setupStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "setup-store-failed", summary: setupStoreFailureSummary(phase, "boom") }),
      { key: "setup-store-failed:" + phase, label: "setup store failures (" + phase + " step)" },
    );
  }
});

test("setup-store-failed: a healthy verify-and-save round trip ledgers no failure line", async () => {
  const root = fresh();
  try {
    const run = await verifyAndSaveSetup(root, configuredEnv(), async () => "ready");
    assert.ok(run.saved);
    assert.equal(readSetupRecord(root)?.model, "MiniMax-M2.5");
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup-store-failed: an absent store reads as no baseline, creates nothing, and ledgers nothing", () => {
  const root = fresh();
  try {
    assert.equal(readSetupRecord(root), null);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup-store-failed: a torn row still parses forgiving to null and ledgers nothing", async () => {
  const root = fresh();
  try {
    const run = await verifyAndSaveSetup(root, configuredEnv(), async () => "ready");
    assert.ok(run.saved);
    const db = openDatabase(join(root, ".sam", "setup.db"));
    try { db.prepare("UPDATE setup_record SET data = ? WHERE id = 1").run("{ not json"); } finally { db.close(); }
    assert.equal(readSetupRecord(root), null);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup-store-failed: a dead store at read ledgers exactly one read line, tagged, and rethrows", () => {
  const root = fresh();
  try {
    plantDeadStore(root);
    assert.throws(() => readSetupRecord(root), (e: unknown) => isSetupStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Setup store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "setup-store-failed:read", label: "setup store failures (read step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup-store-failed: a dead store at write ledgers exactly one write line, tagged, rethrows, and carries no record content", async () => {
  const root = fresh();
  try {
    plantDeadStore(root);
    await assert.rejects(
      verifyAndSaveSetup(root, configuredEnv(), async () => "ready-marker-xyz"),
      (e: unknown) => isSetupStoreLedgered(e),
    );
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Setup store write failed: "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("ready-marker-xyz"), "the verification reply is the install's data, not failure data");
    assert.ok(!lines[0].summary.includes("MiniMax-M2.5"), "the recorded model is the install's data, not failure data");
    assert.deepEqual(classifyDefect(lines[0]), { key: "setup-store-failed:write", label: "setup store failures (write step)" });
    // The save died, so the setup-verified line never landed:
    // the failed touch is the only trace, exactly as specced.
    assert.equal(readActivity(root, 100, { kind: "setup-verified" }).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup-store-failed: a failed verification still saves nothing and ledgers nothing", async () => {
  const root = fresh();
  try {
    const bad = await verifyAndSaveSetup(root, configuredEnv(), async () => { throw new Error("HTTP 500"); });
    assert.equal(bad.saved, null);
    assert.equal(readSetupRecord(root), null);
    assert.equal(existsSync(join(root, ".sam", "setup.db")), false);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
