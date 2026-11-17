import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heartbeatJobsStoreFailureReason, recordHeartbeatJobsStoreFailure, heartbeatStateStoreFailureReason, recordHeartbeatStateStoreFailure, heartbeatLogFailureReason, recordHeartbeatLogFailure, consolidationFailureReason, recordConsolidationFailure, tickStageFailureReason, tickStageFailure } from "./heartbeat.js";
import { readActivity } from "./activity.js";

// heartbeat-jobs-store-failed failure reasons carry their cause (census sprint
// 2026-11-17): the heartbeat-jobs-store-failed ledger line took error.message
// alone, so a failure whose wrapper hid its cause was
// countable but never diagnosable. Now the reason composes
// through errorReason (the 04:04 bridge seam): causeless
// errors keep their plain message, a non-Error reads
// through String, bot-token segments are redacted, and no
// record content ever enters the line.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-heartbeat-store-cause-"));
}

function failedLines(root: string, kind: string) {
  return readActivity(root, 100, { kind });
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND models.invalid"), { code: "ENOTFOUND" }),
});

test("a heartbeat-jobs-store-failed failure reason names the transport cause behind the wrapper (heartbeatJobsStoreFailureReason)", () => {
  assert.equal(heartbeatJobsStoreFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it (heartbeatJobsStoreFailureReason)", () => {
  const err = new Error("unable to open database file", { cause: Object.assign(new Error("open"), { code: "SQLITE_CANTOPEN" }) });
  assert.equal(heartbeatJobsStoreFailureReason(err), "unable to open database file: open (SQLITE_CANTOPEN)");
});

test("causeless errors keep their plain message; a non-Error throw reads through String (heartbeatJobsStoreFailureReason)", () => {
  assert.equal(heartbeatJobsStoreFailureReason(new Error("EISDIR: illegal operation on a directory")), "EISDIR: illegal operation on a directory");
  assert.equal(heartbeatJobsStoreFailureReason("plain string failure"), "plain string failure");
});

test("no bot token leaks through a heartbeat-jobs-store-failed failure reason (heartbeatJobsStoreFailureReason)", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = heartbeatJobsStoreFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("recordHeartbeatJobsStoreFailure ledgers exactly one line carrying the cause", () => {
  const root = scratch();
  try {
    recordHeartbeatJobsStoreFailure(root, "read", dnsErr());
    const lines = failedLines(root, "heartbeat-jobs-store-failed");
    assert.equal(lines.length, 1, "exactly one line for the failed touch");
    assert.match(lines[0].summary, /fetch failed: getaddrinfo ENOTFOUND models\.invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a heartbeat-state-store-failed failure reason names the transport cause behind the wrapper (heartbeatStateStoreFailureReason)", () => {
  assert.equal(heartbeatStateStoreFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it (heartbeatStateStoreFailureReason)", () => {
  const err = new Error("unable to open database file", { cause: Object.assign(new Error("open"), { code: "SQLITE_CANTOPEN" }) });
  assert.equal(heartbeatStateStoreFailureReason(err), "unable to open database file: open (SQLITE_CANTOPEN)");
});

test("causeless errors keep their plain message; a non-Error throw reads through String (heartbeatStateStoreFailureReason)", () => {
  assert.equal(heartbeatStateStoreFailureReason(new Error("EISDIR: illegal operation on a directory")), "EISDIR: illegal operation on a directory");
  assert.equal(heartbeatStateStoreFailureReason("plain string failure"), "plain string failure");
});

test("no bot token leaks through a heartbeat-state-store-failed failure reason (heartbeatStateStoreFailureReason)", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = heartbeatStateStoreFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("recordHeartbeatStateStoreFailure ledgers exactly one line carrying the cause", () => {
  const root = scratch();
  try {
    recordHeartbeatStateStoreFailure(root, "read", dnsErr());
    const lines = failedLines(root, "heartbeat-state-store-failed");
    assert.equal(lines.length, 1, "exactly one line for the failed touch");
    assert.match(lines[0].summary, /fetch failed: getaddrinfo ENOTFOUND models\.invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a heartbeat-log-failed failure reason names the transport cause behind the wrapper (heartbeatLogFailureReason)", () => {
  assert.equal(heartbeatLogFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it (heartbeatLogFailureReason)", () => {
  const err = new Error("unable to open database file", { cause: Object.assign(new Error("open"), { code: "SQLITE_CANTOPEN" }) });
  assert.equal(heartbeatLogFailureReason(err), "unable to open database file: open (SQLITE_CANTOPEN)");
});

test("causeless errors keep their plain message; a non-Error throw reads through String (heartbeatLogFailureReason)", () => {
  assert.equal(heartbeatLogFailureReason(new Error("EISDIR: illegal operation on a directory")), "EISDIR: illegal operation on a directory");
  assert.equal(heartbeatLogFailureReason("plain string failure"), "plain string failure");
});

test("no bot token leaks through a heartbeat-log-failed failure reason (heartbeatLogFailureReason)", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = heartbeatLogFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("recordHeartbeatLogFailure ledgers exactly one line carrying the cause", () => {
  const root = scratch();
  try {
    recordHeartbeatLogFailure(root, "read", "test-entry", null, dnsErr());
    const lines = failedLines(root, "heartbeat-log-failed");
    assert.equal(lines.length, 1, "exactly one line for the failed touch");
    assert.match(lines[0].summary, /fetch failed: getaddrinfo ENOTFOUND models\.invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a consolidate-failed failure reason names the transport cause behind the wrapper (consolidationFailureReason)", () => {
  assert.equal(consolidationFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it (consolidationFailureReason)", () => {
  const err = new Error("unable to open database file", { cause: Object.assign(new Error("open"), { code: "SQLITE_CANTOPEN" }) });
  assert.equal(consolidationFailureReason(err), "unable to open database file: open (SQLITE_CANTOPEN)");
});

test("causeless errors keep their plain message; a non-Error throw reads through String (consolidationFailureReason)", () => {
  assert.equal(consolidationFailureReason(new Error("EISDIR: illegal operation on a directory")), "EISDIR: illegal operation on a directory");
  assert.equal(consolidationFailureReason("plain string failure"), "plain string failure");
});

test("no bot token leaks through a consolidate-failed failure reason (consolidationFailureReason)", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = consolidationFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("recordConsolidationFailure ledgers exactly one line carrying the cause", () => {
  const root = scratch();
  try {
    recordConsolidationFailure(root, "test-step", 1, dnsErr());
    const lines = failedLines(root, "consolidate-failed");
    assert.equal(lines.length, 1, "exactly one line for the failed touch");
    assert.match(lines[0].summary, /fetch failed: getaddrinfo ENOTFOUND models\.invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a tick-failed failure reason names the transport cause behind the wrapper (tickStageFailureReason)", () => {
  assert.equal(tickStageFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it (tickStageFailureReason)", () => {
  const err = new Error("unable to open database file", { cause: Object.assign(new Error("open"), { code: "SQLITE_CANTOPEN" }) });
  assert.equal(tickStageFailureReason(err), "unable to open database file: open (SQLITE_CANTOPEN)");
});

test("causeless errors keep their plain message; a non-Error throw reads through String (tickStageFailureReason)", () => {
  assert.equal(tickStageFailureReason(new Error("EISDIR: illegal operation on a directory")), "EISDIR: illegal operation on a directory");
  assert.equal(tickStageFailureReason("plain string failure"), "plain string failure");
});

test("no bot token leaks through a tick-failed failure reason (tickStageFailureReason)", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = tickStageFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("tickStageFailure ledgers exactly one line carrying the cause", () => {
  const root = scratch();
  try {
    tickStageFailure(root, "test-stage", dnsErr());
    const lines = failedLines(root, "tick-failed");
    assert.equal(lines.length, 1, "exactly one line for the failed touch");
    assert.match(lines[0].summary, /fetch failed: getaddrinfo ENOTFOUND models\.invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
