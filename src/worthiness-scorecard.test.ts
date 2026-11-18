import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessDelivery, deliveryLedgerSummary, deliveryLedgerText, deliveryReasonClass } from "./worthiness.js";
import { PreferenceStore } from "./preferences.js";
import { heartbeatFactSignatureString, heartbeatOutputHash, heartbeatOutputsEquivalent } from "./heartbeat.js";
import { scriptArgv, scriptCommandNames } from "./schedule.js";

// The worthiness ledger daily-measurement wiring (2026-11-17):
// the S5 gate's ledger had no plain-text scorecard, no script
// allowlist entry, and no daily job - and on the box the gate
// has never held a delivery, so the first duplicate / rate /
// law hold would have been invisible (status folds only
// delivered/suppressed totals, no reasons). The scorecard
// text is a script job's stdout and is P3-diffed on its
// facts, so it carries counts only: no entry stamp (an ISO
// stamp is a P3 date fact), no fingerprint, no preview, and
// no law term - previews and terms are the owner's words.
// Two reads over an unchanged ledger are byte-identical; a
// new verdict of any class moves the text. Every verdict in
// these tests is produced by the real gate (assessDelivery
// with injected clocks), never by a hand-written ledger line.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-worthiness-scorecard-")); }

const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const BASE = Date.parse("2026-11-17T12:00:00.000Z");
const at = (base: number, minutes: number) => new Date(base + minutes * 60_000);

// One ledger holding every verdict class, built by the gate
// itself: sam delivers twice then repeats one (duplicate);
// dip delivers three inside an hour then a fourth (rate);
// deny holds a crypto text under its never-alert law; only
// holds an off-list text under its only-alert law.
function seeded(root: string, base: number): void {
  const prefs = new PreferenceStore(root);
  prefs.note("deny", "Never alert me about crypto prices", "rule", "test");
  prefs.note("only", "Only notify me about new leads", "rule", "test");
  prefs.close();
  assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "Stack watch moved.", now: at(base, 0) });
  assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "Backup drill passed.", now: at(base, 1) });
  assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "Stack watch moved.", now: at(base, 2) });
  for (let i = 0; i < 3; i++) assessDelivery(root, { profile: "dip", kind: "heartbeat", text: "Dip update " + i, now: at(base, 10 + i) });
  assessDelivery(root, { profile: "dip", kind: "heartbeat", text: "Dip update 3", now: at(base, 20) });
  assessDelivery(root, { profile: "deny", kind: "heartbeat", text: "Crypto prices moved again.", now: at(base, 30) });
  assessDelivery(root, { profile: "only", kind: "heartbeat", text: "The weather changed.", now: at(base, 31) });
}

test("worthiness scorecard: an empty ledger is stable, clock-free, and P3-silent", () => {
  const root = fresh();
  try {
    const text = deliveryLedgerText(deliveryLedgerSummary(root));
    assert.match(text, /^Worthiness ledger - 0 assessments, 0 delivered, 0 held$/m);
    assert.match(text, /No assessments recorded yet/);
    assert.doesNotMatch(text, STAMP, "no stamp in the text");
    const again = deliveryLedgerText(deliveryLedgerSummary(root));
    assert.equal(again, text, "two reads over an unchanged ledger produce identical text");
    const prior = { hash: heartbeatOutputHash(text), sig: heartbeatFactSignatureString(text) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(again), heartbeatFactSignatureString(again)),
      true,
      "P3 judges a held worthiness scorecard the same news",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worthiness scorecard: every gate class folds to counts, and no content leaks", () => {
  const root = fresh();
  try {
    seeded(root, BASE);
    const summary = deliveryLedgerSummary(root);
    assert.equal(summary.total, 9);
    assert.equal(summary.delivered, 5);
    assert.equal(summary.held, 4);
    assert.deepEqual(summary.heldByClass, { duplicate: 1, "rate limit": 1, "law deny": 1, "law allowlist": 1 });
    const text = deliveryLedgerText(summary);
    assert.match(text, /^Worthiness ledger - 9 assessments, 5 delivered, 4 held$/m);
    assert.match(text, /worthy: 5 delivered/);
    assert.match(text, /held as duplicate: 1/);
    assert.match(text, /held by rate limit: 1/);
    assert.match(text, /held by law deny: 1/);
    assert.match(text, /held by law allowlist: 1/);
    assert.match(text, /profile sam: 2 delivered, 1 held/);
    assert.match(text, /profile dip: 3 delivered, 1 held/);
    assert.match(text, /kind heartbeat: 5 delivered, 4 held/);
    assert.doesNotMatch(text, STAMP, "no entry stamp in the text");
    assert.doesNotMatch(text, /crypto/i, "the law's own term never enters the text");
    assert.doesNotMatch(text, /Stack watch moved/, "no preview (message content) in the text");
    assert.doesNotMatch(text, /[0-9a-f]{16}/, "no fingerprint in the text");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worthiness scorecard: the same verdicts at different wall-clock times render identical text", () => {
  const a = fresh();
  const b = fresh();
  try {
    seeded(a, BASE);
    seeded(b, BASE + 3 * 24 * 3_600_000);
    const textA = deliveryLedgerText(deliveryLedgerSummary(a));
    const textB = deliveryLedgerText(deliveryLedgerSummary(b));
    assert.equal(textB, textA, "stamps live in the ledger, never in the scorecard text");
    const prior = { hash: heartbeatOutputHash(textA), sig: heartbeatFactSignatureString(textA) };
    assert.equal(
      heartbeatOutputsEquivalent(prior, heartbeatOutputHash(textB), heartbeatFactSignatureString(textB)),
      true,
      "P3 judges the re-stamped ledger the same news",
    );
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test("worthiness scorecard: the first held verdict is news - a duplicate changes the text", () => {
  const root = fresh();
  try {
    assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "One real update.", now: at(BASE, 0) });
    const before = deliveryLedgerText(deliveryLedgerSummary(root));
    assert.match(before, /0 held/);
    assert.doesNotMatch(before, /held as duplicate/);
    assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "One real update.", now: at(BASE, 5) });
    const after = deliveryLedgerText(deliveryLedgerSummary(root));
    assert.notEqual(after, before, "a held verdict moves the scorecard");
    assert.match(after, /held as duplicate: 1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worthiness scorecard: reason classes are prefix reads, and an unknown held reason counts as other", () => {
  assert.equal(deliveryReasonClass({ deliver: true, reason: "worthy" } as never), "worthy");
  assert.equal(deliveryReasonClass({ deliver: false, reason: "duplicate of a delivery in the last 6h" } as never), "duplicate");
  assert.equal(deliveryReasonClass({ deliver: false, reason: "rate: more than 3 proactive deliveries this hour" } as never), "rate limit");
  assert.equal(deliveryReasonClass({ deliver: false, reason: "law: never alert about crypto" } as never), "law deny");
  assert.equal(deliveryReasonClass({ deliver: false, reason: "law: outside the only-alert-about list" } as never), "law allowlist");
  assert.equal(deliveryReasonClass({ deliver: false, reason: "some future hold" } as never), "other");
});

test("worthiness scorecard: sam-deliveries-scorecard is allowlisted and rides the deliveries scorecard door", () => {
  assert.ok(scriptCommandNames().includes("sam-deliveries-scorecard"));
  const argv = scriptArgv(fresh(), "sam-deliveries-scorecard");
  assert.equal(argv[0], process.execPath);
  assert.ok(argv.some(a => a.endsWith("cli.js")));
  assert.ok(argv.includes("deliveries") && argv.includes("scorecard"));
});
