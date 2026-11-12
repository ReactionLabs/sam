import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivity } from "./activity.js";
import { addConnector } from "./connectors.js";
import { setCodeRoot } from "./code.js";
import { buildSelfAudit, readSelfAudit, runSelfAudit, selfAuditText } from "./self-audit.js";

// SELF-WORK step 0: the capability self-audit. The audit is
// assembled in code from the live doors, so a capability reads
// "can" only when its door reads ready, every "cannot" names
// the act (and the actor) that would clear it, and the two
// standing fences (no external sends; never editing SAM's own
// gate/policy/allowlist code) read as cannots in every state.
// A run persists to the one-row SQLite store and ledgers one
// counts-only line; a pure read creates nothing; a legacy JSON
// record imports once and is renamed, never deleted.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-self-audit-")); }

test("self-audit: an empty install maps honestly - fences as cannots, missing doors named with their operator acts", () => {
  const root = fresh();
  try {
    const audit = buildSelfAudit(root, {});
    assert.ok(audit.tools.ownCount >= 20);
    assert.ok(audit.tools.core.includes("sam_code"));
    assert.ok(audit.tools.scriptCommands.includes("sam-self-audit"));
    assert.equal(audit.code.root, null);
    assert.equal(audit.engine.installed, false);
    assert.equal(audit.senses.installed, false);
    const cannot = new Map(audit.cannot.map(c => [c.capability, c.detail]));
    assert.match(cannot.get("coder hands") ?? "", /operator's act/);
    assert.match(cannot.get("managed coding-engine runs") ?? "", /not installed/);
    assert.match(cannot.get("read the owner's mail and calendar") ?? "", /not installed/);
    assert.match(cannot.get("send anything externally") ?? "", /P12/);
    assert.match(cannot.get("edit SAM's own gate, policy, or allowlist code") ?? "", /owner-only, forever/);
    const can = audit.can.map(c => c.capability);
    assert.ok(can.includes("chat, memory, and standing law"));
    assert.ok(can.includes("propose gated actions"));
    // Building alone records nothing.
    assert.equal(readSelfAudit(root), null);
    assert.equal(existsSync(join(root, ".sam", "self-audit.db")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-audit: ready doors flip their verdicts to can - a designated code root and a credentialed connector", () => {
  const root = fresh();
  const codeRoot = fresh();
  try {
    writeFileSync(join(codeRoot, "package.json"), JSON.stringify({ name: "x", scripts: { build: "true", test: "true" } }));
    setCodeRoot(root, codeRoot);
    process.env.SAM_MCP_ALLOWED_HOSTS = "trading.example.com";
    addConnector(root, "Nines", "https://trading.example.com/mcp/v1", "SAM_MCP_TOKEN_TEST");
    const audit = buildSelfAudit(root, { SAM_MCP_TOKEN_TEST: "x" });
    const can = new Map(audit.can.map(c => [c.capability, c.detail]));
    assert.match(can.get("coder hands in the code root") ?? "", /write\/edit/);
    assert.match(can.get("read through the Nines connector") ?? "", /read-only tools/);
    assert.equal(audit.code.root, codeRoot);
    // Without the credential env in the process, the same
    // connector flips back to a cannot naming the gap.
    const blind = buildSelfAudit(root, {});
    assert.match(blind.cannot.find(c => /Nines/.test(c.capability))?.detail ?? "", /credential env is not present/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(codeRoot, { recursive: true, force: true }); }
});

test("self-audit: a run persists through the store, ledgers counts only, and a second run replaces the record", () => {
  const root = fresh();
  try {
    const first = runSelfAudit(root, {});
    assert.equal(existsSync(join(root, ".sam", "self-audit.db")), true);
    assert.equal(existsSync(join(root, ".sam", "self-audit.json")), false);
    const read = readSelfAudit(root);
    assert.deepEqual(read, first);
    const lines = readActivity(root, 10).filter(l => l.kind === "self-audit");
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /can, .* cannot/);
    const second = runSelfAudit(root, {});
    assert.deepEqual(readSelfAudit(root), second);
    const text = selfAuditText(second);
    assert.match(text, /Capability self-audit - /);
    assert.match(text, /Cannot:/);
    assert.match(text, /send anything externally/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-audit: a legacy self-audit.json imports once and is renamed; a malformed one imports nothing and stays", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".sam"), { recursive: true });
    const legacy = buildSelfAudit(root, {});
    writeFileSync(join(root, ".sam", "self-audit.json"), JSON.stringify(legacy));
    assert.deepEqual(readSelfAudit(root), legacy);
    assert.equal(existsSync(join(root, ".sam", "self-audit.json")), false);
    assert.equal(existsSync(join(root, ".sam", "self-audit.json.migrated")), true);
    const root2 = fresh();
    try {
      mkdirSync(join(root2, ".sam"), { recursive: true });
      writeFileSync(join(root2, ".sam", "self-audit.json"), "{ not json");
      assert.equal(readSelfAudit(root2), null);
      assert.equal(existsSync(join(root2, ".sam", "self-audit.json")), true);
      assert.equal(readFileSync(join(root2, ".sam", "self-audit.json"), "utf8"), "{ not json");
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-audit: a pure read on an empty install creates nothing, not even the state directory", () => {
  const root = fresh();
  try {
    assert.equal(readSelfAudit(root), null);
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
