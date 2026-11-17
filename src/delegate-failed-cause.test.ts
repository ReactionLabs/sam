import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { delegateFailureReason, delegateFailedSummary, runApprovedDelegation, getDelegation, listDelegations } from "./coding-operatives.js";
import { readActivity } from "./activity.js";

// Delegation failures carry their cause (gap found
// 2026-11-17, hourly run 01:04 EST): runApprovedDelegation's
// catch took error.message alone over the operative
// registry/lease doors, worktree git, filesystem writes,
// and the operative spawn, so an error carrying its real
// reason on error.cause read the bare wrapper in every
// record of the death - the stored summary, the ONE
// delegate-failed activity line, and the chat report. The
// reason now composes through errorReason (the 04:04
// bridge seam) via delegateFailureReason: causeless errors
// keep their plain message, a non-Error throw keeps the
// "failed" fallback, no bot token leaks, and the prompt
// text never enters a failure record.

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-delegate-cause-")); }

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sam-delegate-cause-repo-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "operative@example.com"]);
  git(dir, ["config", "user.name", "Operative Test"]);
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND models.invalid"), { code: "ENOTFOUND" }),
});

test("a delegation failure reason names the transport cause behind the wrapper", () => {
  assert.equal(delegateFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND models.invalid");
  assert.equal(delegateFailedSummary("failed", dnsErr()), "Delegation failed: fetch failed: getaddrinfo ENOTFOUND models.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  assert.equal(delegateFailureReason(err), "fetch failed: read (ECONNRESET)");
});

test("causeless delegation errors keep their plain message; a non-Error throw keeps the fallback", () => {
  assert.equal(delegateFailureReason(new Error("Unsafe model output")), "Unsafe model output");
  assert.equal(delegateFailureReason("plain string failure"), "failed");
  assert.equal(delegateFailedSummary("failed", "plain string failure"), "Delegation failed: failed");
});

test("no bot token leaks through a delegation failure reason", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const reason = delegateFailureReason(err);
  assert.equal(reason.includes("AAE-secret_token"), false);
  assert.equal(reason.includes("987654"), false);
  assert.match(reason, /bot<redacted>/);
});

test("a delegation dying on transport stores the cause and ledgers exactly one delegate-failed line carrying it", async () => {
  const root = scratch();
  const source = repo();
  try {
    const detail = JSON.stringify({ adapter: "codex", repo: source, branch: "sam/cause-job", prompt: "write the secret widget note", timeoutMs: 5000 });
    await assert.rejects(
      runApprovedDelegation(root, { id: "action-cause-1", actor: "sam", chatId: null, detail }, process.env, async () => { throw dnsErr(); }),
    );
    const jobs = listDelegations(root);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "failed");
    assert.equal(jobs[0].summary, "Delegation failed: fetch failed: getaddrinfo ENOTFOUND models.invalid");
    const stored = getDelegation(root, jobs[0].id);
    assert.equal(stored?.summary, jobs[0].summary);
    const failed = readActivity(root, 100, { kind: "delegate-failed" });
    assert.equal(failed.length, 1, "exactly one delegate-failed line per failed run");
    assert.match(failed[0].summary, /fetch failed: getaddrinfo ENOTFOUND models\.invalid/);
    assert.equal(failed[0].summary.includes("secret widget"), false, "the prompt text never enters the failure line");
    assert.equal((jobs[0].summary ?? "").includes("secret widget"), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true }); }
});

test("a delegation dying on a causeless error reads byte-identically, and a non-Error throw keeps the fallback", async () => {
  const root = scratch();
  const source = repo();
  try {
    const detail = JSON.stringify({ adapter: "codex", repo: source, branch: "sam/plain-job", prompt: "write a note", timeoutMs: 5000 });
    await assert.rejects(
      runApprovedDelegation(root, { id: "action-cause-2", actor: "sam", chatId: null, detail }, process.env, async () => { throw new Error("Unsafe model output"); }),
    );
    const jobs = listDelegations(root);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].summary, "Delegation failed: Unsafe model output");
    const failed = readActivity(root, 100, { kind: "delegate-failed" });
    assert.equal(failed.length, 1);
    assert.match(failed[0].summary, /Delegation failed: Unsafe model output/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true }); }

  const root2 = scratch();
  const source2 = repo();
  try {
    const detail = JSON.stringify({ adapter: "codex", repo: source2, branch: "sam/string-job", prompt: "write a note", timeoutMs: 5000 });
    await assert.rejects(
      runApprovedDelegation(root2, { id: "action-cause-3", actor: "sam", chatId: null, detail }, process.env, async () => { throw "plain string failure"; }),
    );
    const jobs = listDelegations(root2);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "failed");
    assert.equal(jobs[0].summary, "Delegation failed: failed");
  } finally { rmSync(root2, { recursive: true, force: true }); rmSync(source2, { recursive: true, force: true }); }
});
