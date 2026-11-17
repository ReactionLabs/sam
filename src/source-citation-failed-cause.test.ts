import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceCitationFailureReason, sourceCitationFailureSummary } from "./source-citations.js";
import { readActivity } from "./activity.js";

// source-citation-failed failure reasons carry their cause (census sprint
// 2026-11-17): the source-citation-failed ledger line took error.message
// alone, so a failure whose wrapper hid its cause was
// countable but never diagnosable. Now the reason composes
// through errorReason (the 04:04 bridge seam): causeless
// errors keep their plain message, a non-Error reads
// through String, bot-token segments are redacted, and no
// record content ever enters the line.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-source-citation-cause-"));
}

function failedLines(root: string, kind: string) {
  return readActivity(root, 100, { kind });
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND models.invalid"), { code: "ENOTFOUND" }),
});

test("a source-citation-failed failure reason names the transport cause behind the wrapper (sourceCitationFailureReason)", () => {
  assert.equal(sourceCitationFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it (sourceCitationFailureReason)", () => {
  const err = new Error("unable to open database file", { cause: Object.assign(new Error("open"), { code: "SQLITE_CANTOPEN" }) });
  assert.equal(sourceCitationFailureReason(err), "unable to open database file: open (SQLITE_CANTOPEN)");
});

test("causeless errors keep their plain message; a non-Error throw reads through String (sourceCitationFailureReason)", () => {
  assert.equal(sourceCitationFailureReason(new Error("EISDIR: illegal operation on a directory")), "EISDIR: illegal operation on a directory");
  assert.equal(sourceCitationFailureReason("plain string failure"), "plain string failure");
});

test("no bot token leaks through a source-citation-failed failure reason (sourceCitationFailureReason)", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = sourceCitationFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("sourceCitationFailureSummary composes the cause into the line", () => {
  assert.equal(sourceCitationFailureSummary("read", dnsErr()), "Source citation read failed: fetch failed: getaddrinfo ENOTFOUND models.invalid");
  assert.equal(sourceCitationFailureSummary("read", new Error("plain")), "Source citation read failed: plain");
});
