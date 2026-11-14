import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import {
  closeRateLimitEpisode, isRateLimitLedgered, openRateLimitEpisode,
  rateLimitEpisode, rateLimitFailureSummary, rateLimitStatus,
} from "./rate-limit.js";
import { classifyDefect } from "./self-work.js";

// Rate-limit episode failure visibility (gap found
// 2026-11-14, hourly run 08:04): the episode store was
// touched at three places, all silent - agent-turn's open
// catch spoke once-ish on ANY throw (a dead store made
// every capped turn speak, inverting the once-only
// contract), its close catch swallowed any throw (a failed
// close could silence the next cap forever), and status's
// direct read threw raw with no line anywhere. Each touch
// now ledgers ONE rate-limit-failed line and rethrows
// exactly, tagged; agent-turn's fallbacks are unchanged.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-ratelimit-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "rate-limit-failed" });
}

function plantDeadStore(root: string): void {
  mkdirSync(join(root, ".sam", "rate-limit.db"), { recursive: true });
}

test("rate-limit-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(rateLimitFailureSummary("read", "unable to open\n  database   file"), "Rate limit read failed: unable to open database file");
  assert.equal(rateLimitFailureSummary("open", "disk gone", "chat-123456789"), "Rate limit open failed for chat chat-123: disk gone");
  assert.equal(rateLimitFailureSummary("close", "x".repeat(500)).length, 200);
  for (const [phase, summary] of [["read", rateLimitFailureSummary("read", "boom")], ["open", rateLimitFailureSummary("open", "boom")], ["close", rateLimitFailureSummary("close", "boom")]] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "rate-limit-failed", summary }),
      { key: "rate-limit-failed:" + phase, label: "rate-limit episode failures (" + phase + " step)" },
    );
  }
});

test("rate-limit-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", () => {
  const root = scratch();
  try {
    plantDeadStore(root);
    assert.throws(() => rateLimitEpisode(root), (e: unknown) => isRateLimitLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Rate limit read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "rate-limit-failed:read", label: "rate-limit episode failures (read step)" });

    assert.throws(() => rateLimitStatus(root));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "the status reader's touch ledgers exactly one more line, never two for one touch");
    assert.ok(lines[1].summary.startsWith("Rate limit read failed: "), lines[1].summary);

    assert.throws(() => openRateLimitEpisode(root, "chat-abcdef123456"), (e: unknown) => isRateLimitLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3);
    assert.ok(lines[2].summary.startsWith("Rate limit open failed for chat chat-abc: "), lines[2].summary);
    assert.deepEqual(classifyDefect(lines[2]), { key: "rate-limit-failed:open", label: "rate-limit episode failures (open step)" });

    assert.throws(() => closeRateLimitEpisode(root), (e: unknown) => isRateLimitLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 4);
    assert.ok(lines[3].summary.startsWith("Rate limit close failed: "), lines[3].summary);
    assert.deepEqual(classifyDefect(lines[3]), { key: "rate-limit-failed:close", label: "rate-limit episode failures (close step)" });
    assert.ok(!lines.some(l => l.summary.includes("since")), "no episode content enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rate-limit-failed: an absent store reads closed, closes false, and creates nothing", () => {
  const root = scratch();
  try {
    assert.equal(rateLimitEpisode(root), null);
    assert.deepEqual(rateLimitStatus(root), { open: false, since: null });
    assert.equal(closeRateLimitEpisode(root), false);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam", "rate-limit.db")), false, "a pure read / absent close creates no store");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rate-limit-failed: a healthy episode opens, reads, and closes with zero failure lines", () => {
  const root = scratch();
  try {
    assert.equal(openRateLimitEpisode(root, "chat-1"), true);
    assert.equal(openRateLimitEpisode(root, "chat-2"), false);
    assert.equal(rateLimitStatus(root).open, true);
    assert.equal(closeRateLimitEpisode(root), true);
    assert.equal(rateLimitEpisode(root), null);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
