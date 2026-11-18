import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authStatus, authStatusText, probeAuth } from "./auth-status.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The auth status daily-measurement wiring (2026-11-17,
// mirroring the answer judge's read/spend split at 15:04):
// the auth surface had no plain-text scorecard, no script
// allowlist entry, and no daily job, and its probe half had
// never run on the box - so a vanished key, a drifted pin, or
// a stale engine route would surface only when a turn died
// on it. The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it carries no clock reading:
// the setup baseline's stamp, each probe's stamp / latency /
// free-text reason, and the codex expiry all stay in the
// record; a probe contributes its bucket only. Two reads at
// the same detected state produce byte-identical text P3
// judges the same news; real drift still changes the text.
// The scorecard is a pure read: it spends no model call, and
// probing stays the operator's --live act. Env is built per
// test (never inherited) and probes ride stub completers, so
// no test spends a real model call or reads a real key.

function bareEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/nonexistent/claude", SAM_GOG_BIN: "/nonexistent/gog", ...extra };
}
function configuredEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return bareEnv({ SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "sk-test-value-never-printed", ...extra });
}
function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-auth-status-scorecard-")); }

const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

test("auth scorecard: an unconfigured install is stable, clock-free, and P3-silent", () => {
  const root = fresh();
  try {
    const text = authStatusText(authStatus(root, bareEnv()));
    assert.match(text, /^Auth status: NOT healthy$/m);
    assert.match(text, /Setup baseline: none recorded/);
    assert.match(text, /Probes: none recorded/);
    assert.doesNotMatch(text, STAMP, "no stamp in the text");
    const again = authStatusText(authStatus(root, bareEnv()));
    assert.equal(again, text, "two reads at the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held auth scorecard the same news",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("auth scorecard: a configured install reads healthy, names the key env, and never prints a value", () => {
  const root = fresh();
  try {
    const text = authStatusText(authStatus(root, configuredEnv()));
    assert.match(text, /^Auth status: healthy$/m);
    assert.match(text, /route:chat: MiniMax-M2\.5/);
    assert.match(text, /key MINIMAX_API_KEY present/);
    assert.match(text, /probe never/);
    assert.doesNotMatch(text, /sk-test-value-never-printed/, "the key value never enters the text");
    assert.doesNotMatch(text, STAMP, "no stamp in the text");
    const again = authStatusText(authStatus(root, configuredEnv()));
    assert.equal(again, text, "two reads at the same state produce identical text");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("auth scorecard: a recorded probe changes the text by bucket only, and a re-probe changes nothing", async () => {
  const root = fresh();
  try {
    const before = authStatusText(authStatus(root, configuredEnv()));
    await probeAuth(root, configuredEnv(), async () => "ready");
    const after = authStatusText(authStatus(root, configuredEnv()));
    assert.notEqual(after, before, "a landed probe verdict is news");
    assert.match(after, /probe ok/);
    assert.match(after, /Probes: recorded for \d+ of \d+ targets/);
    assert.doesNotMatch(after, STAMP, "the probe's stamp and latency stay in the record, not the text");
    // A second probe at a different wall-clock moment (fresh
    // stamps and latencies in the store) renders the same text.
    await probeAuth(root, configuredEnv(), async () => "ready");
    const reProbed = authStatusText(authStatus(root, configuredEnv()));
    assert.equal(reProbed, after, "a re-probe with fresh stamps/latencies is the same news");
    const prior = { hash: heartbeatOutputHash(after), sig: heartbeatFactSignatureString(after) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(reProbed), heartbeatFactSignatureString(reProbed)),
      true,
      "P3 judges a re-probed scorecard the same news",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("auth scorecard: drift changes the text - a vanished key flips the verdict", () => {
  const root = fresh();
  try {
    const held = authStatusText(authStatus(root, configuredEnv()));
    const drifted = authStatusText(authStatus(root, bareEnv({ SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5" })));
    assert.notEqual(drifted, held, "drift is news");
    assert.match(drifted, /^Auth status: NOT healthy$/m);
    assert.match(drifted, /key MINIMAX_API_KEY absent/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("auth scorecard: sam-auth-status is allowlisted and rides the models scorecard door", () => {
  assert.ok(scriptCommandNames().includes("sam-auth-status"));
  const argv = scriptArgv(fresh(), "sam-auth-status");
  assert.equal(argv[0], process.execPath);
  assert.ok(argv.some(a => a.endsWith("cli.js")));
  assert.ok(argv.includes("models") && argv.includes("scorecard"));
});
