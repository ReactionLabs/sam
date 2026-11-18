import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { compactionLedgerSummary, compactionScorecardText, parseCompactionSummary } from "./compaction.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The compaction daily-measurement wiring (2026-11-18, the
// measured-proof series): every successful context fold
// ledgers one compaction line carrying the chat id prefix
// and the fold's counts, but no daily surface ever counted
// the folds, so a chat that stopped compacting was invisible
// in aggregate. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it carries counts only:
// no stamp, no actor, no chat id, no verbatim summary - the
// total folds, counts per fixed route bucket, and the
// summed folded and kept-verbatim counts, and an unmatched
// shape counts as a fold under other, never printed. The
// scorecard path is a pure read - it creates nothing,
// spends no model call, and folds nothing; every state here
// is built through the ledger's own public door
// (recordActivity) with the fold's own summary writer
// (compactionLedgerSummary), never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-compaction-scorecard-"));
}

test("compaction scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = compactionScorecardText(dir);
    assert.match(text, /^Compactions: clear$/m);
    assert.match(text, /^Folds: 0$/m);
    assert.match(text, /^By route: none$/m);
    assert.match(text, /^Messages folded: 0$/m);
    assert.match(text, /^Kept verbatim: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = compactionScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held compaction scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compaction scorecard: folds flip the verdict, count per route, sum the counts, and leak no chat id", () => {
  const dir = scratch();
  try {
    const clean = compactionScorecardText(dir);
    recordActivity(dir, "sam", "compaction", compactionLedgerSummary("16e058ea-aaaa", 63, 63, 12, false));
    recordActivity(dir, "dip", "compaction", compactionLedgerSummary("feedbeef-bbbb", 2, 65, 12, false));
    recordActivity(dir, "sam", "compaction", compactionLedgerSummary("cafef00d-cccc", 5, 20, 12, true));
    recordActivity(dir, "sam", "compaction", "Some wholly novel fold shape mentioning sekritchat");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = compactionScorecardText(dir);
    assert.match(text, /^Compactions: attention$/m);
    assert.match(text, /^Folds: 4$/m);
    assert.match(text, /^By route: flushed 2, visitor 1, other 1$/m);
    assert.match(text, /^Messages folded: 70$/m);
    assert.match(text, /^Kept verbatim: 36$/m);
    assert.equal(text.includes("sekrit"), false, "no chat id surfaces");
    assert.equal(text.includes("16e058ea"), false, "a parsed chat id is never printed");
    assert.equal(text.includes("novel fold"), false, "an unmatched summary is never printed");
    assert.notEqual(text, clean, "the first fold changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compaction parse: the fold's own lines parse, and only the fixed shapes parse", () => {
  assert.deepEqual(parseCompactionSummary(compactionLedgerSummary("16e058ea-aaaa", 63, 63, 12, false)), { folded: 63, covered: 63, kept: 12, route: "flushed" });
  assert.deepEqual(parseCompactionSummary(compactionLedgerSummary("feedbeef-bbbb", 2, 65, 12, true)), { folded: 2, covered: 65, kept: 12, route: "visitor" });
  assert.equal(parseCompactionSummary(""), null);
  assert.equal(parseCompactionSummary("Some wholly novel fold shape"), null);
  assert.equal(parseCompactionSummary("Compacted chat 16e058ea: folded 2 messages (65 covered), 12 kept verbatim somewhere else"), null);
});

test("compaction scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-compactions"), "sam-compactions is allowlisted");
  const argv = scriptArgv("/some/root", "sam-compactions");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["compaction", "scorecard"], "the argv rides compaction scorecard");
});
