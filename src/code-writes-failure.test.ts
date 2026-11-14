import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { codeWriteFailureSummary, codeWrites, setCodeRoot, writeCodeFile } from "./code.js";
import { listChanges, verificationStatus } from "./verification.js";
import { classifyDefect, rankDefects } from "./self-work.js";

// Code-writes ledger failure visibility (gap found 2026-11-13,
// hourly run 17:04): both touches of .sam/code-writes.jsonl
// were unguarded, so a dead append threw out of the write path
// AFTER the file had already landed in the code root - and
// took the goldfish artifact, the activity line, and the
// verify-on-stop entry with it - while a dead read threw out
// of status, the CLI, and the coding drain's write counting
// with no trace anywhere. The append now follows the house
// contract (never throws, never blocks the remaining records,
// one code-write-failed line per failed touch) and the read
// fails closed (one line, then the rethrow) because the
// coding loop counts new writes by slicing this ledger.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-code-writes-fail-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  return { base, sam, proj };
}

// Plant a directory where the ledger file belongs: the read
// and the append both throw EISDIR, the dead-ledger shape.
function plantDir(sam: string) {
  mkdirSync(join(sam, ".sam"), { recursive: true });
  mkdirSync(join(sam, ".sam", "code-writes.jsonl"));
}

test("code-write-failed: a dead read fails closed - one read line, then the rethrow", () => {
  const { base, sam } = fixture();
  try {
    plantDir(sam);
    assert.throws(() => codeWrites(sam), /EISDIR|illegal operation/i,
      "counts folded from an unreadable writes ledger would understate the hands' work, so the read still throws");
    const lines = readActivity(sam, 100, { kind: "code-write-failed" });
    assert.equal(lines.length, 1, "exactly one line per failed read");
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Code write read failed for ledger: "), lines[0].summary);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code-write-failed: a dead append never eats a landed write - it returns, and the other records still land", () => {
  const { base, sam, proj } = fixture();
  try {
    setCodeRoot(sam, proj);
    plantDir(sam);
    let record: ReturnType<typeof writeCodeFile> | undefined;
    assert.doesNotThrow(() => { record = writeCodeFile(sam, "sam", "hello.txt", "hello ledger\n"); },
      "recording never breaks the write it records - the file is already on disk");
    assert.equal(readFileSync(join(proj, "hello.txt"), "utf8"), "hello ledger\n", "the write itself landed in the code root");
    const lines = readActivity(sam, 100, { kind: "code-write-failed" });
    assert.equal(lines.length, 1, "exactly one line per failed append");
    assert.ok(lines[0].summary.startsWith("Code write append failed for write hello.txt (created, +1/-0 lines): "), lines[0].summary);
    assert.ok(!lines[0].summary.includes("hello ledger"), "the file content never enters the line");
    assert.ok(record && !lines[0].summary.includes(record.afterHash), "no content hash enters the line");
    // The records after the append still landed: the goldfish
    // artifact exists and the verify-on-stop gate learned the
    // change exists, so it cannot read clean over this write.
    assert.ok(record && existsSync(join(sam, ".sam", "changes", record.afterHash + ".json")), "the goldfish change artifact landed");
    assert.equal(listChanges(sam).length, 1, "the verify-on-stop change entry landed");
    assert.equal(verificationStatus(sam).state, "unverified");
    assert.ok(readActivity(sam, 100, { kind: "code-write" }).length >= 1, "the code-write activity line landed");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code-write-failed: a failed append alone ledgers once - the append-only shape via a dangling symlink", () => {
  const { base, sam, proj } = fixture();
  try {
    setCodeRoot(sam, proj);
    // A symlink to a missing target: existsSync reads false, so
    // the read succeeds empty; the append follows the link and
    // dies ENOENT - the append-only failure shape.
    symlinkSync(join(base, "missing", "code-writes.jsonl"), join(sam, ".sam", "code-writes.jsonl"));
    const record = writeCodeFile(sam, "sam", "only.txt", "append only\n");
    assert.equal(record.path, "only.txt");
    assert.deepEqual(codeWrites(sam), [], "the record did not land - the ledger still reads empty, honestly");
    const lines = readActivity(sam, 100, { kind: "code-write-failed" });
    assert.equal(lines.length, 1, "the read succeeded, so only the append ledgers");
    assert.ok(lines[0].summary.startsWith("Code write append failed for write only.txt (created, +1/-0 lines): "), lines[0].summary);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code-write-failed: a persistent read failure recurs per touch - that recurrence is the countable signal", () => {
  const { base, sam } = fixture();
  try {
    plantDir(sam);
    assert.throws(() => codeWrites(sam));
    assert.throws(() => codeWrites(sam));
    const lines = readActivity(sam, 100, { kind: "code-write-failed" });
    assert.equal(lines.length, 2, "one line per failed read, two reads");
    assert.equal(lines.filter(l => l.summary.startsWith("Code write read failed")).length, 2);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code-write-failed: healthy writes record, read back, and ledger nothing", () => {
  const { base, sam, proj } = fixture();
  try {
    setCodeRoot(sam, proj);
    writeCodeFile(sam, "sam", "a.txt", "one\n");
    writeCodeFile(sam, "sam", "a.txt", "one\ntwo\n");
    const writes = codeWrites(sam);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].created, false);
    assert.equal(readActivity(sam, 100, { kind: "code-write-failed" }).length, 0, "no failure line on the healthy path");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code-write failure summaries collapse and cap the verbatim reason", () => {
  const read = codeWriteFailureSummary("read", "ledger", "EISDIR: illegal operation\n  on a directory");
  assert.ok(!read.includes("\n"), "the reason is one line");
  const append = codeWriteFailureSummary("append", "write a.txt (created, +1/-0 lines)", "x".repeat(500));
  assert.ok(append.length <= 200, "the summary is capped at 200");
  assert.ok(append.startsWith("Code write append failed for write a.txt"), "an append failure names the write it could not record");
});

test("code-write-failed kinds classify keyed by phase and rank", () => {
  const line = (summary: string) => ({ at: "2026-11-13T22:00:00.000Z", actor: "sam", kind: "code-write-failed", summary });
  assert.deepEqual(classifyDefect(line("Code write append failed for write a.txt (created, +1/-0 lines): ENOENT")),
    { key: "code-write-failed:append", label: "code-writes ledger failures (append step)" });
  assert.deepEqual(classifyDefect(line("Code write read failed for ledger: EISDIR")),
    { key: "code-write-failed:read", label: "code-writes ledger failures (read step)" });
  const { base, sam } = fixture();
  try {
    recordActivity(sam, "sam", "code-write-failed", "Code write append failed for write a.txt (created, +1/-0 lines): ENOENT");
    recordActivity(sam, "sam", "code-write-failed", "Code write read failed for ledger: EISDIR");
    const ranked = rankDefects(sam);
    assert.equal(ranked.find(r => r.key === "code-write-failed:append")?.count, 1);
    assert.equal(ranked.find(r => r.key === "code-write-failed:read")?.count, 1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
