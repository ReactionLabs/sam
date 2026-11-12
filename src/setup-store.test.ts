import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSetupRecord, verifyAndSaveSetup, type SetupRecord } from "./config-wizard.js";
import { authStatus } from "./auth-status.js";

// State convergence (UNIFICATION item 4, twenty-ninth store):
// the verified setup baseline migrated from whole-file
// setup.json rewrites (a torn write silently erased the
// baseline, so a verified install read as never-verified) to
// a one-row SQLite singleton. These tests pin the migration
// contract: a legacy file imports with every field intact, is
// renamed (never deleted), a malformed / misshapen file
// imports nothing and stays put while reading as no baseline,
// a pure read creates nothing, a failed verification still
// saves nothing, saves ride the DB as single-row UPSERTs, and
// auth status reads its setupVerified header back through the
// migrated store.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-setup-store-")); }
function configuredEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/nonexistent/claude", SAM_GOG_BIN: "/nonexistent/gog", SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "<redacted>", ...extra };
}

const LEGACY: SetupRecord = { model: "MiniMax-M2.5", provider: "minimax", endpoint: null, verifiedAt: "2026-11-10T19:10:00.000Z", reply: "ready" };

test("setup store: a legacy setup.json imports intact, file renamed not deleted", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "setup.json"), JSON.stringify(LEGACY, null, 2));
    assert.deepEqual(readSetupRecord(root), LEGACY);
    assert.equal(existsSync(join(root, ".sam", "setup.db")), true);
    assert.equal(existsSync(join(root, ".sam", "setup.json")), false);
    assert.equal(existsSync(join(root, ".sam", "setup.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "setup.json.migrated"), "utf8")) as SetupRecord;
    assert.deepEqual(kept, LEGACY);
    // Auth status reads the migrated baseline back as its header.
    const s = authStatus(root, configuredEnv());
    assert.deepEqual(s.setupVerified, { model: LEGACY.model, verifiedAt: LEGACY.verifiedAt, current: true });
    // A save after migration rides the DB; no JSON is recreated,
    // and the DB's bytes carry no key value.
    const run = await verifyAndSaveSetup(root, configuredEnv(), async () => "ready again");
    assert.ok(run.saved);
    assert.equal(readSetupRecord(root)?.reply, "ready again");
    assert.equal(existsSync(join(root, ".sam", "setup.json")), false);
    assert.ok(!readFileSync(join(root, ".sam", "setup.db"), "utf8").includes("<redacted>"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup store: malformed and misshapen legacy files import nothing, stay in place, and read as no baseline", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    for (const payload of ["{ not json", JSON.stringify({ model: 42, verifiedAt: LEGACY.verifiedAt }), JSON.stringify({ model: "MiniMax-M2.5", verifiedAt: 42 }), JSON.stringify(["not", "an", "object"])]) {
      writeFileSync(join(root, ".sam", "setup.json"), payload);
      assert.equal(readSetupRecord(root), null, payload);
      assert.equal(existsSync(join(root, ".sam", "setup.json")), true);
      assert.equal(existsSync(join(root, ".sam", "setup.json.migrated")), false);
    }
    // A successful setup over an unimportable legacy file still
    // lands in the DB; the file itself is left exactly as found.
    const run = await verifyAndSaveSetup(root, configuredEnv(), async () => "ready");
    assert.ok(run.saved);
    assert.equal(readSetupRecord(root)?.model, "MiniMax-M2.5");
    assert.equal(existsSync(join(root, ".sam", "setup.json")), true);
    assert.equal(existsSync(join(root, ".sam", "setup.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup store: a pure read on an empty install creates nothing, and a failed verification saves nothing", async () => {
  const root = fresh();
  try {
    assert.equal(readSetupRecord(root), null);
    assert.equal(existsSync(join(root, ".sam", "setup.db")), false);
    assert.equal(existsSync(join(root, ".sam", "setup.json")), false);
    assert.equal(existsSync(join(root, ".sam")), false);
    const bad = await verifyAndSaveSetup(root, configuredEnv(), async () => { throw new Error("HTTP 500"); });
    assert.equal(bad.saved, null);
    assert.equal(readSetupRecord(root), null);
    assert.equal(existsSync(join(root, ".sam", "setup.db")), false);
    assert.equal(existsSync(join(root, ".sam", "setup.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup store: successive verified saves replace the baseline through the DB, never resurrecting the older one", async () => {
  const root = fresh();
  try {
    const first = await verifyAndSaveSetup(root, configuredEnv(), async () => "first");
    assert.ok(first.saved);
    const second = await verifyAndSaveSetup(root, configuredEnv({ SAM_MODEL: "MiniMax-M9" }), async () => "second");
    assert.ok(second.saved);
    const stored = readSetupRecord(root);
    assert.equal(stored?.model, "MiniMax-M9");
    assert.equal(stored?.reply, "second");
    assert.equal(stored?.verifiedAt, second.saved!.verifiedAt);
    assert.equal(existsSync(join(root, ".sam", "setup.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup store: a newer save over a migrated legacy baseline persists - the torn-write resurrection shape is gone", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "setup.json"), JSON.stringify(LEGACY, null, 2));
    assert.equal(readSetupRecord(root)?.verifiedAt, LEGACY.verifiedAt);
    const run = await verifyAndSaveSetup(root, configuredEnv({ SAM_MODEL: "MiniMax-M9" }), async () => "newer");
    assert.ok(run.saved);
    const stored = readSetupRecord(root);
    assert.equal(stored?.model, "MiniMax-M9");
    assert.equal(stored?.verifiedAt, run.saved!.verifiedAt);
    assert.equal(authStatus(root, configuredEnv({ SAM_MODEL: "MiniMax-M9" })).setupVerified?.current, true);
    assert.equal(existsSync(join(root, ".sam", "setup.json.migrated")), true);
    assert.equal(existsSync(join(root, ".sam", "setup.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
