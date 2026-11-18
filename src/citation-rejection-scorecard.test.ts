import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity } from "./activity.js";
import { parseSourceCitationRejection, processReplySources, recordRunSource, sourceCitationRejectionScorecardText } from "./source-citations.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The source-citation rejection daily-measurement wiring
// (2026-11-18, the measured-proof series): the citation pass
// strips every citation number a reply invents and ledgers
// one rejection line per offending reply, but no daily
// surface ever counted the class, so a model that kept
// fabricating citations was invisible until the owner read
// a reply closely. The scorecard text is a script job's
// stdout and is P3-diffed on its facts, so it carries
// counts only: no stamp, no chat id, no actor, no source
// descriptor, no verbatim summary - rejections fold into
// the one fixed shape the pass writes and an unmatched
// shape counts as a rejection with no counts, never
// printed. The scorecard path is a pure read - it creates
// nothing, spends no model call, and retries nothing;
// every state here is built through the ledger's own
// public door (recordActivity) or the pass's own door
// (processReplySources), never around either.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-citation-rejection-scorecard-"));
}

function rejectionLine(rejected: number, registered: number): string {
  return "Source citation rejected in chat abcd1234: the reply cited " + String(rejected) + " source number(s) outside this run's registered sources (" + String(registered) + " registered); the invalid citations were stripped and no source was listed for them";
}

test("citation rejection scorecard: a bare install is clear, stable, clock-free, P3-silent, and creates nothing", () => {
  const dir = scratch();
  try {
    const text = sourceCitationRejectionScorecardText(dir);
    assert.match(text, /^Source citation rejections: clear$/m);
    assert.match(text, /^Replies with rejections: 0$/m);
    assert.match(text, /^Rejected citations: 0$/m);
    assert.match(text, /^Registered sources: 0$/m);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no stamp in the text");
    assert.equal(existsSync(join(dir, ".sam")), false, "a pure read creates no store");
    const again = sourceCitationRejectionScorecardText(dir);
    assert.equal(again, text, "two reads of the same state produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held citation-rejection scorecard the same news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("citation rejection scorecard: rejections flip the verdict, fold to counts, and leak no content", () => {
  const dir = scratch();
  try {
    const clean = sourceCitationRejectionScorecardText(dir);
    recordActivity(dir, "sam", "source-citation-rejected", rejectionLine(2, 3));
    recordActivity(dir, "dip", "source-citation-rejected", rejectionLine(1, 0));
    recordActivity(dir, "sam", "source-citation-rejected", "Some wholly novel rejection shape mentioning sekrit-source");
    recordActivity(dir, "sam", "source-citation", "Sources attached in chat abcd1234: 3 cited of 3 registered this run");
    recordActivity(dir, "sam", "turn", "Turn completed: all good");
    const text = sourceCitationRejectionScorecardText(dir);
    assert.match(text, /^Source citation rejections: attention$/m);
    assert.match(text, /^Replies with rejections: 3$/m);
    assert.match(text, /^Rejected citations: 3$/m);
    assert.match(text, /^Registered sources: 3$/m);
    assert.equal(text.includes("sekrit"), false, "no source descriptor surfaces");
    assert.equal(text.includes("novel rejection"), false, "an unmatched summary is never printed");
    assert.equal(text.includes("abcd1234"), false, "no chat id surfaces");
    assert.notEqual(text, clean, "the first rejection changes the scorecard");
    const prior = { hash: heartbeatOutputHash(clean), sig: heartbeatFactSignatureString(clean) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(text), heartbeatFactSignatureString(text)),
      false,
      "P3 judges the flipped scorecard as new news",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("citation rejection parse: the pass's own line parses, and only the fixed shape parses", () => {
  const dir = scratch();
  try {
    recordRunSource("c9c9c9c9", "m9", { kind: "file", descriptor: "real.md" });
    recordRunSource("c9c9c9c9", "m9", { kind: "web", descriptor: "example page" });
    const processed = processReplySources(dir, {
      chatId: "c9c9c9c9", userMessageId: "m9", actor: "sam",
      text: "The rate is 360 [1] and the moon is cheese [9] and [7].",
    });
    assert.equal(processed.rejectedCount, 2);
    const text = sourceCitationRejectionScorecardText(dir);
    assert.match(text, /^Replies with rejections: 1$/m);
    assert.match(text, /^Rejected citations: 2$/m);
    assert.match(text, /^Registered sources: 2$/m);
    assert.deepEqual(parseSourceCitationRejection(rejectionLine(5, 12)), { rejected: 5, registered: 12 });
    assert.equal(parseSourceCitationRejection(""), null);
    assert.equal(parseSourceCitationRejection("Some wholly novel rejection shape"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("citation rejection scorecard: the script allowlist rides the CLI scorecard", () => {
  assert.ok(scriptCommandNames().includes("sam-citation-rejections"), "sam-citation-rejections is allowlisted");
  const argv = scriptArgv("/some/root", "sam-citation-rejections");
  assert.ok(argv.some(a => a.endsWith("cli.js")), "the argv runs the CLI");
  assert.deepEqual(argv.slice(-2), ["observe", "citation-scorecard"], "the argv rides observe citation-scorecard");
});
