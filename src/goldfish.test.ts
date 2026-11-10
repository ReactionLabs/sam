import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGoldfishPrompt, goldfishStatus, runGoldfishReview, sessionGate } from "./goldfish.js";
import { setCodeRoot, writeCodeFile } from "./code.js";
import { loadPatternCatalog } from "./pattern-catalog.js";
import { applyEdit, proposeEdit } from "./file-edits.js";
import { recordVerification } from "./verification.js";
import type { EditModel } from "./model-edit.js";

const CATALOG = "# Pattern Catalog\n\n## LOCAL-1: First local pattern (2026-11-09)\nSomething broke.\nCheck: check one.\n\n## LOCAL-3: Third local pattern (2026-11-09)\nSomething else broke.\nCheck: check three.\n\n## IMPORTED-2: Imported pattern (Netflix)\nWatch item.\nCheck: check imported.\n";

function scratch(withCatalog = true): string {
  const root = mkdtempSync(join(tmpdir(), "sam-goldfish-"));
  if (withCatalog) writeFileSync(join(root, "pattern-catalog.md"), CATALOG);
  writeFileSync(join(root, "code.ts"), "export const value = 1;\nexport const other = 2;\n");
  return root;
}

function applyChange(root: string, replacement: string): void {
  const proposal = proposeEdit(root, "code.ts", replacement);
  applyEdit(root, proposal.id, proposal.digest);
}

function verifyAll(root: string): void {
  recordVerification(root, { kind: "build", passed: true, runId: "b1" });
  recordVerification(root, { kind: "test", passed: true, runId: "t1" });
}

function fakeProvider(content: string, capture?: (prompt: string) => void): EditModel {
  return {
    complete: async (req: { model: string; messages: Array<{ role: string; content: string }> }) => {
      capture?.(req.messages[0].content);
      return { message: { content } };
    },
  } as EditModel;
}

const PASS_JSON = JSON.stringify({ verdict: "PASS", summary: "No concerns.", findings: [] });
const BLOCK_JSON = JSON.stringify({ verdict: "BLOCK", summary: "One blocker.", findings: [{ severity: "BLOCKER", detail: "Validate first, spend the artifact last.", evidence: "- spend(code); + validate(code);", patternId: "LOCAL-3" }] });

test("goldfish prompt: spec, diff, and every catalog entry ride along - and nothing else exists to ride", () => {
  const catalog = loadPatternCatalog(scratch());
  assert.ok(catalog);
  const prompt = buildGoldfishPrompt("Fix the pair flow ordering", [{ path: "code.ts", replacementHash: "x", diff: "@@ change @@\n- old\n+ new" }], catalog);
  assert.match(prompt, /Fix the pair flow ordering/);
  assert.match(prompt, /LOCAL-1/);
  assert.match(prompt, /LOCAL-3/);
  assert.match(prompt, /IMPORTED-2/);
  assert.match(prompt, /EVERY Pattern Catalog entry/);
  assert.match(prompt, /\+ new/);
});

test("goldfish: a PASS over verified changes lets the session close as done", async () => {
  const root = scratch();
  try {
    writeFileSync(join(root, "chat-transcript.txt"), "CANARY-HISTORY-XYZ the owner said many things");
    applyChange(root, "export const value = 10;\nexport const other = 2;\n");
    verifyAll(root);
    let seenPrompt = "";
    const record = await runGoldfishReview(root, "Bump the value constant", "test-model", fakeProvider(PASS_JSON, p => { seenPrompt = p; }));
    assert.equal(record.verdict, "PASS");
    assert.equal(record.malformed, false);
    assert.match(seenPrompt, /LOCAL-3/);
    assert.match(seenPrompt, /value = 10/);
    assert.doesNotMatch(seenPrompt, /CANARY-HISTORY-XYZ/);
    assert.equal(goldfishStatus(root).state, "pass");
    const gate = sessionGate(root);
    assert.equal(gate.closable, true);
    assert.equal(gate.outcome, "done");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("goldfish: a BLOCK naming a catalog pattern holds the done label, by ID", async () => {
  const root = scratch();
  try {
    applyChange(root, "export const value = 1;\nexport const other = 2;\n// spend before validate\n");
    verifyAll(root);
    const record = await runGoldfishReview(root, "Reorder the pair flow", "test-model", fakeProvider(BLOCK_JSON));
    assert.equal(record.verdict, "BLOCK");
    assert.equal(record.findings[0].patternId, "LOCAL-3");
    assert.equal(goldfishStatus(root).state, "block");
    const gate = sessionGate(root);
    assert.equal(gate.closable, false);
    assert.match(gate.reasons.join(" "), /LOCAL-3/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("goldfish: unknown pattern IDs and malformed output both fail closed as BLOCK", async () => {
  const root = scratch();
  try {
    applyChange(root, "export const value = 3;\nexport const other = 2;\n");
    const badId = JSON.stringify({ verdict: "BLOCK", summary: "s", findings: [{ severity: "BLOCKER", detail: "d", evidence: "e", patternId: "LOCAL-99" }] });
    const record = await runGoldfishReview(root, "spec", "test-model", fakeProvider(badId));
    assert.equal(record.verdict, "BLOCK");
    assert.equal(record.malformed, true);
    const root2 = scratch();
    try {
      applyChange(root2, "export const value = 4;\nexport const other = 2;\n");
      const record2 = await runGoldfishReview(root2, "spec", "test-model", fakeProvider("not json at all"));
      assert.equal(record2.verdict, "BLOCK");
      assert.equal(record2.malformed, true);
      assert.equal(sessionGate(root2).closable, false);
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("goldfish: a change landing after a PASS makes the review stale until re-reviewed", async () => {
  const root = scratch();
  try {
    applyChange(root, "export const value = 5;\nexport const other = 2;\n");
    verifyAll(root);
    await runGoldfishReview(root, "spec", "test-model", fakeProvider(PASS_JSON));
    assert.equal(goldfishStatus(root).state, "pass");
    applyChange(root, "export const value = 6;\nexport const other = 2;\n");
    const stale = goldfishStatus(root);
    assert.equal(stale.state, "stale");
    assert.equal(stale.uncoveredChanges, 1);
    assert.equal(sessionGate(root).closable, false);
    verifyAll(root);
    await runGoldfishReview(root, "spec", "test-model", fakeProvider(PASS_JSON));
    assert.equal(goldfishStatus(root).state, "pass");
    assert.equal(sessionGate(root).outcome, "done");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("goldfish: refuses when the live source moved on, and when the catalog is missing", async () => {
  const root = scratch();
  try {
    applyChange(root, "export const value = 7;\nexport const other = 2;\n");
    writeFileSync(join(root, "code.ts"), "export const value = 999;\n");
    await assert.rejects(runGoldfishReview(root, "spec", "test-model", fakeProvider(PASS_JSON)), /no longer matches/);
  } finally { rmSync(root, { recursive: true, force: true }); }
  const bare = scratch(false);
  const emptyApp = mkdtempSync(join(tmpdir(), "sam-goldfish-app-"));
  const savedEnv = process.env.SAM_PATTERN_CATALOG;
  delete process.env.SAM_PATTERN_CATALOG;
  try {
    applyChange(bare, "export const value = 8;\nexport const other = 2;\n");
    await assert.rejects(runGoldfishReview(bare, "spec", "test-model", fakeProvider(PASS_JSON), { appRoot: emptyApp }), /Pattern Catalog not found/);
  } finally {
    if (savedEnv !== undefined) process.env.SAM_PATTERN_CATALOG = savedEnv;
    rmSync(bare, { recursive: true, force: true });
    rmSync(emptyApp, { recursive: true, force: true });
  }
});

test("goldfish C5: a C1 code write is reviewable - artifact recorded, live check reads the code root", async () => {
  const base = mkdtempSync(join(tmpdir(), "sam-goldfish-code-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(sam, "pattern-catalog.md"), CATALOG);
  try {
    setCodeRoot(sam, proj);
    const written = writeCodeFile(sam, "trading", "src/hello.ts", "export const hi = 'hello';\n");
    assert.ok(existsSync(join(sam, ".sam", "changes", written.afterHash + ".json")), "the write recorded a goldfish change artifact");
    verifyAll(sam);
    let seenPrompt = "";
    const record = await runGoldfishReview(sam, "Create the greeting export", "test-model", fakeProvider(PASS_JSON, p => { seenPrompt = p; }));
    assert.equal(record.verdict, "PASS");
    assert.match(seenPrompt, /src\/hello\.ts/);
    assert.match(seenPrompt, /export const hi/);
    assert.equal(goldfishStatus(sam).state, "pass");
    assert.equal(sessionGate(sam).outcome, "done");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("goldfish C5: a code-root source that moved on after the write refuses the review", async () => {
  const base = mkdtempSync(join(tmpdir(), "sam-goldfish-code-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(sam, "pattern-catalog.md"), CATALOG);
  try {
    setCodeRoot(sam, proj);
    writeCodeFile(sam, "trading", "src/hello.ts", "export const hi = 'hello';\n");
    writeFileSync(join(proj, "src/hello.ts"), "export const hi = 'tampered';\n");
    await assert.rejects(runGoldfishReview(sam, "Create the greeting export", "test-model", fakeProvider(PASS_JSON)), /no longer matches/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
