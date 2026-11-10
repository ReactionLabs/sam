import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { detectSetup, configSections, verifyModel, verifyAndSaveSetup, readSetupRecord, runConfigWizard } from "./config-wizard.js";
import { ChatStore } from "./chats.js";
import { channels, addChannel } from "./channels.js";
import { readActivity } from "./activity.js";

// CLI dressing item 1: the config wizard's detection, sections,
// verify-before-save, and scripted wizard flow. Env is built per test
// (never inherited) so a developer machine's real SAM_* vars cannot
// leak into a verdict.
function bareEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/nonexistent/claude", SAM_GOG_BIN: "/nonexistent/gog", ...extra };
}
function configuredEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return bareEnv({ SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "<redacted>", ...extra });
}
function scratch(): string { return mkdtempSync(join(tmpdir(), "sam-config-wizard-")); }

test("detect: an unconfigured install is first-run, with the missing pieces named and no secret values anywhere", () => {
  const root = scratch();
  try {
    const d = detectSetup(root, bareEnv());
    assert.equal(d.firstRun, true);
    assert.equal(d.modelReady, false);
    assert.equal(d.model, null);
    assert.equal(d.apiKey, "absent");
    assert.equal(d.engine.installed, false);
    assert.equal(d.senses.installed, false);
    assert.deepEqual(d.profiles.map(p => p.name), ["sam"]);
    assert.ok(d.keys.some(k => k.name === "SAM_MODEL_API_KEY" && k.state === "absent"));
    assert.ok(d.nextSteps.some(s => s.includes("SAM_MODEL")));
    assert.ok(d.nextSteps.some(s => s.includes("API key")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("detect: a configured install is not first-run; channel + connector credentials read as states, never values", () => {
  const root = scratch();
  try {
    const db = new ChatStore(root);
    try { db.createAgent("trading", "Trade desk.", { model: "MiniMax-M3" }); } finally { db.close(); }
    const env = configuredEnv({ SAM_CHANNEL_TG_MAIN: "channel-secret-do-not-print" });
    // A channel whose token env is set, written through the real store.
    addChannel(root, "telegram", "TG main", "trading", "SAM_CHANNEL_TG_MAIN");
    const d = detectSetup(root, env);
    assert.equal(d.firstRun, false);
    assert.equal(d.modelReady, true);
    assert.equal(d.model, "MiniMax-M2.5");
    assert.equal(d.apiKey, "present");
    assert.deepEqual(d.profiles.map(p => p.name), ["sam", "trading"]);
    assert.equal(d.profiles[1].model, "MiniMax-M3");
    assert.equal(d.channels.length, 1);
    assert.equal(d.channels[0].credential, "present");
    const asText = JSON.stringify(d);
    assert.ok(!asText.includes("channel-secret-do-not-print"), "channel token value must never appear");
    assert.ok(!asText.includes("<redacted>"), "API key value must never appear");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("detect: an endpoint-based install (no provider name) is NOT first-run - the turn's own requirements decide", () => {
  const root = scratch();
  try {
    const d = detectSetup(root, bareEnv({ SAM_MODEL_ENDPOINT: "https://models.example.test/v1/chat/completions", SAM_MODEL: "Any-1", SAM_MODEL_API_KEY: "k" }));
    assert.equal(d.firstRun, false);
    assert.equal(d.modelReady, false, "configReadiness still counts only the minimax shape; firstRun must not ride it");
    assert.equal(d.endpoint, "https://models.example.test/v1/chat/completions");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sections: four sections, model missing when unconfigured and ready when configured", () => {
  const root = scratch();
  try {
    const bare = configSections(root, bareEnv());
    assert.deepEqual(bare.map(s => s.id), ["model", "channels", "keys", "engine"]);
    assert.equal(bare[0].state, "missing");
    assert.ok(bare[2].lines.some(l => l.includes("never key values")));
    const ready = configSections(root, configuredEnv());
    assert.equal(ready[0].state, "ready");
    assert.ok(ready[0].lines.some(l => l.includes("MiniMax-M2.5")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verify: not-configured states refuse before any call; a completer's answer verifies; a throw fails clean", async () => {
  const noModel = await verifyModel(bareEnv(), async () => "ready");
  assert.equal(noModel.ok, false);
  assert.match(noModel.reason, /SAM_MODEL/);
  const noKey = await verifyModel(bareEnv({ SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5" }), async () => "ready");
  assert.equal(noKey.ok, false);
  assert.match(noKey.reason, /API key/);
  const ok = await verifyModel(configuredEnv(), async (model) => { assert.equal(model, "MiniMax-M2.5"); return "ready"; });
  assert.equal(ok.ok, true);
  assert.equal(ok.reply, "ready");
  const empty = await verifyModel(configuredEnv(), async () => "   ");
  assert.equal(empty.ok, false);
  const boom = await verifyModel(configuredEnv(), async () => { throw new Error("HTTP 401"); });
  assert.equal(boom.ok, false);
  assert.match(boom.reason, /HTTP 401/);
});

test("setup: verify-before-save - success records the baseline + ledger line, failure saves nothing", async () => {
  const root = scratch();
  try {
    const bad = await verifyAndSaveSetup(root, configuredEnv(), async () => { throw new Error("HTTP 500"); });
    assert.equal(bad.saved, null);
    assert.equal(readSetupRecord(root), null);
    assert.equal(existsSync(join(root, ".sam", "setup.json")), false);
    const good = await verifyAndSaveSetup(root, configuredEnv(), async () => "ready");
    assert.ok(good.saved);
    assert.equal(good.saved!.model, "MiniMax-M2.5");
    const record = readSetupRecord(root);
    assert.equal(record?.provider, "minimax");
    const raw = readFileSync(join(root, ".sam", "setup.json"), "utf8");
    assert.ok(!raw.includes("<redacted>"), "the setup record must never carry the key");
    assert.ok(readActivity(root, 50).some(l => l.kind === "setup-verified"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("wizard: scripted flow re-pins a profile through the real store, adds a channel, and refuses the core pin", async () => {
  const root = scratch();
  try {
    const db = new ChatStore(root);
    try { db.createAgent("trading", "Trade desk."); } finally { db.close(); }
    const prints: string[] = [];
    const answers = ["model", "trading", "MiniMax-M9", "n", "channels", "y", "TG main", "trading", "SAM_CHANNEL_TG_MAIN", ""];
    const io = {
      print: (line: string) => prints.push(line),
      ask: async (_q: string) => answers.shift() ?? "",
    };
    await runConfigWizard(root, io, { env: configuredEnv() });
    const db2 = new ChatStore(root);
    try { assert.equal(db2.agents().find(a => a.name === "trading")?.model, "MiniMax-M9"); } finally { db2.close(); }
    assert.equal(channels(root).length, 1);
    assert.ok(prints.some(l => l.includes("Saved: trading model pin")));
    assert.ok(prints.some(l => l.includes("Saved: channel TG main")));

    // The core profile refuses a pin, with the reason, and saves nothing.
    const prints2: string[] = [];
    const answers2 = ["sam", ""];
    const io2 = { print: (l: string) => prints2.push(l), ask: async () => answers2.shift() ?? "" };
    await runConfigWizard(root, io2, { section: "model", env: configuredEnv() });
    assert.ok(prints2.some(l => l.includes("core profile and carries no pin")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI: bare config prints sections without a TTY, detect reports first-run, setup without --live refuses", () => {
  const root = scratch();
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const env = bareEnv();
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "--workspace", root, ...args], { encoding: "utf8", env });
  try {
    const bare = run("config");
    assert.equal(bare.status, 0, bare.stderr);
    assert.match(bare.stdout, /== Model \(missing\) ==/);
    assert.match(bare.stdout, /Verified setup: none recorded/);
    const detect = run("--json", "config", "detect");
    assert.equal(JSON.parse(detect.stdout).firstRun, true);
    const sections = run("--json", "config", "sections", "--section", "keys");
    assert.deepEqual(JSON.parse(sections.stdout).sections.map((s: { id: string }) => s.id), ["keys"]);
    const setup = run("config", "setup");
    assert.notEqual(setup.status, 0, "setup without --live must refuse (explicit network opt-in)");
    assert.equal(existsSync(join(root, ".sam", "setup.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
