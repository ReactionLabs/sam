import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCoreSenseActor, clampSenseDays, clampSenseMax, runSense, sanitizeMailQuery, senseArgv, sensesBinary, sensesStatus, SENSES_NOT_INSTALLED, type SenseRunner } from "./senses.js";
import { executeOwnToolAsync, OWN_TOOLS } from "./own-tools.js";
import { ChatStore } from "./chats.js";
import { readActivity } from "./activity.js";
import { CORE_OWN_TOOLS } from "./tool-tiers.js";

// Phase E item 2: the core profile's read-only Gmail + Calendar
// senses. Fixtures use a REAL fake reader binary on disk (so the
// SAM_GOG_BIN resolution is exercised as behavior) with an
// injected runner (so the fixed argv is asserted exactly).

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-senses-"));
  const root = join(base, "home");
  const binDir = join(base, "bin");
  mkdirSync(root, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const gog = join(binDir, "gog");
  writeFileSync(gog, "#!/bin/sh\nexit 0\n");
  chmodSync(gog, 0o755);
  return { base, root, binDir, gog, env: { SAM_GOG_BIN: gog, PATH: binDir } as NodeJS.ProcessEnv };
}

test("senses: the reader resolves SAM_GOG_BIN first, then gog on PATH, else not installed", () => {
  const f = fixture();
  try {
    assert.equal(sensesBinary(f.env), f.gog);
    assert.equal(sensesBinary({ PATH: f.binDir }), f.gog);
    assert.equal(sensesBinary({ SAM_GOG_BIN: join(f.binDir, "missing"), PATH: f.binDir }), null);
    assert.equal(sensesBinary({ PATH: "" }), null);
    const st = sensesStatus(f.env);
    assert.equal(st.installed, true);
    assert.equal(st.coreOnly, true);
    assert.deepEqual(st.senses, ["mail", "agenda"]);
    assert.equal(sensesStatus({ PATH: "" }).installed, false);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("senses: the core-only fence refuses every scoped profile and names the rule", () => {
  assert.doesNotThrow(() => assertCoreSenseActor("sam"));
  for (const actor of ["trading", "dip", "second-shift", ""]) {
    assert.throws(() => assertCoreSenseActor(actor), /core profile's senses/);
  }
});

test("senses: mail queries are sanitized and parameters clamped", () => {
  assert.equal(sanitizeMailQuery(undefined), "in:inbox newer_than:7d");
  assert.equal(sanitizeMailQuery("  from:landlord rent  "), "from:landlord rent");
  assert.throws(() => sanitizeMailQuery("--json"), /must not start with/);
  assert.throws(() => sanitizeMailQuery("a\nb"), /control characters/);
  assert.throws(() => sanitizeMailQuery("x".repeat(201)), /too long/);
  assert.equal(clampSenseMax(undefined), 10);
  assert.equal(clampSenseMax(0), 1);
  assert.equal(clampSenseMax(99), 25);
  assert.equal(clampSenseDays(undefined), 1);
  assert.equal(clampSenseDays(0), 1);
  assert.equal(clampSenseDays(30), 7);
});

test("senses: argv shapes are fixed in code - the caller supplies only bounded parameters", () => {
  assert.deepEqual(senseArgv("mail", { query: "from:a@b.c", max: 5 }), ["gmail", "search", "from:a@b.c", "--max", "5", "--json"]);
  const now = new Date("2026-11-10T15:00:00.000Z");
  assert.deepEqual(senseArgv("agenda", { days: 2, now }), ["calendar", "events", "--from", "2026-11-10T15:00:00.000Z", "--to", "2026-11-12T15:00:00.000Z", "--json"]);
});

test("senses: a read runs the fixed argv, returns capped untrusted output, and ledgers without content", async () => {
  const f = fixture();
  try {
    const seen: Array<{ file: string; args: string[] }> = [];
    const runner: SenseRunner = async (file, args) => { seen.push({ file, args }); return { exitCode: 0, output: "[{\"subject\":\"Rent due\"}]" }; };
    const r = await runSense(f.root, "sam", "mail", { query: "rent", env: f.env, runner });
    assert.equal(r.ok, true);
    assert.equal(r.output, "[{\"subject\":\"Rent due\"}]");
    assert.deepEqual(seen, [{ file: f.gog, args: ["gmail", "search", "rent", "--max", "10", "--json"] }]);
    const lines = readActivity(f.root, 10, { kind: "sense-read" });
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /Sense mail read: ok/);
    assert.doesNotMatch(lines[0].summary, /Rent due|rent/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("senses: not installed reports cleanly as data; a failed read names authorization; a scoped actor is refused", async () => {
  const f = fixture();
  try {
    const missing = await runSense(f.root, "sam", "agenda", { env: { PATH: "" } });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, SENSES_NOT_INSTALLED);
    const failing: SenseRunner = async () => ({ exitCode: 3, output: "auth error detail" });
    const failed = await runSense(f.root, "sam", "mail", { env: f.env, runner: failing });
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? "", /may not be authorized/);
    assert.equal(failed.output, "auth error detail");
    const okRunner: SenseRunner = async () => ({ exitCode: 0, output: "[]" });
    await assert.rejects(() => runSense(f.root, "trading", "mail", { env: f.env, runner: okRunner }), /core profile's senses/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("senses: sam_senses is a core own tool - status works, scoped actors and visitors are refused", async () => {
  const f = fixture();
  try {
    assert.ok(OWN_TOOLS.some(t => (t as { function?: { name?: string } }).function?.name === "sam_senses"));
    // The core tier is full (14 of 14 upfront slots), so sam_senses rides
    // the deferred tier by design: catalogued by name, loaded on demand
    // through sam_load_tools, and promoted upfront once loaded.
    assert.ok(!CORE_OWN_TOOLS.includes("sam_senses"));
    const status = await executeOwnToolAsync(f.root, "sam", "sam_senses", { action: "status" }) as { senses?: string[] };
    assert.deepEqual(status.senses, ["mail", "agenda"]);
    const scoped = await executeOwnToolAsync(f.root, "trading", "sam_senses", { action: "mail" }) as { error?: string };
    assert.match(scoped.error ?? "", /core profile's senses/);
    const db = new ChatStore(f.root);
    let visitorId = "";
    try { visitorId = db.create("Door", null, { visitor: true }).id; } finally { db.close(); }
    const visitor = await executeOwnToolAsync(f.root, "sam", "sam_senses", { action: "mail" }, undefined, visitorId) as { error?: string };
    assert.match(visitor.error ?? "", /[Vv]isitors cannot/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
