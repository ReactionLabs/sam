import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addTeamMember, listTeamMessages, recordTeamMessagesFailure, runStandingTeam,
  teamMessagesFailureSummary, teamStatus,
} from "./team-runtime.js";
import { readActivity } from "./activity.js";
import { buildSelfWorkSpec, classifyDefect, rankDefects } from "./self-work.js";

// Team-messages ledger failure visibility (gap found
// 2026-11-14, hourly run 00:04): ledger() in team-runtime.ts
// appended to .sam/team-messages.jsonl with a bare
// writeFileSync inside runStandingTeam's try, so a dead
// append marked a completed run failed with the filesystem
// error as its result and skipped the activity + chat
// mirroring; and listTeamMessages caught ANY error into [],
// with one torn line discarding every healthy message,
// while teamStatus folds the read as truth. The append now
// never throws (one team-messages-failed line, returns
// whether it landed, mirroring proceeds); the read fails
// closed (one line, then the rethrow) and parsing is
// per-line forgiving.
function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-team-messages-")); }
function failures(root: string) {
  return readActivity(root, 100, { kind: "team-messages-failed" });
}
// Fully dead: a directory where the ledger file belongs -
// appends and reads both throw EISDIR.
function plantDir(root: string) {
  mkdirSync(join(root, ".sam", "team-messages.jsonl"), { recursive: true });
}
function addPair(root: string) {
  addTeamMember(root, { name: "ada", role: "builder", model: "builder-model" });
  addTeamMember(root, { name: "cy", role: "reviewer", model: "reviewer-model" });
}
const stubComplete = async (input: { member: { role: string } }) =>
  input.member.role === "reviewer" ? "VERDICT: approve\nGood." : "Built the widget.";

test("team-messages-failed summary: names phase and label, collapses and caps the reason", () => {
  const s = teamMessagesFailureSummary("append", "work ada -> cy", "EISDIR: illegal operation\non a directory");
  assert.ok(s.startsWith("Team messages append failed for work ada -> cy: EISDIR"), s);
  assert.ok(!s.includes("\n"), "the reason is collapsed to one line");
  assert.ok(teamMessagesFailureSummary("read", "ledger", "x".repeat(500)).length <= 200);
  assert.equal(teamMessagesFailureSummary("read", "ledger", ""), "Team messages read failed for ledger: unknown error");
});

test("a healthy standing run records all four messages with zero failure lines, and team status reads them back", async () => {
  const root = fresh();
  try {
    addPair(root);
    const run = await runStandingTeam(root, "Build the widget", { complete: stubComplete });
    assert.equal(run.status, "done");
    const messages = listTeamMessages(root);
    assert.deepEqual(messages.map(m => m.kind), ["assignment", "work", "review", "result"]);
    assert.equal(teamStatus(root).messages.length, 4);
    assert.equal(failures(root).length, 0, "healthy touches ledger no failure lines");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a dead message append never reclassifies the run: it still finishes done with its product, one failure line per message, no message text in any line", async () => {
  const root = fresh();
  try {
    addPair(root);
    plantDir(root);
    const run = await runStandingTeam(root, "Build the widget", { complete: stubComplete });
    assert.equal(run.status, "done", "the run's verdict survives its dead ledger");
    assert.equal(run.result, "Built the widget.", "the product is the run's result, not the filesystem error");
    const lines = failures(root);
    assert.equal(lines.length, 4, "assignment, work, review, and result appends each ledger exactly one line");
    assert.match(lines[0].summary, /^Team messages append failed for assignment sam -> ada: /);
    assert.match(lines[1].summary, /^Team messages append failed for work ada -> cy: /);
    assert.match(lines[2].summary, /^Team messages append failed for review cy -> ada: /);
    assert.match(lines[3].summary, /^Team messages append failed for result sam -> sam: /);
    assert.equal(lines.some(l => l.summary.includes("Built the widget")), false, "no failure line carries message text");
    // The activity mirroring below the append still ran.
    const teamLines = readActivity(root, 100).filter(l => l.kind.startsWith("team-"));
    assert.ok(teamLines.some(l => l.kind === "team-result"), "the exchange still lands in the activity ledger");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a dead message read rethrows instead of presenting a team that never spoke, with exactly one read line", () => {
  const root = fresh();
  try {
    plantDir(root);
    assert.throws(() => listTeamMessages(root), /EISDIR|illegal operation|directory/i);
    assert.equal(failures(root).length, 1);
    assert.match(failures(root)[0].summary, /^Team messages read failed for ledger: /);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an absent ledger still reads [], and one torn line is skipped instead of discarding the healthy messages", () => {
  const root = fresh();
  try {
    assert.deepEqual(listTeamMessages(root), [], "a fresh install has no team messages yet");
    assert.equal(failures(root).length, 0);
    mkdirSync(join(root, ".sam"), { recursive: true });
    const good1 = JSON.stringify({ at: "2026-11-14T00:00:00.000Z", runId: "r1", from: "sam", to: "ada", kind: "assignment", text: "Build" });
    const good2 = JSON.stringify({ at: "2026-11-14T00:01:00.000Z", runId: "r1", from: "ada", to: "cy", kind: "work", text: "Built" });
    writeFileSync(join(root, ".sam", "team-messages.jsonl"), good1 + "\n" + '{"at":"2026-11-14T00:00:30.000Z","runId":"r1","from":"ada"' + "\n" + good2 + "\n");
    const messages = listTeamMessages(root);
    assert.deepEqual(messages.map(m => m.kind), ["assignment", "work"], "the torn line is skipped, the healthy messages survive");
    assert.equal(failures(root).length, 0, "a torn line is forgiving, not a failure");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-work classifies and specs the team-messages-failed class keyed by phase", () => {
  const line = { at: "2026-11-14T00:00:00.000Z", actor: "sam", kind: "team-messages-failed", summary: teamMessagesFailureSummary("append", "work ada -> cy", "EISDIR: illegal operation on a directory") };
  const cls = classifyDefect(line);
  assert.equal(cls?.key, "team-messages-failed:append");
  assert.equal(cls?.label, "team-messages ledger failures (append step)");
  const readCls = classifyDefect({ ...line, summary: teamMessagesFailureSummary("read", "ledger", "EISDIR: illegal operation on a directory") });
  assert.equal(readCls?.key, "team-messages-failed:read");
});

test("self-work ranks and specs team-messages-failed from ledgered lines", () => {
  const root = fresh();
  try {
    recordTeamMessagesFailure(root, "append", "work ada -> cy", new Error("EISDIR: illegal operation on a directory"));
    recordTeamMessagesFailure(root, "append", "review cy -> ada", new Error("EISDIR: illegal operation on a directory"));
    const ranked = rankDefects(root);
    assert.equal(ranked[0]?.key, "team-messages-failed:append");
    assert.equal(ranked[0]?.count, 2);
    const run = buildSelfWorkSpec(root, null);
    assert.equal(run.spec?.defectKey, "team-messages-failed:append");
    assert.ok(run.spec?.files.includes("team-runtime.ts"));
    assert.ok(run.spec?.endGoal.includes("team-messages ledger stops failing"), run.spec?.endGoal);
    assert.ok(run.spec?.doneLooksLike.some(d => d.includes("fails closed")), run.spec?.doneLooksLike.join(" | "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
