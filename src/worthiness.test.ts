import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessDelivery, notificationRules, readDeliveryLedger } from "./worthiness.js";
import { PreferenceStore } from "./preferences.js";
import { addHeartbeatJob, runHeartbeat } from "./heartbeat.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-worthy-"));
}

test("worthiness: a first delivery passes and is ledgered", () => {
  const root = scratch();
  try {
    const v = assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "The stack restarted." });
    assert.equal(v.deliver, true);
    const ledger = readDeliveryLedger(root);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].reason, "worthy");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worthiness: the identical update inside the cooldown is a duplicate", () => {
  const root = scratch();
  try {
    assert.equal(assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "Same news." }).deliver, true);
    const again = assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "Same news." });
    assert.equal(again.deliver, false);
    assert.match(again.reason, /duplicate/);
    // A different kind or a genuinely different text is not a duplicate.
    assert.equal(assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "Different news." }).deliver, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worthiness: a flood is rate-held", () => {
  const root = scratch();
  try {
    for (let i = 0; i < 3; i++) assert.equal(assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "Update number " + i }).deliver, true);
    const fourth = assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "Update number 3" });
    assert.equal(fourth.deliver, false);
    assert.match(fourth.reason, /rate/);
    // Another profile has its own budget.
    assert.equal(assessDelivery(root, { profile: "dip", kind: "heartbeat", text: "Update number 3" }).deliver, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worthiness: standing law seeds the taste - denylist and allowlist", () => {
  const root = scratch();
  try {
    const prefs = new PreferenceStore(root);
    prefs.note("sam", "Never alert me about crypto prices", "rule", "test");
    prefs.note("dip", "Only notify me about new leads", "rule", "test");
    prefs.close();
    assert.deepEqual(notificationRules(root, "sam").denyTerms, ["crypto", "prices"]);
    const denied = assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "Crypto prices moved again." });
    assert.equal(denied.deliver, false);
    assert.match(denied.reason, /never alert about crypto/);
    assert.equal(assessDelivery(root, { profile: "sam", kind: "heartbeat", text: "The server restarted." }).deliver, true);
    assert.equal(assessDelivery(root, { profile: "dip", kind: "heartbeat", text: "Two new leads arrived." }).deliver, true);
    const outside = assessDelivery(root, { profile: "dip", kind: "heartbeat", text: "The weather changed." });
    assert.equal(outside.deliver, false);
    assert.match(outside.reason, /only-alert-about/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worthiness: the heartbeat seam delivers once, then holds the repeat", async () => {
  const root = scratch();
  try {
    addHeartbeatJob(root, "job-a", 30, "sam", "check a", "chan-1");
    addHeartbeatJob(root, "job-b", 30, "sam", "check b", "chan-1");
    const deliveries: string[] = [];
    const deps = {
      ensureChat: async () => "hb-chat",
      runTurn: async () => "The market moved in a new way.",
      deliver: async (_id: string, text: string) => { deliveries.push(text); },
    };
    await runHeartbeat(root, deps);
    // Two jobs, same profile, same changed text: the second push is a
    // duplicate interruption even though both jobs legitimately changed.
    assert.equal(deliveries.length, 1);
    const ledger = readDeliveryLedger(root, 10);
    assert.equal(ledger.filter(e => e.deliver).length, 1);
    assert.equal(ledger.filter(e => !e.deliver).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
