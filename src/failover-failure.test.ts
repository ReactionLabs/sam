import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import { addProvider } from "./providers.js";
import {
  addFallbackRoute, clearFallbackRoutes, failoverFailureSummary,
  fallbackRoutes, isFailoverLedgered, updateFallbackRoutes,
} from "./failover.js";
import { classifyDefect } from "./self-work.js";

// Failover store failure visibility (gap found 2026-11-14,
// hourly run 21:04): the failover store holds each profile's
// ordered fallback provider+model routes, read on every
// turn's route build, and every touch opened it raw: a dead
// fallbacks.db threw into whichever catch wrapped the turn,
// none naming the store. Each touch now ledgers ONE
// failover-failed line (phase read / write) and rethrows
// exactly, tagged; every caller's handling is unchanged and
// routing still fails closed (never folded as no fallbacks,
// which would silently drop a profile's fallback routes).
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-failover-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "failover-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "fallbacks.db"), { force: true });
  mkdirSync(join(root, ".sam", "fallbacks.db"), { recursive: true });
}

const ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "k", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" };

function seedProviders(root: string): void {
  addProvider(root, { id: "openai", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", model: "gpt-4.1" }, ENV);
  addProvider(root, { id: "anthropic", endpoint: "https://api.anthropic.com/v1/chat/completions", keyEnv: "ANTHROPIC_API_KEY", model: "claude-x" }, ENV);
}

test("failover-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(failoverFailureSummary("read", "unable to open\n  database   file"), "Failover read failed: unable to open database file");
  assert.equal(failoverFailureSummary("write", "disk gone"), "Failover write failed: disk gone");
  assert.equal(failoverFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "failover-failed", summary: failoverFailureSummary(phase, "boom") }),
      { key: "failover-failed:" + phase, label: "failover store failures (" + phase + " step)" },
    );
  }
});

test("failover-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", () => {
  const root = scratch();
  try {
    seedProviders(root);
    addFallbackRoute(root, "sam", { provider: "openai", model: "gpt-4.1" }, ENV);
    plantDeadStore(root);

    assert.throws(() => fallbackRoutes(root, "sam"), (e: unknown) => isFailoverLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Failover read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "failover-failed:read", label: "failover store failures (read step)" });

    assert.throws(() => addFallbackRoute(root, "sam", { provider: "anthropic", model: "claude-x" }, ENV), (e: unknown) => isFailoverLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "an add over a dead store ledgers exactly one line total");
    assert.ok(lines[1].summary.startsWith("Failover write failed: "), lines[1].summary);

    assert.throws(() => updateFallbackRoutes(root, "sam", [{ provider: "anthropic", model: "claude-x" }], ENV), (e: unknown) => isFailoverLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3, "the update touch ledgers exactly one more line");
    assert.ok(lines[2].summary.startsWith("Failover write failed: "), lines[2].summary);

    assert.throws(() => clearFallbackRoutes(root, "sam"), (e: unknown) => isFailoverLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 4, "the clear touch ledgers exactly one more line");
    assert.ok(lines[3].summary.startsWith("Failover write failed: "), lines[3].summary);

    assert.ok(!JSON.stringify(lines).includes("gpt-4.1"), "no model name ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("claude-x"), "no model name ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failover-failed: an absent store reads as no fallbacks, and nothing is created or ledgered", () => {
  const root = scratch();
  try {
    assert.deepEqual(fallbackRoutes(root, "sam"), []);
    assert.equal(clearFallbackRoutes(root, "sam"), false);
    assert.equal(updateFallbackRoutes(root, "sam", [{ provider: "openai", model: "gpt-4.1" }], ENV), null);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam", "fallbacks.db")), false, "a pure read creates no store");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failover-failed: validation errors are not store failures and ledger nothing", () => {
  const root = scratch();
  try {
    seedProviders(root);
    assert.throws(() => addFallbackRoute(root, "Bad Profile!", { provider: "openai", model: "gpt-4.1" }, ENV), /Invalid profile/);
    assert.throws(() => addFallbackRoute(root, "sam", { provider: "Bad Provider!", model: "gpt-4.1" }, ENV), /Invalid provider id/);
    assert.throws(() => addFallbackRoute(root, "sam", { provider: "openai", model: "bad model!" }, ENV), /Invalid model/);
    assert.throws(() => addFallbackRoute(root, "sam", { provider: "nope", model: "x" }, ENV), /Unknown provider/);
    addFallbackRoute(root, "sam", { provider: "openai", model: "gpt-4.1" }, ENV);
    addFallbackRoute(root, "sam", { provider: "openai", model: "gpt-4.1-mini" }, ENV);
    addFallbackRoute(root, "sam", { provider: "anthropic", model: "claude-x" }, ENV);
    addFallbackRoute(root, "sam", { provider: "anthropic", model: "claude-y" }, ENV);
    assert.throws(() => addFallbackRoute(root, "sam", { provider: "openai", model: "gpt-5" }, ENV), /Fallback limit reached \(4\)/);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failover-failed: a healthy store adds, reads, updates, and clears with zero failure lines", () => {
  const root = scratch();
  try {
    seedProviders(root);
    assert.deepEqual(addFallbackRoute(root, "sam", { provider: "openai", model: "gpt-4.1" }, ENV), [{ provider: "openai", model: "gpt-4.1" }]);
    assert.deepEqual(fallbackRoutes(root, "sam"), [{ provider: "openai", model: "gpt-4.1" }]);
    assert.deepEqual(updateFallbackRoutes(root, "sam", [{ provider: "anthropic", model: "claude-x" }], ENV), [{ provider: "anthropic", model: "claude-x" }]);
    assert.equal(updateFallbackRoutes(root, "ghost", [{ provider: "openai", model: "gpt-4.1" }], ENV), null);
    assert.equal(clearFallbackRoutes(root, "sam"), true);
    assert.deepEqual(fallbackRoutes(root, "sam"), []);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failover-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const root = scratch();
  try {
    seedProviders(root);
    addFallbackRoute(root, "sam", { provider: "openai", model: "gpt-4.1" }, ENV);
    const raw = openDatabase(join(root, ".sam", "fallbacks.db"));
    try {
      raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON fallbacks BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => addFallbackRoute(root, "trading", { provider: "anthropic", model: "claude-x" }, ENV), (e: unknown) => isFailoverLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Failover write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
