import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectorPairFailedHistoryScorecardText, pairFailedSummary, parsePairFailedSummary } from "./connector-pairing.js";
import { recordActivity } from "./activity.js";
import { compactionFailureSummary } from "./compaction.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The connector pair failed history daily-measurement wiring
// (2026-11-23, the measured-proof series): pairConnector's
// rollback ledgers every failed pairing as a
// connector-pair-failed line through the ONE writer
// (pairFailedSummary, fixed shape "Pairing connector \"<name>\"
// at <host> using vault credential <vaultKey> failed and was
// rolled back: <reason>") - and while self-work labels single
// lines and the success side carries its own fold (the
// config-acts scorecard over connector-paired), no surface
// folds this kind, so a pairing endpoint or vault binding that
// dies on every attempt was invisible in aggregate. Every
// failure line is by construction a pairing that did not
// complete (it rolled back fully), so the verdict is attention
// when any failure was ever recorded or any line is
// unparseable, else clear. The scorecard text is a script job's
// stdout and is P3-diffed on its facts, so it is ONE line
// carrying counts only: no stamp, no reason, no connector name,
// no host, and no vault credential name - the summaries carry
// all of those, and the fold consumes and never prints them
// (distinct values surface as numbers only), and no credential
// VALUE ever enters a summary in the first place. The scorecard
// path is a pure read - it creates nothing, updates nothing,
// and pairs nothing; every state here is built through the
// ledger's own public door (recordActivity) with the seam's own
// summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-connector-pair-failed-history-"));
}

const BARE = "Connector pair failed history: clear, 0 failed, 0 distinct connectors, 0 distinct hosts, 0 distinct vault credentials, 0 total";

test("connector pair failed history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = connectorPairFailedHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = connectorPairFailedHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held pair scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("connector pair failed history scorecard: the writer's failures fold to counts with the distinct connector, host, and vault credential counts, and no name, host, credential name, or reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = connectorPairFailedHistoryScorecardText(dir);
    recordActivity(dir, "sam", "connector-pair-failed", pairFailedSummary("Sekrit Bridge", "bridge.invalid", "sekrit-key", new Error("fetch failed: getaddrinfo ENOTFOUND")));
    recordActivity(dir, "sam", "connector-pair-failed", pairFailedSummary("Sekrit Bridge", "bridge.invalid", "sekrit-key", new Error("MCP request failed (HTTP 401)")));
    recordActivity(dir, "sam", "connector-pair-failed", pairFailedSummary("Other Bridge", "other.invalid", "other-key", new Error("boom")));
    recordActivity(dir, "sam", "connector-paired", "Paired connector \"Sekrit Bridge\" at bridge.invalid using vault credential sekrit-key for profile sam (core profile - no pin row) - 0 approved read-only tool(s): none");
    const text = connectorPairFailedHistoryScorecardText(dir);
    assert.equal(text, "Connector pair failed history: attention, 3 failed, 2 distinct connectors, 2 distinct hosts, 2 distinct vault credentials, 3 total");
    assert.equal(text.includes("Sekrit"), false, "no connector name surfaces");
    assert.equal(text.includes("bridge.invalid"), false, "no host surfaces");
    assert.equal(text.includes("sekrit-key"), false, "no vault credential name surfaces");
    assert.equal(text.includes("ENOTFOUND"), false, "no verbatim reason surfaces");
    assert.notEqual(text, clean, "the first recorded failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("connector pair failed history scorecard: an unmatched shape, a sibling kind's shape, an empty-reason shape, an invalid vault name shape, and an over-long name shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "connector-pair-failed", pairFailedSummary("Bridge", "127.0.0.1", "bridge-key", new Error("boom")));
    recordActivity(dir, "sam", "connector-pair-failed", "Some wholly novel ledger shape naming sekrit_source");
    recordActivity(dir, "sam", "connector-pair-failed", compactionFailureSummary("abcdef123456", "read", "boom sekrit"));
    recordActivity(dir, "sam", "connector-pair-failed", "Pairing connector \"Bridge\" at 127.0.0.1 using vault credential bridge-key failed and was rolled back:   ");
    recordActivity(dir, "sam", "connector-pair-failed", "Pairing connector \"Bridge\" at 127.0.0.1 using vault credential Bridge_Key failed and was rolled back: boom");
    recordActivity(dir, "sam", "connector-pair-failed", "Pairing connector \"" + "x".repeat(65) + "\" at 127.0.0.1 using vault credential bridge-key failed and was rolled back: boom");
    const text = connectorPairFailedHistoryScorecardText(dir);
    assert.equal(text, "Connector pair failed history: attention, 1 failed, 1 distinct connectors, 1 distinct hosts, 1 distinct vault credentials, 6 total, 5 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("connector pair failed history parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(
    pairFailedSummary("Bridge", "127.0.0.1", "bridge-key", new Error("MCP request failed (HTTP 401)")),
    "Pairing connector \"Bridge\" at 127.0.0.1 using vault credential bridge-key failed and was rolled back: MCP request failed (HTTP 401)",
  );
  assert.deepEqual(parsePairFailedSummary(pairFailedSummary("Bridge", "127.0.0.1", "bridge-key", new Error("boom"))), { name: "Bridge", host: "127.0.0.1", vaultKey: "bridge-key" });
  assert.deepEqual(parsePairFailedSummary(pairFailedSummary("My Bridge 2.0", "mcp.example.com", "k-1", new Error("boom"))), { name: "My Bridge 2.0", host: "mcp.example.com", vaultKey: "k-1" });
  assert.equal(parsePairFailedSummary(""), null);
  assert.equal(parsePairFailedSummary("Pairing connector \"Bridge\" at 127.0.0.1 using vault credential bridge-key failed and was rolled back:"), null, "a line with no reason does not parse");
  assert.equal(parsePairFailedSummary("Pairing connector \"Bridge\" at 127.0.0.1 using vault credential bridge-key failed and was rolled back: "), null, "a line with a blank reason does not parse");
  assert.equal(parsePairFailedSummary("Pairing connector \"Bridge\" at 127.0.0.1 using vault credential Bridge_Key failed and was rolled back: boom"), null, "a vault credential name the writer never writes does not parse");
  assert.equal(parsePairFailedSummary("Pairing connector \"" + "x".repeat(65) + "\" at 127.0.0.1 using vault credential bridge-key failed and was rolled back: boom"), null, "a name longer than the writer's 64-char cap never parses");
  assert.equal(parsePairFailedSummary(compactionFailureSummary("abcdef123456", "read", "boom")), null, "a compaction-failed line never parses as a connector-pair-failed line");
  assert.deepEqual(parsePairFailedSummary("Pairing connector \"Bridge\" at 127.0.0.1 using vault credential bridge-key failed and was rolled back: boom: with colon"), { name: "Bridge", host: "127.0.0.1", vaultKey: "bridge-key" }, "a reason carrying a colon still parses from the fixed head");
});

test("connector pair failed history scorecard: repeat failures against one connector, host, and credential raise the failed count only, and a held state re-reads identically", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "connector-pair-failed", pairFailedSummary("Bridge", "127.0.0.1", "bridge-key", new Error("boom")));
    recordActivity(dir, "sam", "connector-pair-failed", pairFailedSummary("Bridge", "127.0.0.1", "bridge-key", new Error("boom again")));
    recordActivity(dir, "sam", "connector-pair-failed", pairFailedSummary("Bridge", "127.0.0.1", "bridge-key", new Error("boom a third time")));
    const text = connectorPairFailedHistoryScorecardText(dir);
    assert.equal(text, "Connector pair failed history: attention, 3 failed, 1 distinct connectors, 1 distinct hosts, 1 distinct vault credentials, 3 total");
    assert.equal(connectorPairFailedHistoryScorecardText(dir), text, "a held state re-reads identically");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("connector pair failed history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-connector-pair-failed-history"), "sam-connector-pair-failed-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-connector-pair-failed-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "connector-pair-failed-history"], "the argv rides observe connector-pair-failed-history");
});
