import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { addChannel } from "./channels.js";
import {
  bindingFailureSummary, listBindings, resolveBindingProfile, setBinding,
} from "./bindings.js";
import { classifyDefect } from "./self-work.js";

// Binding routing failure visibility (gap found 2026-11-14,
// hourly run 07:04): resolveBindingProfile swallowed a dead
// bindings store and returned the channel default - the
// designed answer for NO binding - so a bound person silently
// landed on the wrong profile, while the direct readers
// (status, CLI) threw raw with no line anywhere. The reader
// now ledgers ONE binding-failed line per failed touch and
// tags the error; the resolver still returns the default
// exactly as before, and a direct read still fails closed.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-binding-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "binding-failed" });
}

test("binding-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(bindingFailureSummary("read", "unable to open\n  database   file"), "Binding read failed: unable to open database file");
  assert.equal(bindingFailureSummary("resolve", "disk gone", "Dip Telegram"), "Binding resolve failed for channel Dip Telegram: disk gone");
  assert.equal(bindingFailureSummary("read", "x".repeat(500)).length, 200);
  const root = scratch();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", [111]);
    mkdirSync(join(root, ".sam", "bindings.db"), { recursive: true });
    assert.throws(() => listBindings(root));
    const lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.deepEqual(classifyDefect(lines[0]), { key: "binding-failed:read", label: "binding failures (read step)" });
    const resolved = resolveBindingProfile(root, channel, 111);
    assert.deepEqual(resolved, { profile: "trading", via: "default", binding: null });
    const after = failedLines(root);
    assert.equal(after.length, 2, "the resolver's touch ledgers exactly one more line, never two for one touch");
    assert.equal(after[1].actor, "trading");
    assert.ok(after[1].summary.startsWith("Binding resolve failed for channel Dip Telegram: "), after[1].summary);
    assert.deepEqual(classifyDefect(after[1]), { key: "binding-failed:resolve", label: "binding failures (resolve step)" });
    assert.ok(!after.some(l => l.summary.includes("111")), "no peer or routing record enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("binding-failed: an absent store reads empty, resolves default, and creates nothing", () => {
  const root = scratch();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", [111]);
    assert.deepEqual(listBindings(root), []);
    assert.deepEqual(resolveBindingProfile(root, channel, 111), { profile: "trading", via: "default", binding: null });
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam", "bindings.db")), false, "a pure read creates no store");
    assert.equal(existsSync(join(root, ".sam", "bindings.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("binding-failed: a healthy registry lists and resolves with zero failure lines", () => {
  const root = scratch();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN", [111]);
    setBinding(root, { channelId: channel.id, peer: "111", profile: "researcher" });
    assert.equal(listBindings(root).length, 1);
    assert.equal(resolveBindingProfile(root, channel, 111).profile, "researcher");
    assert.equal(resolveBindingProfile(root, channel, 111).via, "peer");
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
