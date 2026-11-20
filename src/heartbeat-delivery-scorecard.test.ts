import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  heartbeatChangedLedgerSummary,
  heartbeatDeliveryScorecardText,
  parseHeartbeatChangedSummary,
} from "./heartbeat.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The heartbeat delivery daily-measurement wiring (2026-11-19,
// the measured-proof series): every changed heartbeat update has
// ledgered as a "heartbeat" line since P3 landed - one line per
// changed delivery, in the fixed shape the tick writes, carrying
// the job name and a 180-char reply preview - but the class was
// never folded, so how many changed updates SAM has delivered,
// and across how many distinct jobs, was invisible in aggregate
// (its failure sibling is measured; its unchanged sibling
// ledgers only in heartbeats.jsonl). A changed delivery is the
// system's normal news, not an alarm, so the verdict is
// attention only when a line is unparseable. The scorecard text
// is a script job's stdout and is P3-diffed on its facts, so it
// is ONE line carrying counts only: no stamp, no actor, no job
// name, no reply preview - a fold that printed either would
// change on every delivery even at an identical shape. The
// scorecard path is a pure read - it creates nothing, runs no
// job, and delivers nothing; every state here is built through
// the ledger's own public door (recordActivity) with the seam's
// own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-heartbeat-delivery-scorecard-"));
}

test("heartbeat delivery scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = heartbeatDeliveryScorecardText(dir);
    assert.equal(text, "Heartbeat deliveries: clear, 0 changed, 0 distinct jobs, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = heartbeatDeliveryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held heartbeat delivery scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("heartbeat delivery scorecard: deliveries fold to counts and no job name or reply preview surfaces", () => {
  const dir = scratch();
  try {
    const clean = heartbeatDeliveryScorecardText(dir);
    recordActivity(dir, "sam", "heartbeat", heartbeatChangedLedgerSummary("stack watch", "The sekrit stack verdict moved"));
    recordActivity(dir, "sam", "heartbeat", heartbeatChangedLedgerSummary("stack watch", "The sekrit stack verdict moved again"));
    recordActivity(dir, "sam", "heartbeat", heartbeatChangedLedgerSummary("backup drill", "The drill passed"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = heartbeatDeliveryScorecardText(dir);
    assert.equal(text, "Heartbeat deliveries: clear, 3 changed, 2 distinct jobs, 3 total");
    assert.equal(text.includes("stack watch"), false, "no job name surfaces");
    assert.equal(text.includes("sekrit"), false, "no reply preview surfaces");
    assert.notEqual(text, clean, "the first changed delivery changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("heartbeat delivery scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "heartbeat", heartbeatChangedLedgerSummary("stack watch", "Moved"));
    recordActivity(dir, "sam", "heartbeat", "Some wholly novel heartbeat shape mentioning sekrit updates");
    const text = heartbeatDeliveryScorecardText(dir);
    assert.equal(text, "Heartbeat deliveries: attention, 1 changed, 1 distinct jobs, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel heartbeat"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("heartbeat delivery parse: the seam's own writer line is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(
    heartbeatChangedLedgerSummary("stack watch", "Line one\n  line   two"),
    "Heartbeat 'stack watch' changed: Line one line two",
  );
  const long = "x".repeat(250);
  assert.equal(heartbeatChangedLedgerSummary("job", long), "Heartbeat 'job' changed: " + "x".repeat(180), "the preview caps at 180 chars");
  assert.deepEqual(parseHeartbeatChangedSummary(heartbeatChangedLedgerSummary("stack watch", "Moved")), { job: "stack watch" });
  assert.equal(parseHeartbeatChangedSummary(""), null);
  assert.equal(parseHeartbeatChangedSummary("Heartbeat 'stack watch' failed: boom"), null, "a failure line does not parse as a delivery");
  assert.equal(parseHeartbeatChangedSummary("Heartbeat stack watch changed: Moved"), null, "an unquoted job name does not parse");
  assert.equal(parseHeartbeatChangedSummary("Some wholly novel heartbeat shape"), null);
});

test("heartbeat delivery scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-heartbeat-deliveries"), "sam-heartbeat-deliveries is allowlisted");
  const argv = scriptArgv("/some/root", "sam-heartbeat-deliveries");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["heartbeats", "delivery-scorecard"], "the argv rides heartbeats delivery-scorecard");
});
