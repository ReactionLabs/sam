import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { auditPrompts, buildPromptAudit, promptAuditText, promptSurfaces, readPromptAudit, runPromptAudit, type PromptSurfaces } from "./prompt-audit.js";

// HARNESS INTELLIGENCE item 1: the prompt audit. The instrument
// is deterministic over the surfaces it is fed - synthetic weak
// surfaces must fail with named findings (the instrument can
// say no), and the LIVE shipped surfaces must pass every check
// after the decision-and-honesty paragraph landed. A run
// persists to the one-row SQLite store and ledgers one
// counts-only line; a pure read creates nothing; a legacy JSON
// record imports once and is renamed, never deleted.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-prompt-audit-")); }

test("prompt-audit: a weak synthetic prompt fails with named findings in the decision and honesty dimensions", () => {
  const weak: PromptSurfaces = {
    core: "You are a helpful bot. Ask for permission before consequential actions.",
    style: "Be nice.",
    tools: [{ name: "x", description: "Does a thing." }],
    stubs: "ok",
  };
  const audit = auditPrompts(weak);
  assert.ok(audit.overall.passed < audit.overall.total);
  const missing = new Set(audit.findings.map(f => f.check));
  assert.ok(missing.has("decision-act"));
  assert.ok(missing.has("decision-unsure"));
  assert.ok(missing.has("honesty-plain"));
  assert.ok(missing.has("honesty-tool-fact"));
  assert.ok(missing.has("role-name"));
  assert.ok(missing.has("hygiene-emphasis"));
  // The one anchored line the weak prompt does carry still passes.
  const decision = audit.dimensions.find(d => d.id === "decision");
  assert.equal(decision?.checks.find(c => c.id === "decision-ask")?.passed, true);
});

test("prompt-audit: the live shipped surfaces pass every anchored check", () => {
  const audit = buildPromptAudit();
  assert.equal(audit.findings.length, 0, JSON.stringify(audit.findings));
  assert.equal(audit.overall.passed, audit.overall.total);
  assert.equal(audit.dimensions.length, 5);
  assert.ok(audit.surfaces.tools >= 20);
  assert.ok(audit.surfaces.coreChars > 4000);
  const text = promptAuditText(audit);
  assert.match(text, /Findings: none/);
  for (const dim of audit.dimensions) assert.equal(dim.passed, dim.total, dim.id);
});

test("prompt-audit: surfaces are the shipped ones (core statement + every own tool)", () => {
  const surfaces = promptSurfaces();
  assert.match(surfaces.core, /You are S\.A\.M\./);
  assert.ok(surfaces.tools.some(t => t.name === "sam_code"));
  assert.ok(surfaces.stubs.length > 100);
});

test("prompt-audit: a run records to SQLite with one counts-only ledger line; a pure read creates nothing", () => {
  const root = fresh();
  try {
    assert.equal(readPromptAudit(root), null);
    assert.equal(existsSync(join(root, ".sam")), false);
    const audit = runPromptAudit(root);
    assert.equal(readPromptAudit(root)?.overall.passed, audit.overall.passed);
    assert.equal(existsSync(join(root, ".sam", "prompt-audit.db")), true);
    assert.equal(existsSync(join(root, ".sam", "prompt-audit.json")), false);
    const lines = readActivity(root, 50).filter(l => l.kind === "prompt-audit");
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /Prompt audit recorded: \d+\/\d+ checks/);
    // Counts only: no prompt text rides the ledger line.
    assert.ok(!lines[0].summary.includes("S.A.M."));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prompt-audit: a legacy JSON record imports once and is renamed, never deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacy = buildPromptAudit();
    writeFileSync(join(root, ".sam", "prompt-audit.json"), JSON.stringify(legacy));
    const read = readPromptAudit(root);
    assert.equal(read?.at, legacy.at);
    assert.equal(existsSync(join(root, ".sam", "prompt-audit.json")), false);
    assert.equal(existsSync(join(root, ".sam", "prompt-audit.json.migrated")), true);
    // A malformed legacy file imports nothing and stays in place.
    const root2 = fresh();
    try {
      mkdirSync(join(root2, ".sam"), { recursive: true });
      writeFileSync(join(root2, ".sam", "prompt-audit.json"), "{nope");
      assert.equal(readPromptAudit(root2), null);
      assert.equal(existsSync(join(root2, ".sam", "prompt-audit.json")), true);
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
