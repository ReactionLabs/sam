import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseSourceCitation, sourceCitationLedgerSummary, sourceCitationScorecardText } from "./source-citations.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The source-citation daily-measurement wiring (2026-11-19,
// the measured-proof series): the citation pass's negative
// half (rejections) has been counted since 2026-11-18, but
// the positive half - replies that actually attached a
// Sources list, one source-citation line each - was never
// folded, so whether SAM grounds its replies at all, and
// what share of a run's registered sources its replies cite,
// was invisible in aggregate. The scorecard text is a script
// job's stdout and is P3-diffed on its facts, so it carries
// counts only: no stamp, no actor, no chat id, no source
// descriptor, no verbatim summary - attachments fold into
// the one fixed shape the turn writes (through its ONE
// writer) and an unmatched shape counts as a reply with no
// counts, never printed. The verdict is attention only on an
// unparseable line: attached sources are the healthy case.
// The scorecard path is a pure read - it creates nothing,
// spends no model call, and retries nothing; every state
// here is built through the ledger's own public door
// (recordActivity) with the seam's own summary writer, never
// around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-citation-scorecard-"));
}

test("citation scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = sourceCitationScorecardText(dir);
    assert.match(text, /^Source citations: clear$/m);
    assert.match(text, /^Replies with sources: 0$/m);
    assert.match(text, /^Cited sources: 0$/m);
    assert.match(text, /^Registered sources: 0$/m);
    assert.match(text, /^Distinct chats: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = sourceCitationScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held citation scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("citation scorecard: attachments fold to counts, stay clear, and leak no chat id or content", () => {
  const dir = scratch();
  try {
    const clean = sourceCitationScorecardText(dir);
    recordActivity(dir, "sam", "source-citation", sourceCitationLedgerSummary("abcd1234efgh", 2, 11));
    recordActivity(dir, "dip", "source-citation", sourceCitationLedgerSummary("abcd1234efgh", 2, 2));
    recordActivity(dir, "sam", "source-citation", sourceCitationLedgerSummary("99887766aabb", 3, 7));
    recordActivity(dir, "sam", "source-citation-rejected", "Source citation rejected in chat abcd1234: the reply cited 1 source number(s) outside this run's registered sources (4 registered); the invalid citations were stripped and no source was listed for them");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = sourceCitationScorecardText(dir);
    assert.match(text, /^Source citations: clear$/m);
    assert.match(text, /^Replies with sources: 3$/m);
    assert.match(text, /^Cited sources: 7$/m);
    assert.match(text, /^Registered sources: 20$/m);
    assert.match(text, /^Distinct chats: 2$/m);
    assert.equal(text.includes("abcd1234"), false, "no chat id surfaces");
    assert.equal(text.includes("99887766"), false, "no chat id surfaces");
    assert.notEqual(text, clean, "the first attachment changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the grown scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("citation scorecard: an unmatched shape flips the verdict to attention and is never printed", () => {
  const dir = scratch();
  try {
    recordActivity(dir, "sam", "source-citation", sourceCitationLedgerSummary("abcd1234efgh", 1, 4));
    recordActivity(dir, "sam", "source-citation", "Some wholly novel attachment shape mentioning sekrit-source in chat deadbeef");
    const text = sourceCitationScorecardText(dir);
    assert.match(text, /^Source citations: attention$/m);
    assert.match(text, /^Replies with sources: 2$/m);
    assert.match(text, /^Cited sources: 1$/m);
    assert.match(text, /^Registered sources: 4$/m);
    assert.match(text, /^Distinct chats: 1$/m);
    assert.equal(text.includes("sekrit"), false, "no source descriptor surfaces");
    assert.equal(text.includes("novel attachment"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("deadbeef"), false, "no chat id surfaces");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("citation parse: the seam's own writer line parses, and only the fixed shape parses", () => {
  assert.equal(sourceCitationLedgerSummary("abcd1234efgh", 2, 11), "Sources attached in chat abcd1234: 2 cited of 11 registered this run", "the writer is byte-identical to the shape the turn has always ledgered");
  assert.deepEqual(parseSourceCitation(sourceCitationLedgerSummary("abcd1234efgh", 2, 11)), { chatId: "abcd1234", cited: 2, registered: 11 });
  assert.deepEqual(parseSourceCitation("Sources attached in chat 2e67eb98: 2 cited of 11 registered this run"), { chatId: "2e67eb98", cited: 2, registered: 11 }, "a live-shaped line parses");
  assert.equal(parseSourceCitation(""), null);
  assert.equal(parseSourceCitation("Sources attached in chat abcd1234: many cited of some registered this run"), null);
  assert.equal(parseSourceCitation("Some wholly novel attachment shape"), null);
});

test("citation scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-source-citations"), "sam-source-citations is allowlisted");
  const argv = scriptArgv("/some/root", "sam-source-citations");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "source-scorecard"], "the argv rides observe source-scorecard");
});
