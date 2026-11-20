import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { approvalModeLedgerSummary } from "./approval-policy.js";
import { codeRootClearedLedgerSummary, codeRootDesignatedLedgerSummary } from "./code.js";
import { configActsScorecardText, parseApprovalModeSummary, parseCodeRootSummary, parseConnectorPairedSummary, parseEngineConnectedSummary, parseEngineDisconnectedSummary, parseEngineProviderSummary, parseStandingFileSummary } from "./config-acts.js";
import { connectorPairedLedgerSummary } from "./connector-pairing.js";
import { engineConnectedLedgerSummary, engineDisconnectedLedgerSummary, engineProviderDef, engineProviderLedgerSummary } from "./engine-connect.js";
import { standingFileClearedLedgerSummary, standingFileSetLedgerSummary } from "./standing-files.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The operator configuration daily-measurement wiring
// (2026-11-20, the measured-proof series): the acts that
// configure the install itself have ledgered across seven
// kinds since their seams landed - code-root designated /
// cleared, standing-file set / cleared, approval-mode sets,
// connector pairings with their approved tool counts, and
// the engine route acts (provider selected, connected,
// disconnected) - in the fixed shapes the seams' ONE
// writers write - but the family was never folded, so the
// install's configuration history was invisible in
// aggregate even though it is the highest-trust record SAM
// keeps. Configuring is the operator working as designed,
// so the verdict is attention only when a line is
// unparseable. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, and never a code-root
// path, a standing file's content, a connector's name,
// host, or vault credential name, a profile, or an approved
// tool's name. The scorecard path is a pure read - it
// creates nothing, spends no model call, and configures
// nothing; every state here is built through the ledger's
// own public door (recordActivity) with the seams' own
// summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-config-acts-scorecard-"));
}

test("config acts scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = configActsScorecardText(dir);
    assert.equal(text, "Configuration acts: clear, 0 acts, code roots designated 0 / cleared 0, standing files set 0 / cleared 0 (0 chars set), approval mode sets 0 (manual 0 / smart 0 / off 0), connectors paired 0 (0 approved tools), engine providers selected 0, engines connected 0 / disconnected 0, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = configActsScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held configuration scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("config acts scorecard: the family folds to counts and no path, name, host, credential name, or tool name surfaces", () => {
  const dir = scratch();
  try {
    const clean = configActsScorecardText(dir);
    recordActivity(dir, "operator", "code-root", codeRootDesignatedLedgerSummary("/secret/root"));
    recordActivity(dir, "operator", "code-root", codeRootDesignatedLedgerSummary("/secret/root"));
    recordActivity(dir, "dip", "standing-file", standingFileSetLedgerSummary("persona", "stable", 17));
    recordActivity(dir, "dip", "standing-file", standingFileClearedLedgerSummary("persona"));
    recordActivity(dir, "owner", "approval-mode", approvalModeLedgerSummary("smart", ["skill"]));
    recordActivity(dir, "sam", "connector-paired", connectorPairedLedgerSummary("sekrit-connector", "sekrit.example.com", "sekrit-key", "second-shift", true, []));
    recordActivity(dir, "sam", "connector-paired", connectorPairedLedgerSummary("sekrit-connector", "sekrit.example.com", "sekrit-key", "second-shift", true, ["tool_a", "tool_b", "tool_c", "tool_d", "tool_e", "tool_f", "tool_g"]));
    recordActivity(dir, "owner", "engine-provider", engineProviderLedgerSummary("Codex"));
    recordActivity(dir, "owner", "engine-connected", engineConnectedLedgerSummary(engineProviderDef("codex")));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = configActsScorecardText(dir);
    assert.equal(text, "Configuration acts: clear, 9 acts, code roots designated 2 / cleared 0, standing files set 1 / cleared 1 (17 chars set), approval mode sets 1 (manual 0 / smart 1 / off 0), connectors paired 2 (7 approved tools), engine providers selected 1, engines connected 1 / disconnected 0, 9 total");
    assert.equal(text.includes("/secret/root"), false, "no code-root path surfaces");
    assert.equal(text.includes("sekrit"), false, "no connector name, host, or credential name surfaces");
    assert.equal(text.includes("tool_a"), false, "no approved tool name surfaces");
    assert.notEqual(text, clean, "the first configuration act changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("config acts scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "operator", "code-root", codeRootDesignatedLedgerSummary("/secret/root"));
    recordActivity(dir, "dip", "standing-file", "Standing file sekrit (stable) set, 9 chars");
    const text = configActsScorecardText(dir);
    assert.equal(text, "Configuration acts: attention, 1 acts, code roots designated 1 / cleared 0, standing files set 0 / cleared 0 (0 chars set), approval mode sets 0 (manual 0 / smart 0 / off 0), connectors paired 0 (0 approved tools), engine providers selected 0, engines connected 0 / disconnected 0, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("/secret/root"), false, "no code-root path surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("config acts parse: the seams' own writer lines parse, and only the fixed shapes parse", () => {
  assert.equal(codeRootDesignatedLedgerSummary("/opt/sam/code"), "Designated code root: /opt/sam/code", "the writer is byte-identical to the shape the seam has always ledgered");
  assert.equal(codeRootClearedLedgerSummary(), "Cleared the designated code root");
  assert.equal(standingFileSetLedgerSummary("persona", "stable", 17), "Standing file persona (stable) set, 17 chars");
  assert.equal(standingFileClearedLedgerSummary("persona"), "Standing file persona cleared");
  assert.equal(approvalModeLedgerSummary("smart", ["skill"]), "Approval mode set to smart (auto: skill)");
  assert.equal(approvalModeLedgerSummary("manual", []), "Approval mode set to manual");
  assert.equal(connectorPairedLedgerSummary("second-shift", "mcp.secondshiftos.com", "second-shift", "second-shift", true, []), "Paired connector \"second-shift\" at mcp.secondshiftos.com using vault credential second-shift for profile second-shift (pinned) - 0 approved read-only tool(s): none");
  assert.equal(engineProviderLedgerSummary("Codex"), "Codex selected as the coding-engine provider (config choice; no connection was recorded or removed by this act)");
  assert.equal(engineConnectedLedgerSummary(engineProviderDef("codex")), "Codex connected as the coding-engine route via CLI reuse (auth verified by `codex login status`; SAM stored only a route marker in the engine connection store, no credentials)");
  assert.equal(engineDisconnectedLedgerSummary("Codex"), "Codex engine connection marker removed (CLI reuse route disconnected; the CLI's own login was not touched)");
  assert.deepEqual(parseCodeRootSummary(codeRootDesignatedLedgerSummary("/x")), { act: "designated" });
  assert.deepEqual(parseCodeRootSummary(codeRootClearedLedgerSummary()), { act: "cleared" });
  assert.deepEqual(parseStandingFileSummary(standingFileSetLedgerSummary("persona", "stable", 17)), { act: "set", chars: 17 });
  assert.deepEqual(parseStandingFileSummary(standingFileClearedLedgerSummary("owner")), { act: "cleared" });
  assert.deepEqual(parseApprovalModeSummary(approvalModeLedgerSummary("smart", ["skill"])), { mode: "smart" });
  assert.deepEqual(parseApprovalModeSummary(approvalModeLedgerSummary("manual", [])), { mode: "manual" });
  assert.deepEqual(parseConnectorPairedSummary(connectorPairedLedgerSummary("c", "h.example.com", "k", "sam", false, ["a", "b"])), { approved: 2 });
  assert.deepEqual(parseEngineProviderSummary(engineProviderLedgerSummary("Claude Code")), { provider: true });
  assert.deepEqual(parseEngineConnectedSummary(engineConnectedLedgerSummary(engineProviderDef("claude-code"))), { connected: true });
  assert.deepEqual(parseEngineDisconnectedSummary(engineDisconnectedLedgerSummary("Claude Code")), { disconnected: true });
  assert.equal(parseCodeRootSummary(""), null);
  assert.equal(parseStandingFileSummary("Standing file nobody (stable) set, 3 chars"), null, "an unknown standing file does not parse");
  assert.equal(parseApprovalModeSummary("Approval mode set to wild"), null, "an unknown mode does not parse");
  assert.equal(parseConnectorPairedSummary("Paired connector \"c\" at h using vault credential k"), null, "a truncated line does not parse");
  assert.equal(parseEngineProviderSummary("Some wholly novel provider shape"), null);
});

test("config acts scorecard: the script allowlist carries sam-config-acts riding the config scorecard CLI", () => {
  assert.ok(scriptCommandNames().includes("sam-config-acts"), "sam-config-acts is allowlisted");
  const argv = scriptArgv("/some/root", "sam-config-acts");
  assert.ok(argv.join(" ").includes("config"), "the argv rides the config command");
  assert.ok(argv.join(" ").includes("scorecard"), "the argv rides the scorecard subcommand");
});
