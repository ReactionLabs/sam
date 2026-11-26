import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_SECTIONS, configSectionBlocker, runConfigWizard } from "./config-wizard.js";

// The section-name gate for the config doors: every
// other naming door reads its registry through a ONE
// source in its owning module before acting - but the
// config section name was refused by TWO doors
// improvising the identical text independently (the CLI
// sections door in cli.ts and the wizard door in
// runConfigWizard), neither offering a fold correction,
// so a folded name ("Model" for "model") dead-ended
// with nothing beyond the list. configSectionBlocker in
// config-wizard.ts is now the ONE source carrying the
// refusal text: both doors throw it before showing or
// running anything. configSections / detectSetup stay
// permissive by design, so neither is gated here.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-config-section-gate-")); }

test("config section gate: every real section reads no blocker", () => {
  for (const section of CONFIG_SECTIONS) assert.equal(configSectionBlocker(section), null);
});

test("config section gate: an unknown name names the registry", () => {
  assert.equal(
    configSectionBlocker("billing"),
    "Unknown config section \"billing\". Sections: model, channels, keys, engine",
  );
  assert.equal(
    configSectionBlocker(""),
    "Unknown config section \"\". Sections: model, channels, keys, engine",
  );
});

test("config section gate: a folded name is refused with the correction", () => {
  assert.equal(
    configSectionBlocker("Model"),
    "Unknown config section \"Model\". Sections: model, channels, keys, engine. Did you mean \"model\"?",
  );
  assert.equal(
    configSectionBlocker("ENGINE"),
    "Unknown config section \"ENGINE\". Sections: model, channels, keys, engine. Did you mean \"engine\"?",
  );
  assert.equal(
    configSectionBlocker("keys_"),
    "Unknown config section \"keys_\". Sections: model, channels, keys, engine. Did you mean \"keys\"?",
  );
});

test("config section gate: a near miss with no fold match names no correction", () => {
  assert.equal(
    configSectionBlocker("models"),
    "Unknown config section \"models\". Sections: model, channels, keys, engine",
  );
});

test("config section gate: the wizard door throws the ONE source before opening", async () => {
  const root = fresh();
  try {
    const io = { print: () => {}, ask: async () => "" };
    await assert.rejects(
      runConfigWizard(root, io, { section: "Model" }),
      (error: unknown) => error instanceof Error && error.message === configSectionBlocker("Model"),
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});
