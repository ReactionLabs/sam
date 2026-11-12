import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordUsage, usageSummary, usageToday } from "./usage.js";

test("usageToday counts the UTC day and leaves older lines in the all-time ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-usage-"));
  try {
    recordUsage(root, { actor: "sam", route: "chat", tier: "main", model: "mock", promptTokens: 3, completionTokens: 4, totalTokens: 7 });
    appendFileSync(join(root, ".sam", "usage.jsonl"), JSON.stringify({
      at: "2020-01-01T00:00:00.000Z", actor: "sam", route: "chat", tier: "main", model: "old",
      promptTokens: 9, completionTokens: 9, totalTokens: 18,
    }) + "\n");
    const today = usageToday(root, new Date());
    const all = usageSummary(root);
    assert.equal(today.calls, 1);
    assert.equal(today.totalTokens, 7);
    assert.equal(all.calls, 2);
    assert.equal(all.totalTokens, 25);
    assert.equal(usageToday(root, new Date("2020-01-01T12:00:00.000Z")).totalTokens, 18);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
