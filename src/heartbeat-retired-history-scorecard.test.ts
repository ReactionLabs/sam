import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent, heartbeatRetiredHistoryScorecardText, heartbeatRetiredLedgerSummary, parseHeartbeatRetiredSummary } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The heartbeat retired history daily-measurement wiring
// (2026-11-21, the measured-proof series): a one-shot job
// that has had its run is removed from the job store by the
// tick and ledgers exactly one "heartbeat-retired" line,
// but the class was never folded, so how many one-shot
// reminders ever fired and retired was invisible in
// aggregate - the job store holds nothing about a retired
// job, so the ledger line is the only record the
// retirement ever happened. Retirement is the one-shot
// lifecycle working as designed, not an alarm, so the
// verdict is attention only when a line is unparseable,
// else clear (the heartbeat-deliveries precedent). The
// scorecard text is a script job's stdout and is P3-diffed
// on its facts, so it is ONE line carrying counts only: no
// stamp, no actor, no job name. The scorecard path is a
// pure read - it creates nothing and runs and retires
// nothing; every state here is built through the ledger's
// own public door (recordActivity) with the seam's own
// summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-heartbeat-retired-history-"));
}

const BARE = "Heartbeat retired history: clear, 0 retired, 0 distinct jobs, 0 total";

test("heartbeat retired history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = heartbeatRetiredHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = heartbeatRetiredHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held retired scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("heartbeat retired history scorecard: recorded retirements fold to counts with distinct jobs as a number only", () => {
  const dir = scratch();
  try {
    const clean = heartbeatRetiredHistoryScorecardText(dir);
    recordActivity(dir, "trading", "heartbeat-retired", heartbeatRetiredLedgerSummary("sekrit reminder"));
    recordActivity(dir, "trading", "heartbeat-retired", heartbeatRetiredLedgerSummary("sekrit reminder"));
    recordActivity(dir, "sam", "heartbeat-retired", heartbeatRetiredLedgerSummary("morning stretch"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = heartbeatRetiredHistoryScorecardText(dir);
    assert.equal(text, "Heartbeat retired history: clear, 3 retired, 2 distinct jobs, 3 total");
    assert.equal(text.includes("sekrit"), false, "no job name surfaces");
    assert.equal(text.includes("morning stretch"), false, "no job name surfaces");
    assert.equal(text.includes("trading"), false, "no actor surfaces");
    assert.notEqual(text, clean, "the first recorded retirement changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("heartbeat retired history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "heartbeat-retired", heartbeatRetiredLedgerSummary("stretch"));
    recordActivity(dir, "sam", "heartbeat-retired", "One-shot heartbeat 'sekrit job' retired quietly");
    const text = heartbeatRetiredHistoryScorecardText(dir);
    assert.equal(text, "Heartbeat retired history: attention, 1 retired, 1 distinct jobs, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("heartbeat retired parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(heartbeatRetiredLedgerSummary("stretch"), "One-shot heartbeat 'stretch' fired and retired");
  assert.deepEqual(parseHeartbeatRetiredSummary(heartbeatRetiredLedgerSummary("stretch")), { job: "stretch" });
  assert.equal(parseHeartbeatRetiredSummary(""), null);
  assert.equal(parseHeartbeatRetiredSummary("One-shot heartbeat '' fired and retired"), null, "an empty job name does not parse");
  assert.equal(parseHeartbeatRetiredSummary("One-shot heartbeat 'stretch' fired and retired tonight"), null, "a line with trailing text does not parse");
});

test("heartbeat retired history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-heartbeat-retired-history"), "sam-heartbeat-retired-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-heartbeat-retired-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["heartbeats", "retired-history"], "the argv rides heartbeats retired-history");
});
