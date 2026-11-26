import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineProviderBlocker, isEngineProvider, setEngineProvider } from "./engine-connect.js";

// The engine-provider gate: the CLI `engine provider`
// door, setEngineProvider itself, and the config wizard's
// engine section each improvised the identical "Invalid
// engine provider" refusal (the wizard in its own variant
// wording) with no fold correction, so a folded name
// dead-ended with nothing to act on. engineProviderBlocker
// in engine-connect.ts is now the ONE source carrying the
// refusal text, and setEngineProvider throws it before
// recording anything. isEngineProvider and
// engineProviderDef stay permissive by design, so neither
// is gated here.

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "sam-engine-provider-gate-"));
}

test("engine provider gate: an exact provider id reads no blocker", () => {
  assert.equal(engineProviderBlocker("claude-code"), null);
  assert.equal(engineProviderBlocker("codex"), null);
  assert.equal(isEngineProvider("claude-code"), true);
});

test("engine provider gate: an unknown name names the valid providers", () => {
  const blocker = engineProviderBlocker("gpt");
  assert.equal(blocker, "Invalid engine provider: \"gpt\" (valid: claude-code, codex)");
  const root = fresh();
  try {
    assert.throws(() => setEngineProvider(root, "gpt" as never), (e: unknown) => e instanceof Error && e.message === blocker);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine provider gate: a folded name is refused with the correction", () => {
  assert.match(engineProviderBlocker("Claude Code")!, /Did you mean "claude-code"\?$/);
  assert.match(engineProviderBlocker("claude_code")!, /Did you mean "claude-code"\?$/);
  assert.match(engineProviderBlocker("CODEX")!, /Did you mean "codex"\?$/);
  const root = fresh();
  try {
    assert.throws(() => setEngineProvider(root, "Claude Code" as never), (e: unknown) => e instanceof Error && e.message === engineProviderBlocker("Claude Code"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine provider gate: a non-string value refuses naming the registry, no correction", () => {
  assert.equal(engineProviderBlocker(undefined), "Invalid engine provider: \"undefined\" (valid: claude-code, codex)");
  assert.equal(engineProviderBlocker(""), "Invalid engine provider: \"\" (valid: claude-code, codex)");
});

test("engine provider gate: an exact id still records through setEngineProvider", () => {
  const root = fresh();
  try {
    const record = setEngineProvider(root, "codex");
    assert.equal(record.provider, "codex");
    assert.equal(engineProviderBlocker(record.provider), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
