import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_FIX_ALLOWLIST, doctorFixBlocker, runDoctor } from "./doctor.js";

// The doctor-fix gate: the fix id is a registry name
// (DOCTOR_FIX_ALLOWLIST in doctor.ts: remove-stale-socket,
// tighten-socket-permissions) that a person types at the
// CLI `doctor run --fix [id]` door. The ONE seam every fix
// request rides, runDoctor, refused an off-allowlist id
// with a shared reason text that named the allowlist but
// echoed no value and offered no fold correction, so a
// folded name ("Remove-Stale-Socket", "remove_stale_socket")
// dead-ended. doctorFixBlocker in doctor.ts is now the ONE
// source carrying the refusal text; runDoctor returns it
// as the same refused note as before (doctor refusals are
// data in the report, never throws), before any fix is
// applied. Stored check fixIds stay permissive by design
// (a check may name a non-allowlisted fix precisely so
// doctor can refuse it).

function down(): Promise<never> {
  const error = new Error("connect ENOENT") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return Promise.reject(error);
}

test("doctor fix gate: every exact allowlisted fix reads no blocker", () => {
  for (const fix of DOCTOR_FIX_ALLOWLIST) assert.equal(doctorFixBlocker(fix), null, fix);
  assert.equal(DOCTOR_FIX_ALLOWLIST.length, 2);
});

test("doctor fix gate: an unknown fix names the allowlist and keeps the safety sentence, no correction", () => {
  assert.equal(
    doctorFixBlocker("write-env"),
    "Unknown doctor fix \"write-env\": not on the doctor fix allowlist (remove-stale-socket, tighten-socket-permissions). Doctor does not change credentials, stores, env files, or a live daemon.",
  );
});

test("doctor fix gate: a folded name is refused with the correction", () => {
  assert.match(doctorFixBlocker("Remove-Stale-Socket")!, /Did you mean "remove-stale-socket"\?$/);
  assert.match(doctorFixBlocker("remove_stale_socket")!, /Did you mean "remove-stale-socket"\?$/);
  assert.match(doctorFixBlocker("Tighten Socket Permissions")!, /Did you mean "tighten-socket-permissions"\?$/);
  assert.match(doctorFixBlocker("TIGHTEN-SOCKET-PERMISSIONS")!, /Did you mean "tighten-socket-permissions"\?$/);
});

test("doctor fix gate: a non-string or empty value refuses naming the allowlist, no correction", () => {
  assert.match(doctorFixBlocker(42)!, /^Unknown doctor fix "42": not on the doctor fix allowlist/);
  assert.doesNotMatch(doctorFixBlocker(42)!, /Did you mean/);
  assert.match(doctorFixBlocker("")!, /^Unknown doctor fix "": not on the doctor fix allowlist/);
  assert.doesNotMatch(doctorFixBlocker("")!, /Did you mean/);
});

test("doctor fix gate: the runDoctor seam refuses a folded fix as data and applies nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-fix-gate-"));
  try {
    const env = { PATH: process.env.PATH ?? "", SAM_VAULT_DIR: join(dir, "vault") };
    const report = await runDoctor(dir, { env, fix: "Remove-Stale-Socket", ping: down, connectHost: async () => ({ ok: true, error: "" }) });
    assert.equal(report.applied.length, 0);
    assert.equal(report.refused.length, 1);
    assert.equal(report.refused[0].fixId, "Remove-Stale-Socket");
    assert.match(report.refused[0].detail, /Did you mean "remove-stale-socket"\?$/);
    const plain = await runDoctor(dir, { env, fix: "write-env", ping: down, connectHost: async () => ({ ok: true, error: "" }) });
    assert.equal(plain.refused.length, 1);
    assert.doesNotMatch(plain.refused[0].detail, /Did you mean/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
