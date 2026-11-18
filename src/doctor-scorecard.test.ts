import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorScorecardText, runDoctor } from "./doctor.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The doctor daily-measurement wiring (2026-11-18, mirroring
// the auth status read/fix split at 22:04): doctor had no
// plain-text scorecard, no script allowlist entry, and no
// daily job, so a live store corrupting, a socket going
// stale, or the control token loosening would surface only
// when a turn died on it. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it carries
// no clock reading and no free text: verdict, per-status
// counts, and one id: status line per check - never the
// evidence, a fix text, a version, a host, a mode, or a
// reason. The scorecard path never requests a fix and
// spends no model call; every probe here is injected, so no
// test touches a real socket, host, or key.

function scratch(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "sam-doctor-scorecard-"));
  return { dir, env: { PATH: process.env.PATH ?? "", SAM_VAULT_DIR: join(dir, "vault") } };
}

function down(): Promise<never> {
  const error = new Error("connect ENOENT") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return Promise.reject(error);
}

const okHost = async () => ({ ok: true, error: "" });
const noSocket = async () => "missing" as const;

test("doctor scorecard: a bare install is stable, clock-free, and P3-silent", async () => {
  const { dir, env } = scratch();
  try {
    const report = await runDoctor(dir, { env, ping: down, connectHost: okHost, probeSocket: noSocket });
    const text = doctorScorecardText(report);
    assert.match(text, /^Doctor: failing$/m, "env missing is a fail on a bare install");
    assert.match(text, /^Checks: \d+ total, \d+ ok, \d+ warn, \d+ fail, \d+ skip$/m);
    assert.match(text, /^env: fail$/m);
    assert.match(text, /^daemon-token: warn$/m);
    assert.match(text, /^daemon-version: skip$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(report.applied.length, 0, "the scorecard path applies nothing");
    const again = doctorScorecardText(await runDoctor(dir, { env, ping: down, connectHost: okHost, probeSocket: noSocket }));
    assert.equal(again, text, "two diagnoses of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held doctor scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("doctor scorecard: evidence, reasons, versions, and planted bytes never enter the text", async () => {
  const { dir, env } = scratch();
  const planted = "not-a-database-SECRET-BYTES";
  try {
    mkdirSync(join(dir, ".sam"), { recursive: true });
    writeFileSync(join(dir, ".sam", "chats.db"), planted);
    const report = await runDoctor(dir, { env, ping: down, connectHost: okHost, probeSocket: noSocket });
    const text = doctorScorecardText(report);
    assert.match(text, /^store:chats\.db: fail$/m, "the dead store is named by id and status only");
    assert.equal(text.includes(planted), false, "planted bytes never surface");
    assert.equal(text.includes("SECRET"), false);
    assert.doesNotMatch(text, /integrity_check|Restore|backup/i, "no evidence or fix text in the scorecard");
    assert.doesNotMatch(text, /node v?\d|CLI \d/, "no version readings in the scorecard");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("doctor scorecard: a flipped check moves the text and the verdict", async () => {
  const { dir, env } = scratch();
  try {
    const before = doctorScorecardText(await runDoctor(dir, { env, ping: down, connectHost: okHost, probeSocket: noSocket }));
    const configured: NodeJS.ProcessEnv = {
      ...env,
      SAM_MODEL_PROVIDER: "minimax",
      SAM_MODEL: "MiniMax-M2.5",
      MINIMAX_API_KEY: "scorecard-test-key",
    };
    const after = doctorScorecardText(await runDoctor(dir, { env: configured, ping: down, connectHost: okHost, probeSocket: noSocket }));
    assert.notEqual(after, before, "configuring the env changes the scorecard");
    assert.match(after, /^env: ok$/m);
    const prior = { hash: heartbeatOutputHash(before), sig: heartbeatFactSignatureString(before) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(after), heartbeatFactSignatureString(after)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("doctor scorecard: the allowlist argv rides doctor scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-doctor"));
  const argv = scriptArgv("/tmp/sam-root", "sam-doctor");
  assert.ok(argv);
  assert.deepEqual(argv.slice(-2), ["doctor", "scorecard"]);
  assert.ok(argv.includes("/tmp/sam-root"));
});
