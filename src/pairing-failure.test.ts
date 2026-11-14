import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { addChannel } from "./channels.js";
import {
  isPairingLedgered, issuePairingCode, pairingFailureSummary, pairingStatus,
  readPairingStore, redeemPairingCode,
} from "./pairing.js";
import { classifyDefect } from "./self-work.js";

// Pairing store failure visibility (gap found 2026-11-14,
// hourly run 14:04): the pairing store holds the codes and
// lockout guards behind channel ownership - readPairingStore
// is the read door (pairingStatus rides it into /api/status),
// the bridge redeems through redeemPairingCode, and the CLI
// issues through issuePairingCode - and every touch opened
// the store raw: a dead pairing.db threw into whichever
// catch wrapped the call, none naming the store. Each touch
// now ledgers ONE pairing-failed line (phase read / redeem /
// issue) and rethrows exactly, tagged; every caller's
// handling is unchanged and pairing still fails closed.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-pairing-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "pairing-failed" });
}

function plantDeadStore(root: string): void {
  mkdirSync(join(root, ".sam", "pairing.db"), { recursive: true });
}

test("pairing-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(pairingFailureSummary("read", "unable to open\n  database   file"), "Pairing read failed: unable to open database file");
  assert.equal(pairingFailureSummary("redeem", "disk gone"), "Pairing redeem failed: disk gone");
  assert.equal(pairingFailureSummary("issue", "disk gone"), "Pairing issue failed: disk gone");
  assert.equal(pairingFailureSummary("read", "x".repeat(500)).length, 200);
  for (const phase of ["read", "redeem", "issue"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "pairing-failed", summary: pairingFailureSummary(phase, "boom") }),
      { key: "pairing-failed:" + phase, label: "pairing store failures (" + phase + " step)" },
    );
  }
});

test("pairing-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", () => {
  const root = scratch();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN");
    plantDeadStore(root);

    assert.throws(() => readPairingStore(root), (e: unknown) => isPairingLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Pairing read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "pairing-failed:read", label: "pairing store failures (read step)" });

    assert.throws(() => issuePairingCode(root, channel.id), (e: unknown) => isPairingLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "the issue touch ledgers exactly one more line, never two for one touch");
    assert.ok(lines[1].summary.startsWith("Pairing issue failed: "), lines[1].summary);
    assert.deepEqual(classifyDefect(lines[1]), { key: "pairing-failed:issue", label: "pairing store failures (issue step)" });

    assert.throws(() => redeemPairingCode(root, channel.id, "ABCD-EFGH", 4242), (e: unknown) => isPairingLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3, "the redeem touch ledgers exactly one more line, never two for one touch");
    assert.ok(lines[2].summary.startsWith("Pairing redeem failed: "), lines[2].summary);
    assert.deepEqual(classifyDefect(lines[2]), { key: "pairing-failed:redeem", label: "pairing store failures (redeem step)" });

    assert.ok(!JSON.stringify(lines).includes("Dip Telegram"), "no channel record ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pairing-failed: an absent store reads the empty snapshot, status is empty, and nothing is created", () => {
  const root = scratch();
  try {
    assert.deepEqual(readPairingStore(root), { codes: [], guards: {} });
    assert.deepEqual(pairingStatus(root), []);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam", "pairing.db")), false, "a pure read creates no store");
    assert.equal(existsSync(join(root, ".sam")), false, "a pure read creates nothing at all");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pairing-failed: a healthy store issues, reads back, and redeems with zero failure lines", () => {
  const root = scratch();
  try {
    const channel = addChannel(root, "telegram", "Dip Telegram", "trading", "SAM_CHANNEL_TG_MAIN");
    const issued = issuePairingCode(root, channel.id);
    const store = readPairingStore(root);
    assert.equal(store.codes.length, 1);
    const status = pairingStatus(root);
    assert.equal(status.length, 1);
    assert.equal(status[0].liveCode, true);
    const redeemed = redeemPairingCode(root, channel.id, issued.code, 4242);
    assert.equal(redeemed.ok, true);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
