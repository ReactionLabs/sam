import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseProviderRetrySummary, providerRetryLedgerSummary, providerRetryScorecardText } from "./provider-retry.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The provider-retry daily-measurement wiring (2026-11-19, the
// measured-proof series): transient provider failures the
// provider retries inside a turn have ledgered as
// "provider-retry" lines since the overload resilience landed
// - one line per scheduled retry, in the one fixed shape the
// agent-turn seam writes - but the class was never folded, so
// how often the provider hiccups, whether the hiccups are
// overload (5xx) or rate-limit (429), and how much backoff
// owners absorbed was invisible in aggregate. Every retry
// line is by construction a provider failure the owner felt
// as latency, so the verdict is attention when any line
// exists. The scorecard text is a script job's stdout and is
// P3-diffed on its facts, so it is ONE line carrying counts
// only: no stamp, no actor, and never a chat id - the
// distinct-chat count rides each line's chat prefix
// internally and surfaces as a number only. The scorecard
// path is a pure read - it creates nothing, spends no model
// call, and retries nothing; every state here is built
// through the ledger's own public door (recordActivity) with
// the seam's own summary writer, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-provider-retry-scorecard-"));
}

test("provider-retry scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = providerRetryScorecardText(dir);
    assert.equal(text, "Provider retries: clear, 0 retries, 0 overload (5xx), 0 rate-limit (429), 0 other status, 0 distinct chats, 0ms total backoff, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = providerRetryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held provider-retry scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provider-retry scorecard: retries fold to counts per status bucket, chats collapse in the distinct count, and no chat id surfaces", () => {
  const dir = scratch();
  try {
    const clean = providerRetryScorecardText(dir);
    recordActivity(dir, "sam", "provider-retry", providerRetryLedgerSummary("dffe3075", 529, 1, 3, 500));
    recordActivity(dir, "sam", "provider-retry", providerRetryLedgerSummary("dffe3075", 529, 2, 3, 1000));
    recordActivity(dir, "sam", "provider-retry", providerRetryLedgerSummary("abcd1234", 429, 1, 3, 500));
    recordActivity(dir, "sam", "turn", "Answered in chat dffe3075");
    const text = providerRetryScorecardText(dir);
    assert.equal(text, "Provider retries: attention, 3 retries, 2 overload (5xx), 1 rate-limit (429), 0 other status, 2 distinct chats, 2000ms total backoff, 3 total");
    assert.equal(text.includes("dffe3075"), false, "no chat id surfaces");
    assert.equal(text.includes("abcd1234"), false, "no chat id surfaces");
    assert.notEqual(text, clean, "the first retry changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provider-retry scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "provider-retry", providerRetryLedgerSummary("dffe3075", 529, 1, 3, 500));
    recordActivity(dir, "sam", "provider-retry", "Some wholly novel retry shape mentioning sekrit chats");
    const text = providerRetryScorecardText(dir);
    assert.equal(text, "Provider retries: attention, 1 retries, 1 overload (5xx), 0 rate-limit (429), 0 other status, 1 distinct chats, 500ms total backoff, 2 total, 1 unparseable");
    assert.equal(text.includes("sekrit"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel retry"), false, "an unmatched summary is never printed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provider-retry parse: the seam's own writer lines parse, and only the fixed shape parses", () => {
  assert.equal(
    providerRetryLedgerSummary("dffe3075", 529, 1, 3, 500),
    "Provider retry in chat dffe3075: the model request failed (HTTP 529), retry 1 of 3 after 500ms backoff",
    "the writer is byte-identical to the shape the turn seam has always ledgered",
  );
  assert.deepEqual(parseProviderRetrySummary(providerRetryLedgerSummary("abcd1234", 429, 2, 3, 1000)), { chat: "abcd1234", status: 429, retry: 2, limit: 3, delayMs: 1000 });
  assert.deepEqual(
    parseProviderRetrySummary("Provider retry in chat dffe3075: the model request failed (HTTP 529), retry 1 of 3 after 500ms backoff"),
    { chat: "dffe3075", status: 529, retry: 1, limit: 3, delayMs: 500 },
    "a live-shaped line parses",
  );
  assert.equal(parseProviderRetrySummary(""), null);
  assert.equal(parseProviderRetrySummary("Provider retry in chat dffe3075: the model request failed (HTTP 529)"), null, "a truncated line does not parse");
  assert.equal(parseProviderRetrySummary("Some wholly novel retry shape"), null);
});

test("provider-retry scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-provider-retries"), "sam-provider-retries is allowlisted");
  const argv = scriptArgv("/some/root", "sam-provider-retries");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "provider-scorecard"], "the argv rides observe provider-scorecard");
});
