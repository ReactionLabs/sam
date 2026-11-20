import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  agentRepinConnectorLedgerSummary,
  agentRepinInstructionsLedgerSummary,
  agentRepinModelLedgerSummary,
  agentRepinProviderLedgerSummary,
  agentRepinScorecardText,
  parseAgentRepinSummary,
} from "./agent-repins.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The agent re-pin daily-measurement wiring (2026-11-20, the
// measured-proof series): every profile re-pin has ledgered
// as an agent-repin line since the re-pin verbs landed - a
// model pin set or cleared (the agents CLI, or the config
// wizard's model section with its own suffix), a provider pin
// set or cleared, a connector pin set or cleared, and an
// instructions rewrite carrying its char count - but the
// writers were inline concatenation at five call sites and
// the class was never folded, so how often profiles are
// re-pinned, which field moves, and whether pins are set or
// cleared was invisible in aggregate, even though a re-pin
// changes what every later turn for that profile runs on.
// Re-pinning is the operator working as designed, so the
// verdict is attention only when a line is unparseable. The
// scorecard text is a script job's stdout and is P3-diffed
// on its facts, so it is ONE line carrying counts only: no
// stamp, no actor, no profile name, no model name, no
// provider id, no connector id, no instruction text - the
// summaries carry the pin values, which the fold consumes
// and never prints. The scorecard path is a pure read - it
// creates nothing and re-pins nothing; every state here is
// built through the ledger's own public door
// (recordActivity) with the module's own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-agent-repin-scorecard-"));
}

test("agent repin scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = agentRepinScorecardText(dir);
    assert.equal(text, "Agent repins: clear, 0 acts, model set 0 / cleared 0, provider set 0 / cleared 0, connector set 0 / cleared 0, instructions rewritten 0 (0 chars), 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = agentRepinScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held repin scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agent repin scorecard: the class folds to counts per field, and no pin value surfaces", () => {
  const dir = scratch();
  try {
    const clean = agentRepinScorecardText(dir);
    recordActivity(dir, "trading", "agent-repin", agentRepinModelLedgerSummary("SecretModel-9000"));
    recordActivity(dir, "trading", "agent-repin", agentRepinModelLedgerSummary(null));
    recordActivity(dir, "trading", "agent-repin", agentRepinModelLedgerSummary("SecretModel-9000", true));
    recordActivity(dir, "dip", "agent-repin", agentRepinProviderLedgerSummary("provider-x9"));
    recordActivity(dir, "dip", "agent-repin", agentRepinConnectorLedgerSummary("9d7cca45-0000-0000-0000-000000000000"));
    recordActivity(dir, "dip", "agent-repin", agentRepinConnectorLedgerSummary(null));
    recordActivity(dir, "second-shift", "agent-repin", agentRepinInstructionsLedgerSummary(348));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = agentRepinScorecardText(dir);
    assert.equal(text, "Agent repins: clear, 7 acts, model set 2 / cleared 1, provider set 1 / cleared 0, connector set 1 / cleared 1, instructions rewritten 1 (348 chars), 7 total");
    assert.equal(text.includes("SecretModel-9000"), false, "no model name surfaces");
    assert.equal(text.includes("provider-x9"), false, "no provider id surfaces");
    assert.equal(text.includes("9d7cca45"), false, "no connector id surfaces");
    assert.equal(text.includes("trading"), false, "no profile name surfaces");
    assert.notEqual(text, clean, "the first recorded repin changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agent repin scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "dip", "agent-repin", agentRepinInstructionsLedgerSummary(120));
    recordActivity(dir, "dip", "agent-repin", "Some wholly novel repin shape naming SecretModel-9000");
    const text = agentRepinScorecardText(dir);
    assert.equal(text, "Agent repins: attention, 1 acts, model set 0 / cleared 0, provider set 0 / cleared 0, connector set 0 / cleared 0, instructions rewritten 1 (120 chars), 2 total, 1 unparseable");
    assert.equal(text.includes("novel repin"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("SecretModel-9000"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agent repin parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(agentRepinModelLedgerSummary("MiniMax-M2.5"), "Model pin set to MiniMax-M2.5");
  assert.equal(agentRepinModelLedgerSummary(null), "Model pin cleared (route tier decides)");
  assert.equal(agentRepinModelLedgerSummary("MiniMax-M2.5", true), "Model pin set to MiniMax-M2.5 via config wizard");
  assert.equal(agentRepinModelLedgerSummary(null, true), "Model pin cleared (route tier decides) via config wizard");
  assert.equal(agentRepinProviderLedgerSummary("minimax"), "Provider pin set to minimax");
  assert.equal(agentRepinProviderLedgerSummary(null), "Provider pin cleared (environment provider)");
  assert.equal(agentRepinConnectorLedgerSummary("9d7cca45"), "Connector pin set to 9d7cca45");
  assert.equal(agentRepinConnectorLedgerSummary(null), "Connector pin cleared");
  assert.equal(agentRepinInstructionsLedgerSummary(348), "Instructions rewritten (348 chars)");
  assert.deepEqual(parseAgentRepinSummary(agentRepinModelLedgerSummary("MiniMax-M2.5")), { field: "model", act: "set" });
  assert.deepEqual(parseAgentRepinSummary(agentRepinModelLedgerSummary(null, true)), { field: "model", act: "cleared" });
  assert.deepEqual(parseAgentRepinSummary(agentRepinProviderLedgerSummary(null)), { field: "provider", act: "cleared" });
  assert.deepEqual(parseAgentRepinSummary(agentRepinConnectorLedgerSummary("9d7cca45")), { field: "connector", act: "set" });
  assert.deepEqual(parseAgentRepinSummary(agentRepinInstructionsLedgerSummary(348)), { field: "instructions", act: "rewritten", chars: 348 });
  assert.equal(parseAgentRepinSummary(""), null);
  assert.equal(parseAgentRepinSummary("Model pin set to "), null, "a set line with no value does not parse");
  assert.equal(parseAgentRepinSummary("Model pin cleared"), null, "a truncated cleared line does not parse");
  assert.equal(parseAgentRepinSummary("Connector pin set to "), null, "a connector set line with no id does not parse");
  assert.equal(parseAgentRepinSummary("Instructions rewritten (many chars)"), null, "a non-numeric char count does not parse");
  assert.equal(parseAgentRepinSummary("Instructions rewritten (348 chars) extra"), null, "trailing text does not parse");
});

test("agent repin scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-agent-repins"), "sam-agent-repins is allowlisted");
  const argv = scriptArgv("/some/root", "sam-agent-repins");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["agents", "scorecard"], "the argv rides agents scorecard");
});
