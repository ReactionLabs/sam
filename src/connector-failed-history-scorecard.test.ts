import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConnectorFailedSummary, connectorFailedHistoryScorecardText, connectorFailureSummary } from "./connectors.js";
import { recordActivity } from "./activity.js";
import { linkFailureSummary } from "./links.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The connector failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): the connector
// registry ledgers every failed store touch as a
// connector-failed line through the ONE writer
// connectorFailureSummary (one fixed shape: "Connector
// <phase> failed: <reason>", phases read / lookup / write,
// ledger actor sam always), ridden by recordConnectorFailure
// from the registry every turn loop authorizes from - but
// the class was never folded, so how often the authorization
// registry itself died was invisible in aggregate. Every
// failure line is by construction a connector store touch
// that did not complete, so the verdict is attention when
// any failure was ever recorded or any line is unparseable,
// else clear. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp and no verbatim reason - the
// summaries carry reasons, and the fold consumes and never
// prints them, and no connector record ever surfaces (URLs,
// credential names, and allowedTools are authorization
// data, not failure data). The scorecard path is a pure
// read - it creates nothing, sends nothing, and retries
// nothing; every state here is built through the ledger's
// own public door (recordActivity) with the seam's own
// summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-connector-failed-history-"));
}

const BARE = "Connector failed history: clear, 0 failed, 0 read, 0 lookup, 0 write, 0 total";

test("connector failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = connectorFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = connectorFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held connector scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("connector failed history scorecard: the writer's failures fold to counts per phase, and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = connectorFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "connector-failed", connectorFailureSummary("read", "database is locked sekrit"));
    recordActivity(dir, "sam", "connector-failed", connectorFailureSummary("read", "disk full"));
    recordActivity(dir, "sam", "connector-failed", connectorFailureSummary("lookup", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "connector-failed", connectorFailureSummary("write", "EACCES: permission denied"));
    recordActivity(dir, "sam", "connector-failed", connectorFailureSummary("write", "EISDIR: illegal operation"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = connectorFailedHistoryScorecardText(dir);
    assert.equal(text, "Connector failed history: attention, 5 failed, 2 read, 1 lookup, 2 write, 5 total");
    assert.equal(text.includes("sekrit"), false, "no verbatim reason surfaces");
    assert.equal(text.includes("EPERM"), false, "no reason head surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("connector failed history scorecard: the writer's own line cap still folds from the fixed head", () => {
  const dir = scratch();
  try {
    const capped = connectorFailureSummary("write", "x".repeat(500));
    assert.equal(capped.length, 200, "the writer caps its line at 200");
    assert.deepEqual(parseConnectorFailedSummary(capped), { phase: "write" });
    recordActivity(dir, "sam", "connector-failed", capped);
    const text = connectorFailedHistoryScorecardText(dir);
    assert.equal(text, "Connector failed history: attention, 1 failed, 0 read, 0 lookup, 1 write, 1 total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("connector failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, and an unknown-phase shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "connector-failed", connectorFailureSummary("read", "EPERM: operation not permitted"));
    recordActivity(dir, "sam", "connector-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "connector-failed", linkFailureSummary("read", "sam", "boom sekrit"));
    recordActivity(dir, "sam", "connector-failed", "Connector read failed:   ");
    recordActivity(dir, "sam", "connector-failed", "Connector delete failed: boom");
    const text = connectorFailedHistoryScorecardText(dir);
    assert.equal(text, "Connector failed history: attention, 1 failed, 1 read, 0 lookup, 0 write, 5 total, 4 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("connector failed parse: the writer is byte-identical to the ledgered shapes and parses, and only the fixed shapes parse", () => {
  assert.equal(connectorFailureSummary("read", "database is locked"), "Connector read failed: database is locked");
  assert.equal(connectorFailureSummary("lookup", "database is locked"), "Connector lookup failed: database is locked");
  assert.equal(connectorFailureSummary("write", "database is locked"), "Connector write failed: database is locked");
  assert.deepEqual(parseConnectorFailedSummary(connectorFailureSummary("read", "boom")), { phase: "read" });
  assert.deepEqual(parseConnectorFailedSummary(connectorFailureSummary("lookup", "boom")), { phase: "lookup" });
  assert.deepEqual(parseConnectorFailedSummary(connectorFailureSummary("write", "boom")), { phase: "write" });
  assert.equal(parseConnectorFailedSummary(""), null);
  assert.equal(parseConnectorFailedSummary("Connector read failed:"), null, "a line with no reason does not parse");
  assert.equal(parseConnectorFailedSummary("Connector read failed: "), null, "a line with a blank reason does not parse");
  assert.equal(parseConnectorFailedSummary("Connector delete failed: boom"), null, "a phase the door never writes does not parse");
  assert.equal(parseConnectorFailedSummary(linkFailureSummary("read", "sam", "boom")), null, "a link-failed line never parses as a connector-failed line");
  assert.deepEqual(parseConnectorFailedSummary("Connector read failed: boom: with colon"), { phase: "read" }, "a reason carrying a colon still parses from the fixed head");
});

test("connector failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-connector-failed-history"), "sam-connector-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-connector-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "connector-failed-history"], "the argv rides observe connector-failed-history");
});
