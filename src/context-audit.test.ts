import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { buildContextAudit, contextAuditText, measureProfileLoads, readContextAudit, runContextAudit, SYSTEM_CONTEXT_BUDGET_CHARS } from "./context-audit.js";
import { fitRecallBlock, RECALL_MAX_CHARS, type RecallSection } from "./recall.js";
import { lawPromptBlock, LAW_PROMPT_MAX_CHARS, type Preference } from "./preferences.js";

// HARNESS INTELLIGENCE item 2: the context audit. The fitting
// rules are probed functionally (oversize synthetic inputs
// through the REAL assembly functions), the live load is
// measured per profile, a run persists to the one-row SQLite
// store with one counts-only ledger line, a pure read creates
// nothing, and a legacy JSON record imports once and is
// renamed, never deleted.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-context-audit-")); }

function laws(n: number, chars: number): Preference[] {
  return Array.from({ length: n }, (_, i) => ({
    id: "t-" + String(i), profile: "sam", statement: ("Law " + String(i) + " ").padEnd(chars, "x").slice(0, chars),
    kind: "rule" as const, status: "law" as const, hits: 1, source: "test", created_at: "", updated_at: "",
  }));
}

function oversize(): RecallSection[] {
  const lines = (tag: string, n: number, len: number) => Array.from({ length: n }, (_, i) => "- [" + tag + " " + String(i) + "] " + tag.repeat(40).slice(0, len));
  return [
    { heading: "Where things stand:", lines: lines("standing", 8, 200), priority: 1 },
    { heading: "Recent episodes:", lines: lines("episode", 4, 300), priority: 2 },
    { heading: "Records relevant to this message:", lines: lines("relevant", 5, 260), priority: 3 },
  ];
}

test("context-audit: recall fitting respects the cap, protects the relevant section, and marks omissions", () => {
  const block = fitRecallBlock("header", oversize());
  assert.ok(block.length <= RECALL_MAX_CHARS, String(block.length));
  assert.match(block, /Records relevant to this message:/);
  assert.match(block, /relevant 0/);
  assert.match(block, /omitted, lowest priority first/);
  // Whole lines only: every data line in the block is a full input line or the marker.
  const inputs = new Set(oversize().flatMap(s => s.lines));
  for (const line of block.split("\n")) {
    if (line.startsWith("- [")) assert.ok(inputs.has(line) || line.endsWith("…"), line.slice(0, 60));
  }
  // A small block fits untouched, with no marker.
  const small = fitRecallBlock("header", [{ heading: "Recent episodes:", lines: ["- [2026-11-09] a short episode"], priority: 2 }]);
  assert.match(small, /a short episode/);
  assert.doesNotMatch(small, /omitted/);
});

test("context-audit: the law block is char-capped and names what it left out", () => {
  const capped = lawPromptBlock(laws(50, 200));
  assert.ok(capped.length <= LAW_PROMPT_MAX_CHARS, String(capped.length));
  assert.match(capped, /\d+ more standing laws not carried/);
  const small = lawPromptBlock(laws(1, 40));
  assert.match(small, /Law 0/);
  assert.doesNotMatch(small, /not carried/);
  assert.equal(lawPromptBlock([]), "");
});

test("context-audit: the live assembly passes every check on a fresh install", () => {
  const root = fresh();
  try {
    const audit = buildContextAudit(root);
    assert.equal(audit.findings.length, 0, JSON.stringify(audit.findings));
    assert.equal(audit.overall.passed, audit.overall.total);
    assert.equal(audit.dimensions.length, 4);
    assert.equal(audit.profiles.length, 1);
    assert.equal(audit.profiles[0].profile, "sam");
    assert.ok(audit.profiles[0].chars <= SYSTEM_CONTEXT_BUDGET_CHARS);
    assert.ok(audit.profiles[0].chars > 10000, "the core statement is the bulk of the fixed load");
    const text = contextAuditText(audit);
    assert.match(text, /Findings: none/);
    assert.match(text, /sam: \d+ chars/);
    const loads = measureProfileLoads(root);
    assert.equal(loads[0].lawCount, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("context-audit: a run records to SQLite with one counts-only ledger line; a pure read creates nothing", () => {
  const root = fresh();
  try {
    assert.equal(readContextAudit(root), null);
    assert.equal(existsSync(join(root, ".sam")), false);
    const audit = runContextAudit(root);
    assert.equal(readContextAudit(root)?.overall.passed, audit.overall.passed);
    assert.equal(existsSync(join(root, ".sam", "context-audit.db")), true);
    assert.equal(existsSync(join(root, ".sam", "context-audit.json")), false);
    const lines = readActivity(root, 50).filter(l => l.kind === "context-audit");
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /Context audit recorded: \d+\/\d+ checks/);
    assert.ok(!lines[0].summary.includes("standing law for this profile"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("context-audit: a legacy JSON record imports once and is renamed, never deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacy = buildContextAudit(root);
    writeFileSync(join(root, ".sam", "context-audit.json"), JSON.stringify(legacy));
    const read = readContextAudit(root);
    assert.equal(read?.at, legacy.at);
    assert.equal(existsSync(join(root, ".sam", "context-audit.json")), false);
    assert.equal(existsSync(join(root, ".sam", "context-audit.json.migrated")), true);
    const root2 = fresh();
    try {
      mkdirSync(join(root2, ".sam"), { recursive: true });
      writeFileSync(join(root2, ".sam", "context-audit.json"), "{nope");
      assert.equal(readContextAudit(root2), null);
      assert.equal(existsSync(join(root2, ".sam", "context-audit.json")), true);
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
