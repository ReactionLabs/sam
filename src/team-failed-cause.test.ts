import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTeamMember, runStandingTeam, teamFailureReason } from "./team-runtime.js";
import { readActivity } from "./activity.js";

// Standing team run failures carry their cause (gap found
// 2026-11-16, hourly run 21:04 EST): runStandingTeam's catch
// took error.message alone over the worker and reviewer
// model completions, so a member call dying on transport
// read the bare "fetch failed" wrapper in both the stored
// result and the ONE team-failed activity line. The reason
// now composes through errorReason (the 04:04 bridge seam)
// via teamFailureReason: causeless errors keep their plain
// message, a non-Error throw keeps the "Team run failed"
// fallback, no bot token leaks, and the task text never
// enters a failure record.

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-team-cause-")); }

function addPair(root: string) {
  addTeamMember(root, { name: "ada", role: "builder", model: "builder-model" });
  addTeamMember(root, { name: "cy", role: "reviewer", model: "reviewer-model" });
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND models.invalid"), { code: "ENOTFOUND" }),
});

test("a team failure reason names the transport cause behind the wrapper", () => {
  assert.equal(teamFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  assert.equal(teamFailureReason(err), "fetch failed: read (ECONNRESET)");
});

test("causeless team errors keep their plain message; a non-Error throw keeps the fallback", () => {
  assert.equal(teamFailureReason(new Error("Unsafe model output")), "Unsafe model output");
  assert.equal(teamFailureReason("plain string failure"), "Team run failed");
});

test("no bot token leaks through a team failure reason", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = teamFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("a standing run dying on transport stores the cause and ledgers exactly one team-failed line carrying it", async () => {
  const root = scratch();
  try {
    addPair(root);
    const run = await runStandingTeam(root, "Build the secret widget plan", {
      complete: async () => { throw dnsErr(); },
    });
    assert.equal(run.status, "failed");
    assert.equal(run.result, "fetch failed: getaddrinfo ENOTFOUND models.invalid");
    const failed = readActivity(root, 100, { kind: "team-failed" });
    assert.equal(failed.length, 1, "exactly one team-failed line per failed run");
    assert.match(failed[0].summary, /fetch failed: getaddrinfo ENOTFOUND models\.invalid/);
    assert.equal(failed[0].summary.includes("secret widget"), false, "the task text never enters the failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a standing run dying on a causeless error reads byte-identically, and a non-Error throw keeps the fallback", async () => {
  const root = scratch();
  try {
    addPair(root);
    const run = await runStandingTeam(root, "Build the widget", {
      complete: async () => { throw new Error("Unsafe model output"); },
    });
    assert.equal(run.status, "failed");
    assert.equal(run.result, "Unsafe model output");
    const failed = readActivity(root, 100, { kind: "team-failed" });
    assert.equal(failed.length, 1);
    assert.match(failed[0].summary, /: Unsafe model output$/);
  } finally { rmSync(root, { recursive: true, force: true }); }

  const root2 = scratch();
  try {
    addPair(root2);
    const run = await runStandingTeam(root2, "Build the widget", {
      complete: async () => { throw "plain string failure"; },
    });
    assert.equal(run.status, "failed");
    assert.equal(run.result, "Team run failed");
  } finally { rmSync(root2, { recursive: true, force: true }); }
});
