import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDashboardConfig, writeDashboardConfig, type DashboardConfig } from "./dashboard-config.js";
import { saveDashboardConfig } from "./dashboard.js";
import { coreActor } from "./chat-manage.js";
import { ChatStore } from "./chats.js";

// State convergence (UNIFICATION item 4, thirty-first store):
// the dashboard config migrated from whole-file
// dashboard-config.json rewrites (a torn write threw out of
// the dashboard reader, killing status reads and turn
// routing) to a one-row SQLite singleton with ONE read door -
// chat-manage's coreActor used to read the raw file itself
// with its own sanitization. These tests pin the migration
// contract: a legacy file imports with its fields sanitized
// exactly as the old dashboard reader did and is renamed
// (never deleted), a malformed / non-object file imports
// nothing and stays put while reading as the defaults, a
// pure read creates nothing, saves ride the DB as single-row
// UPSERTs with saveDashboardConfig's validation standing
// before the store, and a save over a migrated legacy config
// persists without resurrecting the file.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-dashboard-config-store-")); }

const LEGACY: DashboardConfig = { defaultAgent: "dip", showTeamEvents: false };
const DEFAULTS: DashboardConfig = { defaultAgent: "sam", showTeamEvents: true };

test("dashboard config store: a legacy dashboard-config.json imports intact, file renamed not deleted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "dashboard-config.json"), JSON.stringify(LEGACY, null, 2));
    assert.deepEqual(readDashboardConfig(root), LEGACY);
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.db")), true);
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.json")), false);
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "dashboard-config.json.migrated"), "utf8")) as Record<string, unknown>;
    assert.equal(kept.defaultAgent, LEGACY.defaultAgent);
    // The second reader rides the same door now: coreActor
    // resolves the migrated default agent, not "sam".
    assert.equal(coreActor(root), "dip");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dashboard config store: per-field misshape sanitizes on import, exactly the old dashboard read shape", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    // A non-string defaultAgent reads as "sam"; showTeamEvents
    // is false only when literally false.
    writeFileSync(join(root, ".sam", "dashboard-config.json"), JSON.stringify({ defaultAgent: 42, showTeamEvents: "no" }));
    assert.deepEqual(readDashboardConfig(root), DEFAULTS);
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.json.migrated")), true);
    // An empty-string defaultAgent is no agent at all: the
    // chat-manage reader's non-empty guard wins that edge.
    const root2 = fresh();
    try {
      mkdirSync(join(root2, ".sam"), { recursive: true });
      writeFileSync(join(root2, ".sam", "dashboard-config.json"), JSON.stringify({ defaultAgent: "", showTeamEvents: false }));
      assert.deepEqual(readDashboardConfig(root2), { defaultAgent: "sam", showTeamEvents: false });
      assert.equal(coreActor(root2), "sam");
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dashboard config store: malformed and non-object legacy files import nothing, stay in place, and read as the defaults", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const payloads = ["{ not json", "42", "\"dip\"", "[\"dip\"]", "null"];
    for (const payload of payloads) {
      writeFileSync(join(root, ".sam", "dashboard-config.json"), payload);
      assert.deepEqual(readDashboardConfig(root), DEFAULTS, payload);
      assert.equal(coreActor(root), "sam", payload);
      assert.equal(existsSync(join(root, ".sam", "dashboard-config.json")), true);
      assert.equal(existsSync(join(root, ".sam", "dashboard-config.json.migrated")), false);
    }
    // A save over an unimportable legacy file still lands in
    // the DB; the file itself is left exactly as found.
    writeDashboardConfig(root, LEGACY);
    assert.deepEqual(readDashboardConfig(root), LEGACY);
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.json")), true);
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dashboard config store: a pure read on an empty install creates nothing and returns the defaults", () => {
  const root = fresh();
  try {
    assert.deepEqual(readDashboardConfig(root), DEFAULTS);
    assert.equal(coreActor(root), "sam");
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.db")), false);
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.json")), false);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dashboard config store: saveDashboardConfig validation stands, and successive saves replace the config through the DB", () => {
  const root = fresh();
  try {
    const store = new ChatStore(root);
    try { store.createAgent("dip", "Dip's own SAM."); } finally { store.close(); }
    // Validation refuses before any store is touched: extra
    // keys, bad types, a bad name shape, an unknown agent.
    assert.throws(() => saveDashboardConfig(root, { defaultAgent: "dip", showTeamEvents: true, extra: 1 }), /Invalid dashboard configuration/);
    assert.throws(() => saveDashboardConfig(root, { defaultAgent: "dip", showTeamEvents: "yes" }), /Invalid dashboard configuration/);
    assert.throws(() => saveDashboardConfig(root, { defaultAgent: "Dip", showTeamEvents: true }), /Invalid dashboard configuration/);
    assert.throws(() => saveDashboardConfig(root, { defaultAgent: "ghost", showTeamEvents: true }), /Unknown agent/);
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.db")), false);
    assert.deepEqual(readDashboardConfig(root), DEFAULTS);
    // Good saves ride the DB only; the second replaces the first.
    assert.deepEqual(saveDashboardConfig(root, { defaultAgent: "dip", showTeamEvents: false }), LEGACY);
    assert.deepEqual(readDashboardConfig(root), LEGACY);
    assert.deepEqual(saveDashboardConfig(root, { defaultAgent: "sam", showTeamEvents: true }), DEFAULTS);
    assert.deepEqual(readDashboardConfig(root), DEFAULTS);
    assert.equal(coreActor(root), "sam");
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.json")), false);
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dashboard config store: a save over a migrated legacy config persists, the migrated file staying as history", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "dashboard-config.json"), JSON.stringify(LEGACY, null, 2));
    assert.deepEqual(readDashboardConfig(root), LEGACY);
    writeDashboardConfig(root, DEFAULTS);
    assert.deepEqual(readDashboardConfig(root), DEFAULTS);
    // The legacy values never come back, and the migrated file
    // is history, not a live source.
    assert.deepEqual(readDashboardConfig(root), DEFAULTS);
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.json")), false);
    assert.equal(existsSync(join(root, ".sam", "dashboard-config.json.migrated")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
