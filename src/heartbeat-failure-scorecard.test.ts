import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { heartbeatFailureBucket, heartbeatFailureScorecardText, parseHeartbeatFailure } from "./heartbeat.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The heartbeat-failure daily-measurement wiring (2026-11-18,
// the measured-proof series): Phase C's failure isolation
// made job deaths countable, and the brief folds the last
// day's failed jobs - but no daily surface ever counted the
// class cumulatively, so a job that kept dying was invisible
// until its owner noticed the silence. The scorecard text is
// a script job's stdout and is P3-diffed on its facts, so it
// carries counts only: no stamp, no job name, no actor, no
// verbatim reason - modes and reasons fold into fixed
// in-code enums and an unmatched reason is "other", never
// printed. The scorecard path is a pure read - it creates
// nothing, spends no model call, and retries nothing; every
// state here is built through the ledger's own public door
// (recordActivity), never around it.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-heartbeat-failure-scorecard-"));
}

test("heartbeat failure scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = heartbeatFailureScorecardText(dir);
    assert.match(text, /^Heartbeat failures: clear$/m);
    assert.match(text, /^Failed jobs: 0$/m);
    assert.match(text, /^By mode: none$/m);
    assert.match(text, /^By reason: none$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = heartbeatFailureScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held heartbeat-failure scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("heartbeat failure scorecard: failed jobs flip the verdict, fold to fixed modes and buckets, and leak no content", () => {
  const dir = scratch();
  try {
    const clean = heartbeatFailureScorecardText(dir);
    recordActivity(dir, "dip", "heartbeat-failed", "Heartbeat 'sekrit-job' failed: Unsafe model output");
    recordActivity(dir, "trading", "heartbeat-failed", "Heartbeat 'sekrit-job' failed: Model connector request timed out");
    recordActivity(dir, "sam", "heartbeat-failed", "Heartbeat 'sekrit-job' script failed: Unsafe model output");
    recordActivity(dir, "trading", "heartbeat-failed", "Heartbeat 'sekrit-job' script exited 1: Some wholly novel failure shape");
    recordActivity(dir, "trading", "heartbeat-failed", "Heartbeat 'sekrit-job' script exited 1");
    recordActivity(dir, "sam", "heartbeat", "Heartbeat 'sekrit-job' changed: all good");
    const text = heartbeatFailureScorecardText(dir);
    assert.match(text, /^Heartbeat failures: attention$/m);
    assert.match(text, /^Failed jobs: 5$/m);
    assert.match(text, /^By mode: agent 2, script 1, script-exit 2$/m);
    assert.match(text, /^By reason: other 2, timeout 1, unsafe-output 2$/m);
    assert.equal(text.includes("sekrit"), false, "no job name surfaces");
    assert.equal(text.includes("novel failure"), false, "an unmatched reason is never printed");
    assert.notEqual(text, clean, "the first failed job changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("heartbeat failure parse and bucket: every fixed shape classifies, and only into the fixed enums", () => {
  assert.deepEqual(parseHeartbeatFailure("Heartbeat 'stack watch' failed: Unsafe model output"), { mode: "agent", reason: "Unsafe model output" });
  assert.deepEqual(parseHeartbeatFailure("Heartbeat 'stack watch' script failed: Model connector request timed out"), { mode: "script", reason: "Model connector request timed out" });
  assert.deepEqual(parseHeartbeatFailure("Heartbeat 'stack watch' script exited 1: boom"), { mode: "script-exit", reason: "boom" });
  assert.deepEqual(parseHeartbeatFailure("Heartbeat 'stack watch' script exited 1"), { mode: "script-exit", reason: "" });
  assert.equal(parseHeartbeatFailure("Heartbeat 'stack watch' script exited 1: ").mode, "script-exit");
  assert.equal(heartbeatFailureBucket("Unsafe model output"), "unsafe-output");
  assert.equal(heartbeatFailureBucket("Empty model response"), "empty-response");
  assert.equal(heartbeatFailureBucket("Too many tool calls"), "too-many-tool-calls");
  assert.equal(heartbeatFailureBucket("Model connector request timed out"), "timeout");
  assert.equal(heartbeatFailureBucket("Model not configured"), "not-configured");
  assert.equal(heartbeatFailureBucket("Model connector request failed (HTTP 429)"), "provider-error");
  assert.equal(heartbeatFailureBucket("Invalid connector model request"), "invalid-request");
  assert.equal(heartbeatFailureBucket(""), "other");
  assert.equal(heartbeatFailureBucket("Some wholly novel failure shape"), "other");
});

test("heartbeat failure scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-heartbeat-failures"), "sam-heartbeat-failures is allowlisted");
  const argv = scriptArgv("/some/root", "sam-heartbeat-failures");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["heartbeats", "failure-scorecard"], "the argv rides heartbeats failure-scorecard");
});
