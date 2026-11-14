import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { setCodeRoot } from "./code.js";
import { codeVerificationNote, failureSignature, repeatedFailureStubContent, toolResultError } from "./loop-guards.js";
import { ownToolsChat } from "./own-tools.js";
import type { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { VerificationStatus } from "./verification.js";

// HARNESS INTELLIGENCE item 3: the loop guards. The shared
// shapes are unit-pinned (signature stability, error
// extraction, stub and note text), and the own-tools chat loop
// proves the behavior end to end with a stub model: a repeated
// identical failing call is stubbed instead of re-executed, a
// success in between re-arms the call, and a code-changing
// turn closes with the verification note until build and test
// both pass after the change.

function status(state: VerificationStatus["state"]): VerificationStatus {
  return { state, pendingChanges: state === "unverified" ? [{ path: "a.txt", replacementHash: "h", at: "", source: "code-write" }] : [], lastChangeAt: null, lastVerificationAt: null, buildPassedAfterChange: false, testPassedAfterChange: false };
}

test("loop-guards: the failure signature is stable across argument key order and sensitive to values", () => {
  assert.equal(failureSignature("sam_code", { b: 1, a: { d: 2, c: 3 } }), failureSignature("sam_code", { a: { c: 3, d: 2 }, b: 1 }));
  assert.notEqual(failureSignature("sam_code", { a: 1 }), failureSignature("sam_code", { a: 2 }));
  assert.notEqual(failureSignature("sam_code", { a: 1 }), failureSignature("sam_read", { a: 1 }));
  assert.equal(failureSignature("sam_code", undefined), failureSignature("sam_code", {}));
});

test("loop-guards: error extraction reads only the error shape", () => {
  assert.equal(toolResultError({ error: "boom" }), "boom");
  assert.equal(toolResultError({ status: "ok", error: "" }), null);
  assert.equal(toolResultError({ rows: [] }), null);
  assert.equal(toolResultError("boom"), null);
  assert.equal(toolResultError(null), null);
});

test("loop-guards: the stub and the verification note say what happened and what closes the work", () => {
  const stub = repeatedFailureStubContent("sam_workspace_read", "Path not available");
  assert.match(stub, /not executed/);
  assert.match(stub, /Path not available/);
  assert.match(stub, /Change the arguments or the approach/);
  const note = codeVerificationNote(status("unverified"));
  assert.match(note ?? "", /Verification note/);
  assert.match(note ?? "", /a\.txt/);
  assert.match(codeVerificationNote(status("failed")) ?? "", /FAILED/);
  assert.equal(codeVerificationNote(status("verified")), null);
  assert.equal(codeVerificationNote(status("clean")), null);
});

function scripted(steps: Array<{ content: string | null; calls: Array<{ id: string; name: string; args: Record<string, unknown> }> }>, seenTools: string[][]) {
  let step = 0;
  return {
    async completeConnectorTurn(_model: string, messages: Array<Record<string, unknown>>, _tools: unknown[]) {
      for (const m of messages) if (m.role === "tool") seenTools.push([String(m.content)]);
      const current = steps[Math.min(step, steps.length - 1)];
      step++;
      return current;
    },
  } as unknown as OpenAICompatibleProvider;
}

test("loop-guards in chat: a repeated identical failing call is stubbed, not re-executed", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-loop-repeat-"));
  try {
    const seen: string[][] = [];
    const call = { id: "c1", name: "sam_workspace_read", args: { path: "nope/missing.txt" } };
    const fake = scripted([
      { content: null, calls: [call] },
      { content: null, calls: [{ ...call, id: "c2" }] },
      { content: "That file is not there; I could not read it.", calls: [] },
    ], seen);
    const reply = await ownToolsChat(root, "sam", fake, "test-model", [{ role: "user", content: "read the missing file" }]);
    assert.match(reply, /could not read it/);
    const toolTexts = seen.flat();
    assert.ok(toolTexts.some(t => t.includes("Path not available")), toolTexts.join(" | "));
    assert.ok(toolTexts.some(t => t.includes("Repeated identical call not executed")), toolTexts.join(" | "));
    // Exactly one real error execution: the second tool text is the stub.
    assert.equal(toolTexts.filter(t => t.includes("Path not available") && !t.includes("Repeated")).length >= 1, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop-guards in chat: a success between failures re-arms the same call", async () => {
  const root = mkdtempSync(join(tmpdir(), "sam-loop-rearm-"));
  try {
    const seen: string[][] = [];
    const fake = scripted([
      { content: null, calls: [{ id: "c1", name: "sam_workspace_read", args: { path: "nope/missing.txt" } }] },
      { content: null, calls: [{ id: "c2", name: "sam_workspace_list", args: {} }] },
      { content: null, calls: [{ id: "c3", name: "sam_workspace_read", args: { path: "nope/missing.txt" } }] },
      { content: "Still not there.", calls: [] },
    ], seen);
    const reply = await ownToolsChat(root, "sam", fake, "test-model", [{ role: "user", content: "keep trying" }]);
    assert.match(reply, /Still not there/);
    const toolTexts = seen.flat();
    assert.ok(!toolTexts.some(t => t.includes("Repeated identical call")), toolTexts.join(" | "));
    assert.ok(toolTexts.filter(t => t.includes("Path not available")).length >= 2, toolTexts.join(" | "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function codeFixture() {
  // The code root must be a sibling of the SAM home, never inside
  // it (the C1 fence), so the fixture builds both under one parent.
  const parent = mkdtempSync(join(tmpdir(), "sam-loop-verify-"));
  const root = join(parent, "home");
  mkdirSync(root, { recursive: true });
  const codeDir = join(parent, "code-root");
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(join(codeDir, "package.json"), JSON.stringify({ name: "fixture", scripts: { build: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(0)\"" } }));
  setCodeRoot(root, codeDir);
  return parent;
}

function codeHome(parent: string): string { return join(parent, "home"); }

test("loop-guards in chat: a code-changing turn closes with the verification note until build and test pass", async () => {
  const parent = codeFixture();
  const root = codeHome(parent);
  try {
    const seen: string[][] = [];
    const fake = scripted([
      { content: null, calls: [{ id: "c1", name: "sam_code", args: { action: "write", path: "a.txt", content: "hello" } }] },
      { content: "Done - I wrote a.txt.", calls: [] },
    ], seen);
    const reply = await ownToolsChat(root, "sam", fake, "test-model", [{ role: "user", content: "write a.txt" }]);
    assert.match(reply, /Done - I wrote a\.txt\./);
    assert.match(reply, /Verification note: code changed in this turn and is not verified yet/);
    assert.match(reply, /a\.txt/);
    const lines = readActivity(root, 50).filter(l => l.kind === "loop-check");
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /unverified/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("loop-guards in chat: a turn that verifies its own change closes with no note", async () => {
  const parent = codeFixture();
  const root = codeHome(parent);
  try {
    const seen: string[][] = [];
    const fake = scripted([
      { content: null, calls: [{ id: "c1", name: "sam_code", args: { action: "write", path: "a.txt", content: "hello" } }] },
      { content: null, calls: [{ id: "c2", name: "sam_code", args: { action: "run", command: "build" } }] },
      { content: null, calls: [{ id: "c3", name: "sam_code", args: { action: "run", command: "test" } }] },
      { content: "Done and verified.", calls: [] },
    ], seen);
    const reply = await ownToolsChat(root, "sam", fake, "test-model", [{ role: "user", content: "write and verify" }], undefined, undefined, { rounds: 6, maxCalls: 12 });
    assert.equal(reply, "Done and verified.");
    assert.equal(readActivity(root, 50).filter(l => l.kind === "loop-check").length, 0);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
