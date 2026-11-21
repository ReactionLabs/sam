import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseStoreFailureSummary, storeFailureHistoryScorecardText, STORE_FAILURE_KINDS } from "./store-failure-history.js";
import { backgroundStoreFailureSummary } from "./background.js";
import { auditStoreFailureSummary } from "./audit-store-failure.js";
import { engineConnectionStoreFailureSummary } from "./engine-connection-failure.js";
import { telegramStateStoreFailureSummary } from "./telegram.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The store failure history daily-measurement wiring
// (2026-11-21, the measured-proof series): every guarded
// store touch has ledgered a dead-store failure as one of
// twenty-six *-store-failed / telegram-state-failed lines
// since the store census landed, each through its ONE
// writer - with no fold, so how many touches ever died, on
// which phase, across how many distinct stores was
// invisible in aggregate. A recorded store failure means a
// touch died fail-closed, so the verdict is attention only
// when any failure was ever recorded or a line is
// unparseable. The scorecard text is a script job's stdout
// and is P3-diffed on its facts, so it is ONE line carrying
// counts only: no stamp, no actor, no reason - the
// summaries carry verbatim error reasons, which can name
// paths and surfaces, and the fold consumes and never
// prints them. The scorecard path is a pure read - it
// creates nothing, opens no store, and retries nothing;
// every state here is built through the ledger's own
// public door (recordActivity) with the seams' own summary
// writers, never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-store-failure-history-"));
}

test("store failure history scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = storeFailureHistoryScorecardText(dir);
    assert.equal(text, "Store failure history: clear, 0 failed, 0 read, 0 write, 0 resolve, 0 distinct stores, 0 total");
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(text.includes("\n"), false, "the scorecard is one line");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = storeFailureHistoryScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held store failure scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store failure history scorecard: the history folds to counts and distinct stores, and no reason surfaces", () => {
  const dir = scratch();
  try {
    const clean = storeFailureHistoryScorecardText(dir);
    recordActivity(dir, "sam", "background-store-failed", backgroundStoreFailureSummary("read", "sekrit db path gone"));
    recordActivity(dir, "sam", "background-store-failed", backgroundStoreFailureSummary("write", "sekrit db path gone"));
    recordActivity(dir, "sam", "chat-store-failed", "Chat store read failed: sekrit db path gone");
    recordActivity(dir, "sam", "turn", "Answered in chat 6b222963");
    const text = storeFailureHistoryScorecardText(dir);
    assert.equal(text, "Store failure history: attention, 3 failed, 2 read, 1 write, 0 resolve, 2 distinct stores, 3 total");
    assert.equal(text.includes("sekrit"), false, "no failure reason surfaces");
    assert.notEqual(text, clean, "the first recorded store failure changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store failure history scorecard: the audit shape and the resolve phase parse, with no store name or reason printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "audit-store-failed", auditStoreFailureSummary("self-audit", "read", "sekrit_reason"));
    recordActivity(dir, "sam", "engine-connection-store-failed", engineConnectionStoreFailureSummary("resolve", "sekrit_reason"));
    recordActivity(dir, "sam", "telegram-state-failed", telegramStateStoreFailureSummary("write", "sekrit_reason"));
    const text = storeFailureHistoryScorecardText(dir);
    assert.equal(text, "Store failure history: attention, 3 failed, 1 read, 1 write, 1 resolve, 3 distinct stores, 3 total");
    assert.equal(text.includes("sekrit_reason"), false, "no failure reason surfaces");
    assert.equal(text.includes("self-audit"), false, "no audit store name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store failure history scorecard: an unmatched shape counts toward the total and the unparseable count and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "background-store-failed", backgroundStoreFailureSummary("read", "ordinary failure"));
    recordActivity(dir, "sam", "background-store-failed", "Some wholly novel store shape naming sekrit_evidence");
    recordActivity(dir, "sam", "audit-store-failed", auditStoreFailureSummary("self-audit", "read", "ordinary failure").replace("self-audit", "novel-store"));
    const text = storeFailureHistoryScorecardText(dir);
    assert.equal(text, "Store failure history: attention, 1 failed, 1 read, 0 write, 0 resolve, 1 distinct stores, 3 total, 2 unparseable");
    assert.equal(text.includes("novel store"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("sekrit_evidence"), false, "no verbatim summary surfaces");
    assert.equal(text.includes("novel-store"), false, "no unrecognized audit store name surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store failure parse: the writers are byte-identical to the ledgered shapes and parse, and only the fixed shapes parse", () => {
  assert.equal(backgroundStoreFailureSummary("read", "boom"), "Background store read failed: boom");
  assert.equal(auditStoreFailureSummary("loop-audit", "write", "boom"), "Audit store loop-audit write failed: boom");
  assert.equal(engineConnectionStoreFailureSummary("resolve", "boom"), "Engine connection store resolve failed: boom");
  assert.equal(telegramStateStoreFailureSummary("read", "boom"), "Telegram state store read failed: boom");
  assert.equal(STORE_FAILURE_KINDS.length, 26, "the fold covers every store-failure kind");
  assert.deepEqual(parseStoreFailureSummary("background-store-failed", backgroundStoreFailureSummary("read", "boom")), { phase: "read" });
  assert.deepEqual(parseStoreFailureSummary("audit-store-failed", auditStoreFailureSummary("eval-battery", "write", "boom")), { phase: "write" });
  assert.deepEqual(parseStoreFailureSummary("engine-connection-store-failed", engineConnectionStoreFailureSummary("resolve", "boom")), { phase: "resolve" });
  assert.equal(parseStoreFailureSummary("background-store-failed", ""), null);
  assert.equal(parseStoreFailureSummary("background-store-failed", "Background store resolve failed: boom"), null, "a phase the writer never uses does not parse");
  assert.equal(parseStoreFailureSummary("background-store-failed", "Chat store read failed: boom"), null, "a label that does not match its kind does not parse");
  assert.equal(parseStoreFailureSummary("audit-store-failed", "Audit store novel-store read failed: boom"), null, "an unrecognized audit store does not parse");
  assert.equal(parseStoreFailureSummary("audit-store-failed", "Audit store read failed: boom"), null, "an audit line with no store name does not parse");
  assert.equal(parseStoreFailureSummary("unknown-store-failed", "Background store read failed: boom"), null, "an unknown kind does not parse");
  assert.equal(parseStoreFailureSummary("chat-store-failed", "Chat store read failed:"), null, "a truncated line does not parse");
});

test("store failure history scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-store-failures"), "sam-store-failures is allowlisted");
  const argv = scriptArgv("/some/root", "sam-store-failures");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["stores", "history"], "the argv rides stores history");
});
