import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillAuthorsStoreFailureReason, recordSkillAuthorsStoreFailure, skillCuratorStoreFailureReason, recordSkillCuratorStoreFailure } from "./skill-author.js";
import { readActivity } from "./activity.js";

// skill-authors-store-failed failure reasons carry their cause (census sprint
// 2026-11-17): the skill-authors-store-failed ledger line took error.message
// alone, so a failure whose wrapper hid its cause was
// countable but never diagnosable. Now the reason composes
// through errorReason (the 04:04 bridge seam): causeless
// errors keep their plain message, a non-Error reads
// through String, bot-token segments are redacted, and no
// record content ever enters the line.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-skill-authors-cause-"));
}

function failedLines(root: string, kind: string) {
  return readActivity(root, 100, { kind });
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND models.invalid"), { code: "ENOTFOUND" }),
});

test("a skill-authors-store-failed failure reason names the transport cause behind the wrapper (skillAuthorsStoreFailureReason)", () => {
  assert.equal(skillAuthorsStoreFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it (skillAuthorsStoreFailureReason)", () => {
  const err = new Error("unable to open database file", { cause: Object.assign(new Error("open"), { code: "SQLITE_CANTOPEN" }) });
  assert.equal(skillAuthorsStoreFailureReason(err), "unable to open database file: open (SQLITE_CANTOPEN)");
});

test("causeless errors keep their plain message; a non-Error throw reads through String (skillAuthorsStoreFailureReason)", () => {
  assert.equal(skillAuthorsStoreFailureReason(new Error("EISDIR: illegal operation on a directory")), "EISDIR: illegal operation on a directory");
  assert.equal(skillAuthorsStoreFailureReason("plain string failure"), "plain string failure");
});

test("no bot token leaks through a skill-authors-store-failed failure reason (skillAuthorsStoreFailureReason)", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = skillAuthorsStoreFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("recordSkillAuthorsStoreFailure ledgers exactly one line carrying the cause", () => {
  const root = scratch();
  try {
    recordSkillAuthorsStoreFailure(root, "read", dnsErr());
    const lines = failedLines(root, "skill-authors-store-failed");
    assert.equal(lines.length, 1, "exactly one line for the failed touch");
    assert.match(lines[0].summary, /fetch failed: getaddrinfo ENOTFOUND models\.invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a skill-curator-store-failed failure reason names the transport cause behind the wrapper (skillCuratorStoreFailureReason)", () => {
  assert.equal(skillCuratorStoreFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it (skillCuratorStoreFailureReason)", () => {
  const err = new Error("unable to open database file", { cause: Object.assign(new Error("open"), { code: "SQLITE_CANTOPEN" }) });
  assert.equal(skillCuratorStoreFailureReason(err), "unable to open database file: open (SQLITE_CANTOPEN)");
});

test("causeless errors keep their plain message; a non-Error throw reads through String (skillCuratorStoreFailureReason)", () => {
  assert.equal(skillCuratorStoreFailureReason(new Error("EISDIR: illegal operation on a directory")), "EISDIR: illegal operation on a directory");
  assert.equal(skillCuratorStoreFailureReason("plain string failure"), "plain string failure");
});

test("no bot token leaks through a skill-curator-store-failed failure reason (skillCuratorStoreFailureReason)", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = skillCuratorStoreFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("recordSkillCuratorStoreFailure ledgers exactly one line carrying the cause", () => {
  const root = scratch();
  try {
    recordSkillCuratorStoreFailure(root, "read", dnsErr());
    const lines = failedLines(root, "skill-curator-store-failed");
    assert.equal(lines.length, 1, "exactly one line for the failed touch");
    assert.match(lines[0].summary, /fetch failed: getaddrinfo ENOTFOUND models\.invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
