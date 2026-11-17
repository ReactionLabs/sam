import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamMessagesFailureReason, recordTeamMessagesFailure } from "./team-runtime.js";
import { readActivity } from "./activity.js";

// team-messages-failed failure reasons carry their cause (census sprint
// 2026-11-17): the team-messages-failed ledger line took error.message
// alone, so a failure whose wrapper hid its cause was
// countable but never diagnosable. Now the reason composes
// through errorReason (the 04:04 bridge seam): causeless
// errors keep their plain message, a non-Error reads
// through String, bot-token segments are redacted, and no
// record content ever enters the line.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-team-messages-cause-"));
}

function failedLines(root: string, kind: string) {
  return readActivity(root, 100, { kind });
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND models.invalid"), { code: "ENOTFOUND" }),
});

test("a team-messages-failed failure reason names the transport cause behind the wrapper (teamMessagesFailureReason)", () => {
  assert.equal(teamMessagesFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it (teamMessagesFailureReason)", () => {
  const err = new Error("unable to open database file", { cause: Object.assign(new Error("open"), { code: "SQLITE_CANTOPEN" }) });
  assert.equal(teamMessagesFailureReason(err), "unable to open database file: open (SQLITE_CANTOPEN)");
});

test("causeless errors keep their plain message; a non-Error throw reads through String (teamMessagesFailureReason)", () => {
  assert.equal(teamMessagesFailureReason(new Error("EISDIR: illegal operation on a directory")), "EISDIR: illegal operation on a directory");
  assert.equal(teamMessagesFailureReason("plain string failure"), "plain string failure");
});

test("no bot token leaks through a team-messages-failed failure reason (teamMessagesFailureReason)", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = teamMessagesFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("recordTeamMessagesFailure ledgers exactly one line carrying the cause", () => {
  const root = scratch();
  try {
    recordTeamMessagesFailure(root, "read", "test-label", dnsErr());
    const lines = failedLines(root, "team-messages-failed");
    assert.equal(lines.length, 1, "exactly one line for the failed touch");
    assert.match(lines[0].summary, /fetch failed: getaddrinfo ENOTFOUND models\.invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
