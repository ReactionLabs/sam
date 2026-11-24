import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configWizardChannelLedgerSummary, configWizardHistoryScorecardText, parseConfigWizardSummary } from "./config-wizard.js";
import { recordActivity } from "./activity.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The config wizard history daily-measurement wiring
// (2026-11-24, the measured-proof series): the config
// wizard ledgers exactly one act as a "config-wizard" line
// through the ONE writer (configWizardChannelLedgerSummary,
// fixed shape "Channel added via config wizard: <name> ->
// <profile>") - a channel added through the guided flow -
// and while the config-acts fold covers the other seven
// configuration kinds, no surface folds this kind: how
// often the guided first-run door has ever completed its
// one save was invisible in aggregate. The channel registry
// witnesses that a channel exists, not that it arrived
// through the wizard. Adding a channel through the wizard
// is the operator working as designed, so the verdict is
// attention only when a line is unparseable, else clear
// (the config-acts rule). The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no
// channel name, no profile name, and no verbatim summary -
// and it counts wizard channel adds only, never all
// channel adds (CLI channel adds ledger nothing). The
// scorecard path is a pure read - it creates nothing,
// spends no model call, and adds nothing; every state here
// is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-config-wizard-history-"));
}

const BARE = "Config wizard history: clear, 0 added, 0 distinct channels, 0 distinct profiles, 0 total";

test("config wizard history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = configWizardHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = configWizardHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held config wizard scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("config wizard history scorecard: the writer's adds fold to counts with the distinct counts, and no channel or profile name surfaces", () => {
  const dir = scratch();
  try {
    const clean = configWizardHistoryScorecardText(dir);
    recordActivity(dir, "owner", "config-wizard", configWizardChannelLedgerSummary("Sekrit Channel", "second-shift"));
    recordActivity(dir, "owner", "config-wizard", configWizardChannelLedgerSummary("Other Channel", "trading"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = configWizardHistoryScorecardText(dir);
    assert.equal(text, "Config wizard history: clear, 2 added, 2 distinct channels, 2 distinct profiles, 2 total");
    assert.equal(text.includes("Sekrit"), false, "no channel name surfaces");
    assert.equal(text.includes("second-shift"), false, "no profile name surfaces");
    assert.equal(text.includes("trading"), false, "no profile name surfaces");
    assert.notEqual(text, clean, "the first recorded wizard add changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("config wizard history scorecard: an unmatched shape and a cross-kind shape count toward the total and the unparseable count and are never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "owner", "config-wizard", configWizardChannelLedgerSummary("Sekrit Channel", "second-shift"));
    recordActivity(dir, "owner", "config-wizard", "Some wholly novel ledger shape naming sekrit_channel");
    recordActivity(dir, "owner", "config-wizard", "Model setup verified: MiniMax-M2.5 via minimax (one real completion; recorded in the setup store)");
    recordActivity(dir, "owner", "config-wizard", "Channel added via config wizard: No profile named");
    const text = configWizardHistoryScorecardText(dir);
    assert.equal(text, "Config wizard history: attention, 1 added, 1 distinct channels, 1 distinct profiles, 4 total, 3 unparseable");
    assert.equal(text.includes("novel ledger"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("config wizard history parse: the writer is byte-identical to the ledgered shape and parses, and only the fixed shape parses", () => {
  assert.equal(
    configWizardChannelLedgerSummary("Dip Telegram", "dip"),
    "Channel added via config wizard: Dip Telegram -> dip",
  );
  assert.deepEqual(parseConfigWizardSummary(configWizardChannelLedgerSummary("Dip Telegram", "dip")), { channel: "Dip Telegram", profile: "dip" });
  assert.equal(parseConfigWizardSummary(""), null);
  assert.equal(parseConfigWizardSummary("Channel added via config wizard: Dip Telegram -> "), null, "a line with no profile does not parse");
  assert.equal(parseConfigWizardSummary("Channel added via config wizard: Dip Telegram"), null, "a line without the profile tail does not parse");
  assert.equal(parseConfigWizardSummary("Channel added via config wizard: Dip Telegram -> Second Shift"), null, "a profile outside the registry alphabet does not parse");
  assert.equal(parseConfigWizardSummary("Channel added via config wizard: Bad!Name -> dip"), null, "a channel name outside the registry alphabet does not parse");
  assert.equal(parseConfigWizardSummary("Model setup verified: MiniMax-M2.5 via minimax (one real completion; recorded in the setup store)"), null, "a setup-verified line never parses as a config-wizard line");
});

test("config wizard history scorecard: repeat adds of one channel to one profile raise the added count only, and an added state re-reads identically", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "owner", "config-wizard", configWizardChannelLedgerSummary("Dip Telegram", "dip"));
    recordActivity(dir, "owner", "config-wizard", configWizardChannelLedgerSummary("Dip Telegram", "dip"));
    recordActivity(dir, "owner", "config-wizard", configWizardChannelLedgerSummary("Dip Telegram", "dip"));
    const text = configWizardHistoryScorecardText(dir);
    assert.equal(text, "Config wizard history: clear, 3 added, 1 distinct channels, 1 distinct profiles, 3 total");
    assert.equal(configWizardHistoryScorecardText(dir), text, "an added state re-reads identically");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("config wizard history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-config-wizard-history"), "sam-config-wizard-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-config-wizard-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["config", "wizard-history"], "the argv rides config wizard-history");
});
