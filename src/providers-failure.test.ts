import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { openDatabase } from "./sqlite.js";
import {
  addProvider, isProviderStoreLedgered, listProviders, providerStoreFailureSummary,
  readFileProviders, removeProvider, resolveTurnConnection, updateProvider,
} from "./providers.js";
import { classifyDefect } from "./self-work.js";

// Provider store failure visibility (gap found 2026-11-15,
// hourly run 00:04): the provider registry (.sam/providers.db)
// is read through readFileProviders by listProviders,
// resolveTurnConnection on every pinned turn, auth status,
// failover validation, the CLI, and observability, and written
// by add / update / remove - and every touch opened it raw: a
// dead providers.db threw into whichever catch wrapped the
// call, none naming the store. Each touch now ledgers ONE
// provider-store-failed line (phase read / write) and rethrows
// exactly, tagged; every caller's handling is unchanged and
// reads still fail closed (never folded as no file providers,
// which would silently drop every provider pin dressed as an
// empty registry).
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-providers-fail-"));
}

function failedLines(root: string) {
  return readActivity(root, 100, { kind: "provider-store-failed" });
}

function plantDeadStore(root: string): void {
  rmSync(join(root, ".sam", "providers.db"), { force: true });
  mkdirSync(join(root, ".sam", "providers.db"), { recursive: true });
}

const ENDPOINT = "https://providers.example.com/v1/chat/completions";
const INPUT = { id: "altprov", endpoint: ENDPOINT, keyEnv: "ALTPROV_SECRET_KEY", model: "Model-One" };

test("provider-store-failed: summary shapes collapse and cap the reason, and self-work classifies by phase", () => {
  assert.equal(providerStoreFailureSummary("read", "unable to open\n  database   file"), "Provider store read failed: unable to open database file");
  assert.equal(providerStoreFailureSummary("write", "disk gone"), "Provider store write failed: disk gone");
  assert.equal(providerStoreFailureSummary("write", "x".repeat(500)).length, 200);
  for (const phase of ["read", "write"] as const) {
    assert.deepEqual(
      classifyDefect({ at: "", actor: "sam", kind: "provider-store-failed", summary: providerStoreFailureSummary(phase, "boom") }),
      { key: "provider-store-failed:" + phase, label: "provider store failures (" + phase + " step)" },
    );
  }
});

test("provider-store-failed: a dead store ledgers exactly one line per touch, tagged, and rethrows", () => {
  const root = scratch();
  try {
    addProvider(root, INPUT, {});
    plantDeadStore(root);

    assert.throws(() => readFileProviders(root), (e: unknown) => isProviderStoreLedgered(e));
    let lines = failedLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].actor, "sam");
    assert.ok(lines[0].summary.startsWith("Provider store read failed: "), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "provider-store-failed:read", label: "provider store failures (read step)" });

    assert.throws(() => listProviders(root, {}), (e: unknown) => isProviderStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 2, "listProviders rides the one read door, exactly one more line");
    assert.ok(lines[1].summary.startsWith("Provider store read failed: "), lines[1].summary);

    assert.throws(() => resolveTurnConnection(root, {}, { provider: "altprov", model: null }, "chat"), (e: unknown) => isProviderStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 3, "a pinned turn's connection resolution ledgers exactly one more read line");

    assert.throws(() => updateProvider(root, "altprov", { model: "Model-Two" }, {}), (e: unknown) => isProviderStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 4, "the update door's open touch ledgers exactly one write line");
    assert.ok(lines[3].summary.startsWith("Provider store write failed: "), lines[3].summary);

    assert.throws(() => removeProvider(root, "altprov"), (e: unknown) => isProviderStoreLedgered(e));
    lines = failedLines(root);
    assert.equal(lines.length, 5, "the remove door's open touch ledgers exactly one write line");
    assert.ok(lines[4].summary.startsWith("Provider store write failed: "), lines[4].summary);

    assert.ok(!JSON.stringify(lines).includes("ALTPROV_SECRET_KEY"), "no key env name ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("providers.example.com"), "no endpoint ever enters a failure line");
    assert.ok(!JSON.stringify(lines).includes("Model-One"), "no model name ever enters a failure line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider-store-failed: an absent store reads as the env provider alone, and nothing is created or ledgered", () => {
  const root = scratch();
  try {
    assert.deepEqual(readFileProviders(root), []);
    assert.equal(listProviders(root, {}).length, 1, "the env provider alone");
    assert.equal(updateProvider(root, "nope", { model: "Model-Two" }, {}), null);
    assert.equal(removeProvider(root, "nope"), false);
    assert.equal(failedLines(root).length, 0, "nothing failed, so nothing ledgers");
    assert.equal(existsSync(join(root, ".sam", "providers.db")), false, "a pure read creates no store");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider-store-failed: validation errors are not store failures and ledger nothing", () => {
  const root = scratch();
  try {
    assert.throws(() => addProvider(root, { ...INPUT, id: "Bad Id" }, {}), (e: unknown) => /Invalid provider id/.test((e as Error).message) && !isProviderStoreLedgered(e));
    assert.throws(() => addProvider(root, { ...INPUT, id: "minimax" }, {}), (e: unknown) => /is reserved/.test((e as Error).message) && !isProviderStoreLedgered(e));
    assert.throws(() => addProvider(root, { ...INPUT, keyEnv: "lowercase" }, {}), (e: unknown) => /keyEnv must be/.test((e as Error).message) && !isProviderStoreLedgered(e));
    assert.throws(() => addProvider(root, { ...INPUT, endpoint: "http://providers.example.com/v1/chat/completions" }, {}), (e: unknown) => /Model endpoint must be/.test((e as Error).message) && !isProviderStoreLedgered(e));
    assert.throws(() => removeProvider(root, "default"), (e: unknown) => /not stored here/.test((e as Error).message) && !isProviderStoreLedgered(e));
    addProvider(root, INPUT, {});
    assert.throws(() => addProvider(root, INPUT, {}), (e: unknown) => /Provider already exists/.test((e as Error).message) && !isProviderStoreLedgered(e));
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider-store-failed: a healthy store adds, updates, and removes with zero failure lines", () => {
  const root = scratch();
  try {
    const added = addProvider(root, INPUT, {});
    assert.equal(added.id, "altprov");
    assert.equal(readFileProviders(root).length, 1);
    const patched = updateProvider(root, "altprov", { model: "Model-Two" }, {});
    assert.equal(patched?.model, "Model-Two");
    assert.equal(updateProvider(root, "nope", { model: "Model-Two" }, {}), null);
    assert.equal(removeProvider(root, "altprov"), true);
    assert.equal(removeProvider(root, "altprov"), false);
    assert.deepEqual(readFileProviders(root), []);
    assert.equal(failedLines(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider-store-failed: a failing insert ledgers exactly one write line with the verbatim reason", () => {
  const root = scratch();
  try {
    addProvider(root, INPUT, {});
    const raw = openDatabase(join(root, ".sam", "providers.db"));
    try {
      raw.exec("CREATE TRIGGER planted_insert_fail BEFORE INSERT ON providers BEGIN SELECT RAISE(ABORT, 'planted insert failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => addProvider(root, { ...INPUT, id: "otherprov" }, {}), (e: unknown) => isProviderStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the insert touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Provider store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted insert failure"), lines[0].summary);
    assert.deepEqual(classifyDefect(lines[0]), { key: "provider-store-failed:write", label: "provider store failures (write step)" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider-store-failed: a failing update ledgers exactly one write line with the verbatim reason", () => {
  const root = scratch();
  try {
    addProvider(root, INPUT, {});
    const raw = openDatabase(join(root, ".sam", "providers.db"));
    try {
      raw.exec("CREATE TRIGGER planted_update_fail BEFORE UPDATE ON providers BEGIN SELECT RAISE(ABORT, 'planted update failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => updateProvider(root, "altprov", { model: "Model-Two" }, {}), (e: unknown) => isProviderStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the update touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Provider store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted update failure"), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider-store-failed: a failing delete ledgers exactly one write line with the verbatim reason", () => {
  const root = scratch();
  try {
    addProvider(root, INPUT, {});
    const raw = openDatabase(join(root, ".sam", "providers.db"));
    try {
      raw.exec("CREATE TRIGGER planted_delete_fail BEFORE DELETE ON providers BEGIN SELECT RAISE(ABORT, 'planted delete failure'); END;");
    } finally { raw.close(); }
    assert.throws(() => removeProvider(root, "altprov"), (e: unknown) => isProviderStoreLedgered(e));
    const lines = failedLines(root);
    assert.equal(lines.length, 1, "the delete touch ledgers exactly one line");
    assert.ok(lines[0].summary.startsWith("Provider store write failed: "), lines[0].summary);
    assert.ok(lines[0].summary.includes("planted delete failure"), lines[0].summary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
