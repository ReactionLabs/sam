import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activityFailureReason, activityFailureSummary, readActivity, recordActivityFailure,
} from "./activity.js";
import { errorReason } from "./telegram.js";

// Activity ledger failure reasons carry their cause (gap
// found 2026-11-17, hourly run 10:04 EST): the
// activity-failed ledger line took error.message alone, so
// a dead ledger read whose wrapper hides the transport or
// store cause behind it was countable but never
// diagnosable. Now the reason composes through errorReason
// (the 04:04 bridge seam): causeless errors keep their
// plain message, a non-Error reads through String,
// bot-token segments are redacted, and no ledger content
// ever enters the line. The seam itself moved to the leaf
// module error-reason.ts in this change (telegram.ts
// imports this module, so the ledger could not import the
// seam back without a cycle); telegram.ts re-exports it,
// pinned by the last test here.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-activity-cause-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "activity-failed" });
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND models.invalid"), { code: "ENOTFOUND" }),
});

test("an activity failure reason names the transport cause behind the wrapper", () => {
  assert.equal(activityFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
  assert.equal(
    activityFailureSummary(activityFailureReason(dnsErr())),
    "Activity read failed: fetch failed: getaddrinfo ENOTFOUND models.invalid",
  );
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new Error("unable to open database file", { cause: Object.assign(new Error("open"), { code: "SQLITE_CANTOPEN" }) });
  assert.equal(activityFailureReason(err), "unable to open database file: open (SQLITE_CANTOPEN)");
});

test("causeless errors keep their plain message; a non-Error throw reads through String", () => {
  assert.equal(activityFailureReason(new Error("EISDIR: illegal operation on a directory")), "EISDIR: illegal operation on a directory");
  assert.equal(activityFailureReason("plain string failure"), "plain string failure");
});

test("no bot token leaks through an activity failure reason", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = activityFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("recordActivityFailure ledgers exactly one line carrying the cause", () => {
  const root = scratch();
  try {
    recordActivityFailure(root, dnsErr());
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "exactly one line for the failed read");
    assert.equal(lines[0].actor, "sam");
    assert.match(lines[0].summary, /fetch failed: getaddrinfo ENOTFOUND models\.invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("errorReason still resolves through telegram.js after the leaf extraction", () => {
  assert.equal(errorReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
  assert.equal(errorReason(new Error("plain")), "plain");
});
