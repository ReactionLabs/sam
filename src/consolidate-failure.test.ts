import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consolidatePreferences, consolidationFailureSummary, heartbeatLog } from "./heartbeat.js";
import { ChatStore } from "./chats.js";
import { readActivity } from "./activity.js";
import { classifyDefect, rankDefects } from "./self-work.js";

// Consolidation sub-step failure visibility (gap found 2026-11-13):
// the scan's correction routing and the skill curator swallowed
// their throws, so a failing sub-step read exactly like a healthy
// one - and a correction whose routing died was lost for good
// once the scan watermark passed it. Each failed sub-step now
// writes ONE consolidate-failed activity line per run.

test("consolidationFailureSummary names the step, the count, and the reason", () => {
  const one = consolidationFailureSummary("corrections", 1, "unable to open database file");
  assert.match(one, /correction routing failed for 1 message: unable to open database file/);
  const many = consolidationFailureSummary("corrections", 3, "file is  not\n a database");
  assert.match(many, /failed for 3 messages: file is not a database/);
  const curator = consolidationFailureSummary("curator", 1, "unable to open database file");
  assert.match(curator, /^Consolidation skill curator failed: unable to open database file$/);
  assert.ok(consolidationFailureSummary("curator", 1, "x".repeat(500)).length <= 200);
});

test("a correction whose routing throws is ledgered once per run, and the scan still completes", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-consolidate-failure-"));
  try {
    const db = new ChatStore(root);
    const chat = db.create("Desk", "trading");
    db.add(chat.id, "user", "don't call them leads, call them inquiries");
    db.add(chat.id, "user", "stop calling it a mini");
    db.close();
    // The gate's store cannot open: every correction routing in
    // the scan throws (the persistent shape - a locked or corrupt
    // actions.db), while chats/preferences stay healthy.
    mkdirSync(join(root, ".sam", "actions.db"), { recursive: true });
    const first = consolidatePreferences(root);
    assert.equal(first.corrections, 0);
    assert.equal(first.correctionFailures, 2);
    assert.equal(first.curatorFailed, false);
    const lines = readActivity(root, 50, { kind: "consolidate-failed" });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.match(lines[0].summary, /correction routing failed for 2 messages: /);
    // The message content itself never enters the failure line.
    assert.doesNotMatch(lines[0].summary, /inquiries|mini/);
    // The class feeds the self-work defect queue, keyed by step.
    assert.equal(classifyDefect(lines[0])?.key, "consolidate-failed:corrections");
    assert.equal(rankDefects(root).find((d) => d.key === "consolidate-failed:corrections")?.count, 1);
    // The heartbeat log's consolidate entry carries the count too.
    const entry = heartbeatLog(root, 50).find((e) => e.type === "consolidate");
    assert.equal(entry?.correctionFailures, 2);
    assert.equal(entry?.curatorFailed, false);
    // The watermark advanced (the loss is recorded, not retried):
    // a second run scans nothing and writes no second line.
    const second = consolidatePreferences(root);
    assert.equal(second.correctionFailures, 0);
    assert.equal(readActivity(root, 50, { kind: "consolidate-failed" }).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a curator whose store throws is ledgered once, and consolidation still completes", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-consolidate-failure-"));
  try {
    // The curator store cannot open (a directory where its DB
    // belongs): every curator pass throws before recording.
    mkdirSync(join(root, ".sam", "skill-curator.db"), { recursive: true });
    const result = consolidatePreferences(root);
    assert.equal(result.curatorFailed, true);
    assert.equal(result.correctionFailures, 0);
    assert.deepEqual(result.curator, []);
    const lines = readActivity(root, 50, { kind: "consolidate-failed" });
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /skill curator failed: /);
    assert.equal(classifyDefect(lines[0])?.key, "consolidate-failed:curator");
    const entry = heartbeatLog(root, 50).find((e) => e.type === "consolidate");
    assert.equal(entry?.curatorFailed, true);
    assert.equal(entry?.correctionFailures, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a clean consolidation writes no consolidate-failed line", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-consolidate-failure-"));
  try {
    const db = new ChatStore(root);
    const chat = db.create("Desk", "trading");
    db.add(chat.id, "user", "don't call them leads, call them inquiries");
    db.close();
    const result = consolidatePreferences(root);
    assert.equal(result.corrections, 1);
    assert.equal(result.correctionFailures, 0);
    assert.equal(result.curatorFailed, false);
    assert.equal(readActivity(root, 50, { kind: "consolidate-failed" }).length, 0);
    const entry = heartbeatLog(root, 50).find((e) => e.type === "consolidate");
    assert.equal(entry?.correctionFailures, 0);
    assert.equal(entry?.curatorFailed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
