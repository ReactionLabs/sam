import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authStatus, probeAuth, readProbeStore, type ProbeRecord } from "./auth-status.js";
import { ChatStore } from "./chats.js";

// State convergence (UNIFICATION item 4, twenty-eighth store):
// the auth probe verdicts migrated from whole-file
// auth-probes.json rewrites (a torn write silently erased the
// last verdicts, so a failed chat route read as never-probed
// and the --check contract passed it again) to a one-row
// SQLite singleton. These tests pin the migration contract: a
// legacy file imports with every verdict intact, is renamed
// (never deleted), a malformed / misshapen file imports
// nothing and stays put while reading as no probe store, a
// pure read creates nothing, probe runs ride the DB as
// single-row UPSERTs, and auth status reads its verdicts back
// through the migrated store.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-auth-probes-store-")); }
function bareEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", SAM_ENGINE_BIN: "/nonexistent/claude", SAM_GOG_BIN: "/nonexistent/gog", ...extra };
}
function configuredEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return bareEnv({ SAM_MODEL_PROVIDER: "minimax", SAM_MODEL: "MiniMax-M2.5", MINIMAX_API_KEY: "<redacted>", ...extra });
}

const LEGACY_AT = "2026-11-10T20:11:00.000Z";
const LEGACY_RESULTS: ProbeRecord[] = [
  { target: "route:chat", kind: "route", model: "MiniMax-M2.5", bucket: "ok", reason: "Verified with one real completion.", at: LEGACY_AT, latencyMs: 812 },
  { target: "route:heartbeat", kind: "route", model: "MiniMax-M2.5", bucket: "ok", reason: "Verified with one real completion.", at: LEGACY_AT, latencyMs: 812 },
  { target: "profile:trading", kind: "profile", model: "Dead-Model-1", bucket: "auth", reason: "Model request failed (HTTP 401)", at: LEGACY_AT, latencyMs: 97 },
];

test("auth probes store: a legacy auth-probes.json imports intact, file renamed not deleted", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "auth-probes.json"), JSON.stringify({ at: LEGACY_AT, results: LEGACY_RESULTS }, null, 2));
    const db = new ChatStore(root);
    try { db.createAgent("trading", "Trade desk.", { model: "Dead-Model-1" }); } finally { db.close(); }
    assert.deepEqual(readProbeStore(root), { at: LEGACY_AT, results: LEGACY_RESULTS });
    assert.equal(existsSync(join(root, ".sam", "auth-probes.db")), true);
    assert.equal(existsSync(join(root, ".sam", "auth-probes.json")), false);
    assert.equal(existsSync(join(root, ".sam", "auth-probes.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(root, ".sam", "auth-probes.json.migrated"), "utf8")) as { at: string; results: ProbeRecord[] };
    assert.deepEqual(kept, { at: LEGACY_AT, results: LEGACY_RESULTS });
    // Auth status reads the migrated verdicts back without probing.
    const s = authStatus(root, configuredEnv());
    assert.equal(s.lastProbeAt, LEGACY_AT);
    assert.equal(s.routes.find(r => r.route === "chat")!.lastProbe?.bucket, "ok");
    assert.equal(s.profiles.find(p => p.profile === "trading")!.lastProbe?.bucket, "auth");
    assert.equal(s.healthy, true, "the chat route's ok verdict carries the check; the dead pin informs only");
    // A probe after migration rides the DB; no JSON is recreated,
    // and the DB's bytes carry no key value.
    const run = await probeAuth(root, configuredEnv(), async () => "ready");
    assert.equal(run.ok, true);
    assert.deepEqual(readProbeStore(root), { at: run.at, results: run.results });
    assert.equal(existsSync(join(root, ".sam", "auth-probes.json")), false);
    assert.ok(!readFileSync(join(root, ".sam", "auth-probes.db"), "utf8").includes("<redacted>"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("auth probes store: malformed and misshapen legacy files import nothing, stay in place, and read as no probe store", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    for (const payload of ["{ not json", JSON.stringify({ at: 42, results: [] }), JSON.stringify({ at: LEGACY_AT, results: "nope" }), JSON.stringify(["not", "an", "object"])]) {
      writeFileSync(join(root, ".sam", "auth-probes.json"), payload);
      assert.equal(readProbeStore(root), null, payload);
      assert.equal(existsSync(join(root, ".sam", "auth-probes.json")), true);
      assert.equal(existsSync(join(root, ".sam", "auth-probes.json.migrated")), false);
    }
    // A probe over an unimportable legacy file still lands in the
    // DB; the file itself is left exactly as found.
    const run = await probeAuth(root, configuredEnv(), async () => "ready");
    assert.equal(run.ok, true);
    assert.deepEqual(readProbeStore(root), { at: run.at, results: run.results });
    assert.equal(existsSync(join(root, ".sam", "auth-probes.json")), true);
    assert.equal(existsSync(join(root, ".sam", "auth-probes.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("auth probes store: a pure read on an empty install creates nothing", () => {
  const root = fresh();
  try {
    assert.equal(readProbeStore(root), null);
    assert.equal(existsSync(join(root, ".sam", "auth-probes.db")), false);
    assert.equal(existsSync(join(root, ".sam", "auth-probes.json")), false);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("auth probes store: successive probe runs replace the verdict set through the DB, never resurrecting the older run", async () => {
  const root = fresh();
  try {
    const failing = await probeAuth(root, configuredEnv(), async () => { throw new Error("HTTP 429 too many requests"); });
    assert.equal(failing.ok, false);
    assert.equal(readProbeStore(root)?.at, failing.at);
    assert.equal(authStatus(root, configuredEnv()).healthy, false, "a probed-and-failing chat route fails the check");
    const passing = await probeAuth(root, configuredEnv(), async () => "ready");
    assert.equal(passing.ok, true);
    const stored = readProbeStore(root);
    assert.equal(stored?.at, passing.at);
    assert.ok(stored!.results.every(r => r.bucket === "ok"));
    assert.equal(authStatus(root, configuredEnv()).healthy, true);
    assert.equal(existsSync(join(root, ".sam", "auth-probes.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("auth probes store: a failed verdict over a migrated legacy ok set persists - the torn-write resurrection shape is gone", async () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    writeFileSync(join(root, ".sam", "auth-probes.json"), JSON.stringify({ at: LEGACY_AT, results: LEGACY_RESULTS }, null, 2));
    assert.equal(readProbeStore(root)?.at, LEGACY_AT);
    const run = await probeAuth(root, configuredEnv(), async () => { throw new Error("Model request failed (HTTP 401)"); });
    assert.equal(run.ok, false);
    const stored = readProbeStore(root);
    assert.equal(stored?.at, run.at);
    assert.equal(stored?.results.find(r => r.target === "route:chat")?.bucket, "auth");
    assert.equal(authStatus(root, configuredEnv()).healthy, false, "the newer failed verdict, not the migrated ok, decides the check");
    assert.equal(existsSync(join(root, ".sam", "auth-probes.json.migrated")), true);
    assert.equal(existsSync(join(root, ".sam", "auth-probes.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
