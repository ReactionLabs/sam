import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import {
  recordSkillCatalogFailure, skillCatalogFailureReason, skillCatalogFailureSummary, skillCatalogForPrompt,
} from "./own-tools.js";

// Skill catalog failure reasons carry their cause (gap
// found 2026-11-17, hourly run 09:04 EST): the
// skill-catalog-failed ledger line took error.message
// alone, so a discovery death whose wrapper hides the
// transport or store cause behind it was countable but
// never diagnosable. Now the reason composes through
// errorReason (the 04:04 bridge seam): causeless errors
// keep their plain message, a non-Error reads through
// String, bot-token segments are redacted, and no skill
// name or content ever enters the line.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-skillcatalog-cause-"));
}

function seedSkill(root: string, name: string, description: string, body: string): void {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: " + name + "\ndescription: " + description + "\n---\n" + body);
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "skill-catalog-failed" });
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND models.invalid"), { code: "ENOTFOUND" }),
});

test("a skill catalog failure reason names the transport cause behind the wrapper", () => {
  assert.equal(skillCatalogFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
  assert.equal(
    skillCatalogFailureSummary("dip", skillCatalogFailureReason(dnsErr())),
    "Skill catalog assemble failed for dip: fetch failed: getaddrinfo ENOTFOUND models.invalid",
  );
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new Error("unable to open database file", { cause: Object.assign(new Error("open"), { code: "SQLITE_CANTOPEN" }) });
  assert.equal(skillCatalogFailureReason(err), "unable to open database file: open (SQLITE_CANTOPEN)");
});

test("causeless errors keep their plain message; a non-Error throw reads through String", () => {
  assert.equal(skillCatalogFailureReason(new Error("allowlist store is a directory")), "allowlist store is a directory");
  assert.equal(skillCatalogFailureReason("plain string failure"), "plain string failure");
});

test("no bot token leaks through a skill catalog failure reason", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = skillCatalogFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("recordSkillCatalogFailure ledgers exactly one line carrying the cause, naming no skill", () => {
  const root = scratch();
  try {
    recordSkillCatalogFailure(root, "dip", dnsErr());
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "exactly one line for the failed assembly");
    assert.equal(lines[0].actor, "dip");
    assert.match(lines[0].summary, /fetch failed: getaddrinfo ENOTFOUND models\.invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a dead allowlist store still returns the empty catalog with exactly one caused line", () => {
  const root = scratch();
  try {
    seedSkill(root, "agent-reach", "Reach the public web", "SECRET-BODY-TEXT");
    mkdirSync(join(root, ".sam", "skill-allowlists.db"), { recursive: true });
    const line = skillCatalogForPrompt(root, "dip");
    assert.equal(line, "", "a failed discovery reads exactly as an empty catalog does, as before");
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "exactly one line for the failed assembly");
    assert.equal(lines[0].actor, "dip");
    assert.ok(lines[0].summary.startsWith("Skill catalog assemble failed for dip: "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("agent-reach"), "no skill name enters the failure line");
    assert.ok(!lines[0].summary.includes("SECRET-BODY-TEXT"), "no skill content enters the failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
