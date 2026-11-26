import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfigWizard } from "./config-wizard.js";
import { ChatStore } from "./chats.js";
import { readActivity } from "./activity.js";

// The profile gate for the config wizard's model section:
// the wizard is a re-pin door (it rides setAgentModel and
// ledgers an agent-repin line "via config wizard"), but it
// discovered an unknown profile only after the setter
// returned null - after the operator had already typed the
// model - and refused with its own "Known profiles" wording
// and no fold correction, while every sibling re-pin door
// throws agentRepinProfileBlocker from agent-repins.ts
// before re-pinning anything. The wizard now checks that
// ONE source right after the profile name is entered,
// before the "sam" core refusal ("sam" passes the blocker,
// then refuses for its own reason) and before the model
// prompt. The ChatStore setters stay permissive by design
// and are NOT gated here.

function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-config-wizard-profile-gate-")); }

function configuredEnv(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/nonexistent/claude", SAM_GOG_BIN: "/nonexistent/gog", SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "<redacted>" };
}

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

function scriptedIo(answers: string[]): { prints: string[]; asked: string[]; io: { print: (line: string) => void; ask: (q: string) => Promise<string> } } {
  const prints: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  return {
    prints,
    asked,
    io: {
      print: (line: string) => prints.push(line),
      ask: async (q: string) => { asked.push(q); return queue.shift() ?? ""; },
    },
  };
}

function storedModel(root: string, name: string): string | null | undefined {
  const db = new ChatStore(root);
  try { return db.agents().find(a => a.name === name)?.model; } finally { db.close(); }
}

test("config wizard profile gate: a folded name is refused with the correction before the model is asked, and nothing is re-pinned", async () => {
  const root = scratch();
  try {
    register(root, "second-shift");
    const { prints, asked, io } = scriptedIo(["Second Shift"]);
    await runConfigWizard(root, io, { section: "model", env: configuredEnv() });
    assert.ok(prints.some(l => l === "Refused: Unknown profile \"Second Shift\" in agent re-pin detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?"), prints.join("\n"));
    assert.ok(!asked.some(q => q.includes("Model for")), "the model prompt is never reached for a refused profile");
    assert.equal(storedModel(root, "second-shift"), null);
    assert.ok(!readActivity(root, 50).some(l => l.kind === "agent-repin"), "no re-pin was ledgered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("config wizard profile gate: an unknown profile names the registry, with no correction when nothing folds to it", async () => {
  const root = scratch();
  try {
    register(root, "second-shift");
    const { prints, io } = scriptedIo(["nosuchprofile"]);
    await runConfigWizard(root, io, { section: "model", env: configuredEnv() });
    assert.ok(prints.some(l => l === "Refused: Unknown profile \"nosuchprofile\" in agent re-pin detail. Valid profiles: sam, second-shift"), prints.join("\n"));
    assert.ok(!prints.some(l => l.includes("Known profiles")), "the wizard's old inline wording is gone");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("config wizard profile gate: an ambiguous fold names no correction", async () => {
  const root = scratch();
  try {
    register(root, "second-shift");
    register(root, "second_shift");
    const { prints, io } = scriptedIo(["Second Shift"]);
    await runConfigWizard(root, io, { section: "model", env: configuredEnv() });
    assert.ok(prints.some(l => l === "Refused: Unknown profile \"Second Shift\" in agent re-pin detail. Valid profiles: sam, second-shift, second_shift"), prints.join("\n"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("config wizard profile gate: sam passes the blocker and keeps its core refusal", async () => {
  const root = scratch();
  try {
    const { prints, io } = scriptedIo(["sam"]);
    await runConfigWizard(root, io, { section: "model", env: configuredEnv() });
    assert.ok(prints.some(l => l.includes("core profile and carries no pin")), prints.join("\n"));
    assert.ok(!prints.some(l => l.startsWith("Refused: Unknown profile")), prints.join("\n"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("config wizard profile gate: a registered profile still re-pins cleanly through the wizard", async () => {
  const root = scratch();
  try {
    register(root, "second-shift");
    const { prints, io } = scriptedIo(["second-shift", "MiniMax-M9", "n"]);
    await runConfigWizard(root, io, { section: "model", env: configuredEnv() });
    assert.equal(storedModel(root, "second-shift"), "MiniMax-M9");
    assert.ok(prints.some(l => l.includes("Saved: second-shift model pin is now MiniMax-M9.")), prints.join("\n"));
    assert.ok(readActivity(root, 50).some(l => l.kind === "agent-repin" && l.summary.includes("via config wizard")), "the re-pin ledgered through the wizard seam");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
