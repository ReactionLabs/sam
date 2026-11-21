import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseProviderAddSummary, parseProviderRemoveSummary, providerAddLedgerSummary, providerHistoryScorecardText, providerRemoveLedgerSummary } from "./providers.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The provider history daily-measurement wiring (2026-11-21,
// the measured-proof series): the provider registry's
// lifecycle ledgers two classes - a registration
// ("provider-add") and a removal ("provider-remove") - but
// neither was ever folded, so how many providers were ever
// registered or removed over an install's life was invisible
// in aggregate; the providers store holds only current
// providers, so a removed provider leaves no surface but
// these lines (the failover-routes precedent). Adds and
// removes are operator acts, not failures, so the verdict is
// attention only when a line is unparseable, else clear. The
// scorecard text is a script job's stdout and is P3-diffed on
// its facts, so it is ONE line carrying counts only: no
// stamp, no actor, no provider id, no key env name, and no
// verbatim summary. The scorecard path is a pure read - it
// creates nothing, registers nothing, and opens no store;
// every state here is built through the ledger's own public
// door (recordActivity) with the seams' own summary writers,
// never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-provider-history-"));
}

const BARE = "Provider history: clear, 0 added, key present 0 / absent 0, 0 removed, 0 distinct providers, 0 total";

test("provider history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = providerHistoryScorecardText(dir);
    assert.equal(text, BARE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = providerHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held provider scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provider history scorecard: recorded adds and removes fold to counts with distinct providers as a number only", () => {
  const dir = scratch();
  try {
    const clean = providerHistoryScorecardText(dir);
    recordActivity(dir, "owner", "provider-add", providerAddLedgerSummary("sekritprovider", "SEKRIT_KEY_ENV", "present"));
    recordActivity(dir, "owner", "provider-add", providerAddLedgerSummary("sekritprovider", "SEKRIT_KEY_ENV", "present"));
    recordActivity(dir, "owner", "provider-add", providerAddLedgerSummary("otherprovider", "OTHER_KEY_ENV", "absent"));
    recordActivity(dir, "owner", "provider-remove", providerRemoveLedgerSummary("sekritprovider"));
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = providerHistoryScorecardText(dir);
    assert.equal(text, "Provider history: clear, 3 added, key present 2 / absent 1, 1 removed, 2 distinct providers, 4 total");
    assert.equal(text.includes("sekrit"), false, "no provider id or key env name surfaces");
    assert.equal(text.includes("SEKRIT"), false, "no key env name surfaces");
    assert.equal(text.includes("owner"), false, "no actor surfaces");
    assert.notEqual(text, clean, "the first recorded add changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provider history scorecard: an unmatched shape is attention, counts toward the total and the unparseable count, and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "owner", "provider-add", providerAddLedgerSummary("sekritprovider", "SEKRIT_KEY_ENV", "absent"));
    recordActivity(dir, "owner", "provider-remove", "A sekrit provider quietly vanished");
    const text = providerHistoryScorecardText(dir);
    assert.equal(text, "Provider history: attention, 1 added, key present 0 / absent 1, 0 removed, 1 distinct providers, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provider parsers: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(providerAddLedgerSummary("minimax", "MINIMAX_API_KEY", "present"), "Provider minimax registered (key env MINIMAX_API_KEY, present)");
  assert.deepEqual(parseProviderAddSummary(providerAddLedgerSummary("minimax", "MINIMAX_API_KEY", "present")), { id: "minimax", keyEnv: "MINIMAX_API_KEY", key: "present" });
  assert.deepEqual(parseProviderAddSummary(providerAddLedgerSummary("other", "OTHER_KEY", "absent")), { id: "other", keyEnv: "OTHER_KEY", key: "absent" });
  assert.equal(parseProviderAddSummary(""), null);
  assert.equal(parseProviderAddSummary("Provider minimax registered (key env MINIMAX_API_KEY, maybe)"), null, "an unknown key state does not parse");
  assert.equal(parseProviderAddSummary("Provider minimax registered (key env MINIMAX_API_KEY, present) tonight"), null, "a line with trailing text does not parse");
  assert.equal(providerRemoveLedgerSummary("minimax"), "Provider minimax removed");
  assert.deepEqual(parseProviderRemoveSummary(providerRemoveLedgerSummary("minimax")), { id: "minimax" });
  assert.equal(parseProviderRemoveSummary(""), null);
  assert.equal(parseProviderRemoveSummary("Provider minimax removed tonight"), null, "a line with trailing text does not parse");
  assert.equal(parseProviderRemoveSummary(providerAddLedgerSummary("minimax", "MINIMAX_API_KEY", "present")), null, "an add line is not a remove line");
});

test("provider history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-provider-history"), "sam-provider-history is allowlisted");
  const argv = scriptArgv("/some/root", "sam-provider-history");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["providers", "history"], "the argv rides providers history");
});
