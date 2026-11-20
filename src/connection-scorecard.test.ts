import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  connectionScorecardText,
  pairedLedgerSummary,
  parseApprovalModeSummary,
  parseEngineConnectedSummary,
  parseEngineProviderSummary,
  parsePairedSummary,
} from "./connector-pairing.js";
import { engineConnectedLedgerSummary, engineProviderLedgerSummary } from "./engine-connect.js";
import { approvalModeLedgerSummary } from "./approval-policy.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The connection-events daily-measurement wiring (2026-11-20,
// the measured-proof series, census-finish sprint): every
// self-pairing, every coding-engine provider choice, every
// engine route connection, and every approval-mode set has
// ledgered as a connector-paired / engine-provider /
// engine-connected / approval-mode line since each seam
// landed - one line per act, in the fixed shapes the seams
// write, carrying the connector's name and host, the vault
// credential's NAME, the profile, the provider label, and the
// mode - but the classes were never folded, so how SAM came
// to be connected the way he is was invisible in aggregate.
// Every act here is an operator or owner act, so the verdict
// is attention only when a line is unparseable. The scorecard
// text is a script job's stdout and is P3-diffed on its facts,
// so it is ONE line carrying counts only: no stamp, no actor,
// no connector name, no host, no credential name, no profile,
// no tool name - a fold that printed credential names would
// point at secrets and change on every new pairing even at an
// identical shape. The scorecard path is a pure read - it
// creates nothing, pairs nothing, connects nothing, and sets
// no mode; every state here is built through the ledger's own
// public door (recordActivity) with the seams' own summary
// writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-connection-scorecard-"));
}

const APPROVED7 = ["list_edit_requests", "get_edit_request", "list_hq_clients", "get_hq_client", "list_hq_recipients", "list_hq_notifications", "get_hq_insights"];

test("connection scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = connectionScorecardText(dir);
    assert.equal(text, "Connection events: clear, 0 paired, 0 approved tools, 0 provider selected, 0 engine connected, 0 approval mode set, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = connectionScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held connection scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("connection scorecard: the live census shape folds to counts and no name, host, or credential surfaces", () => {
  const dir = scratch();
  try {
    const clean = connectionScorecardText(dir);
    recordActivity(dir, "operator", "connector-paired", pairedLedgerSummary("second-shift", "mcp.secondshiftos.com", "second-shift", "second-shift", true, []));
    recordActivity(dir, "operator", "connector-paired", pairedLedgerSummary("second-shift", "mcp.secondshiftos.com", "second-shift", "second-shift", true, APPROVED7));
    recordActivity(dir, "owner", "engine-provider", engineProviderLedgerSummary("Codex"));
    recordActivity(dir, "owner", "engine-connected", engineConnectedLedgerSummary("Codex", "codex", ["login", "status"]));
    recordActivity(dir, "owner", "approval-mode", approvalModeLedgerSummary("smart", ["skill"]));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = connectionScorecardText(dir);
    assert.equal(text, "Connection events: clear, 2 paired, 7 approved tools, 1 provider selected, 1 engine connected, 1 approval mode set, 5 total");
    assert.equal(text.includes("second-shift"), false, "no connector or credential name surfaces");
    assert.equal(text.includes("secondshiftos"), false, "no host surfaces");
    assert.equal(text.includes("Codex"), false, "no provider label surfaces");
    assert.equal(text.includes("list_hq_clients"), false, "no tool name surfaces");
    assert.notEqual(text, clean, "the first connection event changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("connection scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "operator", "connector-paired", pairedLedgerSummary("second-shift", "mcp.secondshiftos.com", "second-shift", "second-shift", true, APPROVED7));
    recordActivity(dir, "operator", "connector-paired", "Some wholly novel pairing shape mentioning sekrit hosts");
    recordActivity(dir, "owner", "approval-mode", "Approval mode set to sideways");
    const text = connectionScorecardText(dir);
    assert.equal(text, "Connection events: attention, 1 paired, 7 approved tools, 0 provider selected, 0 engine connected, 0 approval mode set, 3 total, 2 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("sideways"), false, "an unmatched mode is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("connection parse: the seams' own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    pairedLedgerSummary("second-shift", "mcp.secondshiftos.com", "second-shift", "second-shift", true, APPROVED7),
    "Paired connector \"second-shift\" at mcp.secondshiftos.com using vault credential second-shift for profile second-shift (pinned) - 7 approved read-only tool(s): list_edit_requests, get_edit_request, list_hq_clients, get_hq_client, list_hq_recipients, list_hq_notifications, get_hq_insights",
  );
  assert.equal(
    pairedLedgerSummary("Bridge", "127.0.0.1", "bridge-key", "sam", false, []),
    "Paired connector \"Bridge\" at 127.0.0.1 using vault credential bridge-key for profile sam (core profile - no pin row) - 0 approved read-only tool(s): none",
  );
  assert.equal(
    engineProviderLedgerSummary("Codex"),
    "Codex selected as the coding-engine provider (config choice; no connection was recorded or removed by this act)",
  );
  assert.equal(
    engineConnectedLedgerSummary("Codex", "codex", ["login", "status"]),
    "Codex connected as the coding-engine route via CLI reuse (auth verified by `codex login status`; SAM stored only a route marker in the engine connection store, no credentials)",
  );
  assert.equal(approvalModeLedgerSummary("smart", ["skill"]), "Approval mode set to smart (auto: skill)");
  assert.equal(approvalModeLedgerSummary("manual", []), "Approval mode set to manual");
  assert.deepEqual(parsePairedSummary(pairedLedgerSummary("second-shift", "mcp.secondshiftos.com", "second-shift", "second-shift", true, APPROVED7)), { approved: 7 });
  assert.deepEqual(parsePairedSummary(pairedLedgerSummary("Bridge", "127.0.0.1", "bridge-key", "sam", false, [])), { approved: 0 });
  assert.deepEqual(parseEngineProviderSummary(engineProviderLedgerSummary("Codex")), {});
  assert.deepEqual(parseEngineConnectedSummary(engineConnectedLedgerSummary("Codex", "codex", ["login", "status"])), {});
  assert.deepEqual(parseApprovalModeSummary(approvalModeLedgerSummary("smart", ["skill"])), { mode: "smart" });
  assert.deepEqual(parseApprovalModeSummary(approvalModeLedgerSummary("manual", [])), { mode: "manual" });
  assert.equal(parsePairedSummary(""), null);
  assert.equal(parsePairedSummary("Paired connector \"X\" at h using vault credential k for profile sam (pinned) - 1 approved read-only tool(s)"), null, "a paired line with no tool list does not parse");
  assert.equal(parseEngineProviderSummary("Codex selected as the coding-engine provider"), null, "a truncated provider line does not parse");
  assert.equal(parseEngineConnectedSummary("Codex connected as the coding-engine route"), null, "a truncated connection line does not parse");
  assert.equal(parseApprovalModeSummary("Approval mode set to sideways"), null, "an unknown mode does not parse");
  assert.equal(parseApprovalModeSummary("Some wholly novel mode shape"), null);
});

test("connection scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-connection-events"), "sam-connection-events is allowlisted");
  const argv = scriptArgv("/some/root", "sam-connection-events");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["connectors", "scorecard"], "the argv rides connectors scorecard");
});
