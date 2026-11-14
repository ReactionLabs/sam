import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextSummary, contextToday, readContextMeters, recordContextMeter } from "./context-meter.js";
import { readActivity } from "./activity.js";

// Program H item D (filed requirement 5): injected-context size
// per turn is a measured, ledgered metric. The discipline is the
// usage ledger's own: writes fail soft with ONE named line,
// reads fail closed.
function scratch(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "sam-meter-"));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
const ENTRY = {
  actor: "dip", route: "chat" as const,
  systemChars: 9000, lawChars: 500, recallChars: 300, standingChars: 2000,
  summaryChars: 0, historyChars: 4000, totalChars: 13000, totalWords: 2100,
};

test("record, read back, and summarize with the tier breakdown", () => scratch(root => {
  const first = recordContextMeter(root, ENTRY);
  assert.ok(first && first.totalChars === 13000);
  const second = recordContextMeter(root, { ...ENTRY, historyChars: 8000, totalChars: 17000, totalWords: 2700 });
  assert.ok(second);
  const entries = readContextMeters(root);
  assert.equal(entries.length, 2);
  const all = contextSummary(root);
  assert.equal(all.turns, 2);
  assert.equal(all.totalChars, 30000);
  assert.equal(all.avgTotalChars, 15000);
  assert.equal(all.maxTotalChars, 17000);
  assert.equal(all.lawChars, 1000);
  assert.equal(all.historyChars, 12000);
  assert.equal(contextToday(root).turns, 2);
  assert.equal(contextSummary(root, { actor: "nobody" }).turns, 0);
}));

test("a failed write returns null, never throws, and ledgers exactly one context-failed line", () => scratch(root => {
  mkdirSync(join(root, ".sam", "context.jsonl"), { recursive: true });
  const written = recordContextMeter(root, ENTRY);
  assert.equal(written, null);
  const lines = readActivity(root, 100).filter(l => l.kind === "context-failed");
  assert.equal(lines.length, 1);
  assert.match(lines[0].summary, /^Context meter write failed/);
}));

test("a failed read fails closed: one ledger line, then the throw", () => scratch(root => {
  mkdirSync(join(root, ".sam", "context.jsonl"), { recursive: true });
  assert.throws(() => readContextMeters(root));
  const lines = readActivity(root, 100).filter(l => l.kind === "context-failed");
  assert.equal(lines.length, 1);
  assert.match(lines[0].summary, /^Context meter read failed/);
}));
