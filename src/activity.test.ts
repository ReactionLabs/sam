import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordActivity, readActivity } from "./activity.js";

test("activity ledger: per-profile and kind filters apply before the limit (P8)", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-activity-"));
  try {
    recordActivity(root, "trading", "turn", "t1");
    recordActivity(root, "owner", "approved", "o1");
    recordActivity(root, "trading", "heartbeat", "t2");
    recordActivity(root, "owner", "rejected", "o2");
    recordActivity(root, "trading", "turn", "t3");
    assert.equal(readActivity(root, 30).length, 5);
    // The filter must not starve on the raw tail: limit 1 for trading still
    // finds trading's newest line even though an owner line sits beside it.
    const trading = readActivity(root, 1, { actor: "trading" });
    assert.equal(trading.length, 1);
    assert.equal(trading[0].summary, "t3");
    assert.deepEqual(readActivity(root, 30, { actor: "owner" }).map(l => l.summary), ["o1", "o2"]);
    assert.deepEqual(readActivity(root, 30, { kind: "turn" }).map(l => l.summary), ["t1", "t3"]);
    assert.deepEqual(readActivity(root, 30, { actor: "trading", kind: "heartbeat" }).map(l => l.summary), ["t2"]);
    assert.deepEqual(readActivity(root, 30, { actor: "nobody" }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
