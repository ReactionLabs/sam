import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { readActivity, recordActivity } from "./activity.js";
import {
  STANDING_FILE_MAX_CHARS, listStandingFiles, readStandingFile,
  standingFileFailureSummary, standingPromptParts, standingSummary,
  writeStandingFile,
} from "./standing-files.js";
import { classifyDefect, rankDefects } from "./self-work.js";

// Standing-file read failure visibility (gap found 2026-11-14,
// hourly run 03:04): standingPromptParts swallowed every read
// failure in one whole-loop catch - a broken persona silently
// vanished from every system prompt and took the healthy files
// after it with it - and the direct readers threw raw with no
// line anywhere. The reads now follow the house contract: one
// standing-file-failed line per failed touch, the prompt path
// skips only the broken file and never breaks a turn, and the
// direct reads fail closed (one line, then the rethrow).
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-standing-fail-"));
  const db = new ChatStore(root);
  try {
    db.createAgent("dip", "Dip's helper paragraph.");
    db.createAgent("trading", "Trading paragraph.");
  } finally { db.close(); }
  return root;
}

// Plant a directory where a standing file belongs: every read
// of that path throws EISDIR, the dead-file shape.
function plantDir(root: string, profile: string, name: string) {
  mkdirSync(join(root, ".sam", "standing", profile, name + ".md"), { recursive: true });
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "standing-file-failed" });
}

test("standing-file-failed: a broken persona is skipped in the prompt, its siblings still assemble, exactly one line", () => {
  const root = scratch();
  try {
    writeStandingFile(root, "dip", "persona", "PERSONA-DIP");
    writeStandingFile(root, "dip", "owner", "OWNER-DIP");
    writeStandingFile(root, "dip", "ops", "OPS-DIP");
    rmSync(join(root, ".sam", "standing", "dip", "persona.md"));
    plantDir(root, "dip", "persona");
    const parts = standingPromptParts(root, "dip");
    assert.equal(parts.stable, "", "the broken persona is skipped, never dressed as present");
    assert.match(parts.context, /OWNER-DIP/, "the healthy owner brief still assembles");
    assert.match(parts.context, /OPS-DIP/, "the healthy ops notes still assemble - the old whole-loop catch dropped both");
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "exactly one line for the failed touch - the reader's line stands alone, the prompt catch adds none");
    assert.equal(lines[0].actor, "dip");
    assert.ok(lines[0].summary.startsWith("Standing file read failed for profile dip (persona): "), lines[0].summary);
    assert.match(lines[0].summary, /EISDIR/);
    assert.ok(!lines[0].summary.includes("OWNER-DIP"), "file content never enters the failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standing-file-failed: a healthy prompt assembly ledgers nothing", () => {
  const root = scratch();
  try {
    writeStandingFile(root, "dip", "persona", "PERSONA-DIP");
    writeStandingFile(root, "dip", "owner", "OWNER-DIP");
    const parts = standingPromptParts(root, "dip");
    assert.match(parts.stable, /PERSONA-DIP/);
    assert.match(parts.context, /OWNER-DIP/);
    assert.equal(failedLines(root).length, 0, "no failure line on the healthy path");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standing-file-failed: a dead direct read ledgers one line and rethrows, recurring per touch", () => {
  const root = scratch();
  try {
    plantDir(root, "dip", "owner");
    assert.throws(() => readStandingFile(root, "dip", "owner"), /EISDIR/, "the direct read rethrows exactly");
    assert.equal(failedLines(root).length, 1, "exactly one line for the dead read");
    assert.ok(failedLines(root)[0].summary.startsWith("Standing file read failed for profile dip (owner): "), failedLines(root)[0].summary);
    assert.throws(() => readStandingFile(root, "dip", "owner"), /EISDIR/);
    assert.equal(failedLines(root).length, 2, "a persistent failure recurs per touch - that recurrence is the countable signal");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standing-file-failed: the list read fails closed with one line, and the summary rides it", () => {
  const root = scratch();
  try {
    writeStandingFile(root, "dip", "persona", "PERSONA-DIP");
    rmSync(join(root, ".sam", "standing", "dip", "persona.md"));
    plantDir(root, "dip", "persona");
    assert.throws(() => listStandingFiles(root, "dip"), /EISDIR/, "the list rethrows instead of folding the file as absent");
    assert.equal(failedLines(root).length, 1, "exactly one line for the dead list touch");
    assert.throws(() => standingSummary(root), /EISDIR/);
    assert.equal(failedLines(root).length, 2, "the status summary's touch ledgers its own one line - no surface dies raw");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standing-file-failed: an oversized file ledgers once, is skipped in the prompt, and its siblings assemble", () => {
  const root = scratch();
  try {
    writeStandingFile(root, "dip", "persona", "PERSONA-DIP");
    const opsPath = join(root, ".sam", "standing", "dip", "ops.md");
    mkdirSync(join(root, ".sam", "standing", "dip"), { recursive: true });
    writeFileSync(opsPath, "x".repeat(STANDING_FILE_MAX_CHARS * 2 + 1));
    assert.throws(() => readStandingFile(root, "dip", "ops"), /oversized/);
    assert.equal(failedLines(root).length, 1, "the oversize refusal ledgers its one line inside the reader");
    const parts = standingPromptParts(root, "dip");
    assert.match(parts.stable, /PERSONA-DIP/, "the healthy persona still assembles");
    assert.equal(parts.context, "", "the oversized ops file is skipped");
    assert.equal(failedLines(root).length, 2, "the prompt touch ledgers exactly one more line, never two for one touch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standing-file-failed: absent files still read as absent and ledger nothing", () => {
  const root = scratch();
  try {
    assert.equal(readStandingFile(root, "dip", "persona"), null);
    assert.deepEqual(standingPromptParts(root, "sam"), { stable: "", context: "" });
    assert.deepEqual(listStandingFiles(root, "dip").map(e => e.present), [false, false, false]);
    assert.equal(failedLines(root).length, 0, "a profile with no files genuinely has none");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standing file failure summaries collapse and cap the verbatim reason", () => {
  const s = standingFileFailureSummary("dip", "persona", "EISDIR: illegal operation\n  on a directory");
  assert.ok(!s.includes("\n"), "the reason is one line");
  assert.equal(s, "Standing file read failed for profile dip (persona): EISDIR: illegal operation on a directory");
  const capped = standingFileFailureSummary("dip", "persona", "x".repeat(500));
  assert.ok(capped.length <= 200, "the summary is capped at 200");
});

test("standing-file-failed kind classifies to its own defect class keyed by phase and ranks", () => {
  const line = { at: "2026-11-14T08:00:00.000Z", actor: "dip", kind: "standing-file-failed", summary: "Standing file read failed for profile dip (persona): EISDIR" };
  assert.deepEqual(classifyDefect(line), { key: "standing-file-failed:read", label: "standing file failures (read step)" });
  const root = scratch();
  try {
    recordActivity(root, "dip", "standing-file-failed", "Standing file read failed for profile dip (persona): EISDIR");
    const ranked = rankDefects(root);
    assert.equal(ranked.find(r => r.key === "standing-file-failed:read")?.count, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
