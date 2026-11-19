import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import {
  parseVaultRemoveSummary,
  parseVaultSetSummary,
  parseVaultUseSummary,
  vaultCloneUseLedgerSummary,
  vaultConnectorUseLedgerSummary,
  vaultPushUseLedgerSummary,
  vaultRemoveLedgerSummary,
  vaultScorecardText,
  vaultSetLedgerSummary,
} from "./vault.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The vault daily-measurement wiring (2026-11-19, the
// measured-proof series): every vault deposit, removal, and
// use has ledgered as a vault-set / vault-remove / vault-use
// line since the vault landed - one line per custody event,
// in the fixed shapes the seams write, carrying the credential
// name, surface, and outcome, never the value - but the
// classes were never folded, so how many credentials SAM holds
// deposits for, how often one is spent, on which surface, and
// whether any spend failed was invisible in aggregate. Until
// 2026-11-19 the classes held no real credential at all; the
// day the first one landed it was spent within the hour, and
// only a fold makes that custody a standing fact. The verdict
// is attention only when a use failed or a line is
// unparseable: a deposit or removal is an operator act, a
// failed spend is the news. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it is ONE
// line carrying counts only: no stamp, no actor, no credential
// name, no host, and no purpose - a vault fold that printed
// names would leak the custody map it exists to watch. The
// scorecard path is a pure read - it creates nothing, opens no
// credential, and spends nothing; every state here is built
// through the ledger's own public door (recordActivity) with
// the seams' own summary writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-vault-scorecard-"));
}

test("vault scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = vaultScorecardText(dir);
    assert.equal(text, "Vault: clear, 0 stored, 0 replaced, 0 removed, 0 uses (ok 0, failed 0), connector 0, git-clone 0, git-push 0, 0 distinct credentials, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = vaultScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held vault scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("vault scorecard: custody folds to counts and no name, host, or purpose surfaces", () => {
  const dir = scratch();
  try {
    const clean = vaultScorecardText(dir);
    recordActivity(dir, "operator", "vault-set", vaultSetLedgerSummary("sekrit-key", false, ["sekrit.example.com"], "sekrit purpose text"));
    recordActivity(dir, "operator", "vault-set", vaultSetLedgerSummary("sekrit-key", true, ["sekrit.example.com"], "sekrit purpose text"));
    recordActivity(dir, "operator", "vault-set", vaultSetLedgerSummary("other-key", false, [], ""));
    recordActivity(dir, "operator", "vault-remove", vaultRemoveLedgerSummary("other-key"));
    recordActivity(dir, "sam", "vault-use", vaultConnectorUseLedgerSummary("sekrit-key", "sekrit-connector", "tool call list_things", "ok"));
    recordActivity(dir, "sam", "vault-use", vaultConnectorUseLedgerSummary("sekrit-key", "sekrit-connector", "connector test", "ok"));
    recordActivity(dir, "sam", "vault-use", vaultCloneUseLedgerSummary("sekrit-key", "sekrit.example.com", "ok"));
    recordActivity(dir, "owner", "vault-use", vaultPushUseLedgerSummary("sekrit-key", "sam/task-1", "sekrit.example.com", "ok"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = vaultScorecardText(dir);
    assert.equal(text, "Vault: clear, 2 stored, 1 replaced, 1 removed, 4 uses (ok 4, failed 0), connector 2, git-clone 1, git-push 1, 2 distinct credentials, 8 total");
    assert.equal(text.includes("sekrit"), false, "no credential name, host, purpose, or connector surfaces");
    assert.equal(text.includes("list_things"), false, "no call purpose surfaces");
    assert.notEqual(text, clean, "the first custody event changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("vault scorecard: a failed spend is attention, on any surface", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "operator", "vault-set", vaultSetLedgerSummary("k1", false, ["example.com"], ""));
    recordActivity(dir, "sam", "vault-use", vaultConnectorUseLedgerSummary("k1", "c1", "initialize", "failed: fetch failed (connect timeout)"));
    recordActivity(dir, "sam", "vault-use", vaultCloneUseLedgerSummary("k1", "example.com", "exit 128"));
    recordActivity(dir, "owner", "vault-use", vaultPushUseLedgerSummary("k1", "sam/task-1", "example.com", "exit 1"));
    const text = vaultScorecardText(dir);
    assert.equal(text, "Vault: attention, 1 stored, 0 replaced, 0 removed, 3 uses (ok 0, failed 3), connector 1, git-clone 1, git-push 1, 1 distinct credentials, 4 total");
    assert.equal(text.includes("fetch failed"), false, "no failure reason surfaces");
    assert.equal(text.includes("k1"), false, "no credential name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("vault scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "operator", "vault-set", vaultSetLedgerSummary("k1", false, [], ""));
    recordActivity(dir, "sam", "vault-use", "Some wholly novel vault shape mentioning sekrit custody");
    recordActivity(dir, "sam", "vault-use", "Vault credential k1 used for connector \"c1\" (initialize)");
    const text = vaultScorecardText(dir);
    assert.equal(text, "Vault: attention, 1 stored, 0 replaced, 0 removed, 0 uses (ok 0, failed 0), connector 0, git-clone 0, git-push 0, 1 distinct credentials, 3 total, 2 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel vault"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("vault parse: the seams' own writer lines are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(
    vaultSetLedgerSummary("second-shift", false, ["mcp.secondshiftos.com"], "Second Shift MCP operator key"),
    "Vault credential second-shift stored for hosts mcp.secondshiftos.com - Second Shift MCP operator key",
  );
  assert.equal(
    vaultSetLedgerSummary("k1", true, [], ""),
    "Vault credential k1 replaced (no hosts - named consumers only)",
  );
  assert.equal(vaultRemoveLedgerSummary("k1"), "Vault credential k1 removed");
  assert.equal(
    vaultConnectorUseLedgerSummary("k1", "c1", "tool call list_things", "ok"),
    "Vault credential k1 used for connector \"c1\" (tool call list_things) - ok",
  );
  assert.equal(
    vaultCloneUseLedgerSummary("k1", "github.com", "exit 128"),
    "Vault credential k1 injected for git-clone of github.com: exit 128",
  );
  assert.equal(
    vaultPushUseLedgerSummary("k1", "sam/task-1", "github.com", "ok"),
    "Vault credential k1 injected for git-push of sam/task-1 to github.com: ok",
  );
  assert.deepEqual(parseVaultSetSummary(vaultSetLedgerSummary("k1", false, ["a.com"], "p")), { name: "k1", replaced: false });
  assert.deepEqual(parseVaultSetSummary(vaultSetLedgerSummary("k1", true, [], "")), { name: "k1", replaced: true });
  assert.deepEqual(parseVaultRemoveSummary(vaultRemoveLedgerSummary("k1")), { name: "k1" });
  assert.deepEqual(parseVaultUseSummary(vaultConnectorUseLedgerSummary("k1", "c1", "initialize", "ok")), { name: "k1", surface: "connector", ok: true });
  assert.deepEqual(parseVaultUseSummary(vaultConnectorUseLedgerSummary("k1", "c1", "initialize", "failed: boom")), { name: "k1", surface: "connector", ok: false });
  assert.deepEqual(parseVaultUseSummary(vaultCloneUseLedgerSummary("k1", "github.com", "ok")), { name: "k1", surface: "git-clone", ok: true });
  assert.deepEqual(parseVaultUseSummary(vaultPushUseLedgerSummary("k1", "sam/t", "github.com", "exit 1")), { name: "k1", surface: "git-push", ok: false });
  assert.equal(parseVaultSetSummary(""), null);
  assert.equal(parseVaultSetSummary("Vault credential k1 stored"), null, "a truncated set line does not parse");
  assert.equal(parseVaultRemoveSummary("Vault credential k1 removed yesterday"), null);
  assert.equal(parseVaultUseSummary("Vault credential k1 used for connector \"c1\" (initialize)"), null, "a use line with no outcome does not parse");
  assert.equal(parseVaultUseSummary("Some wholly novel vault shape"), null);
});

test("vault scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-vault"), "sam-vault is allowlisted");
  const argv = scriptArgv("/some/root", "sam-vault");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["vault", "scorecard"], "the argv rides vault scorecard");
});
