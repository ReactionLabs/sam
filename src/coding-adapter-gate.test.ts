import test from "node:test";
import assert from "node:assert/strict";
import { CODING_ADAPTERS, codingAdapterBlocker, validateDelegateDetail, validateDelegateSpec } from "./coding-operatives.js";

// The coding-adapter gate: the coding adapter is a registry
// name (CODING_ADAPTERS in coding-operatives.ts: codex,
// claude-code) that a person types at the CLI `delegate
// <adapter>` door and the model names in a delegate action
// detail. Every route rides ONE seam - validateDelegateSpec
// (the CLI door through proposeDelegation, the P1 gate
// through validateDelegateDetail) - but its refusal named
// the adapters with no fold correction, so a folded name
// ("Codex", "claude code", "claude_code") dead-ended.
// codingAdapterBlocker in coding-operatives.ts is now the
// ONE source carrying the refusal text; validateDelegateSpec
// throws it before anything else. Stored-adapter readers
// stay permissive by design (a delegation record's adapter
// is cast on read).

test("coding adapter gate: every exact adapter reads no blocker", () => {
  for (const adapter of CODING_ADAPTERS) assert.equal(codingAdapterBlocker(adapter), null, adapter);
  assert.equal(CODING_ADAPTERS.length, 2);
});

test("coding adapter gate: an unknown adapter names the adapters, no correction", () => {
  assert.equal(
    codingAdapterBlocker("gemini"),
    "Unknown coding adapter \"gemini\". Adapters: codex, claude-code",
  );
});

test("coding adapter gate: a folded name is refused with the correction", () => {
  assert.match(codingAdapterBlocker("Codex")!, /Did you mean "codex"\?$/);
  assert.match(codingAdapterBlocker("CLAUDE-CODE")!, /Did you mean "claude-code"\?$/);
  assert.match(codingAdapterBlocker("claude code")!, /Did you mean "claude-code"\?$/);
  assert.match(codingAdapterBlocker("claude_code")!, /Did you mean "claude-code"\?$/);
});

test("coding adapter gate: a non-string value refuses naming the registry, no correction", () => {
  assert.equal(codingAdapterBlocker(42), "Unknown coding adapter \"42\". Adapters: codex, claude-code");
  assert.equal(codingAdapterBlocker(""), "Unknown coding adapter \"\". Adapters: codex, claude-code");
});

test("coding adapter gate: both seams throw the ONE source before any other check", () => {
  assert.throws(
    () => validateDelegateSpec({ adapter: "claude code", repo: "/nonexistent", branch: "sam/x", prompt: "do it" }),
    /Unknown coding adapter "claude code"\. Adapters: codex, claude-code\. Did you mean "claude-code"\?$/,
  );
  assert.throws(
    () => validateDelegateDetail(JSON.stringify({ adapter: "Codex", repo: "/nonexistent", branch: "sam/x", prompt: "do it" })),
    /Unknown coding adapter "Codex"\. Adapters: codex, claude-code\. Did you mean "codex"\?$/,
  );
});
