import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairConnector, validatePairDetail } from "./connector-pairing.js";
import {
  addConnectorVault, connectorCredentialPresent, connectors, pairAllowlistedHosts,
  testConnector,
} from "./connectors.js";
import { setVaultCredential } from "./vault.js";
import { ChatStore } from "./chats.js";
import { readActivity } from "./activity.js";
import { decideAction, listActions, proposeAction } from "./actions.js";
import { approvalAutoVia, classifyProposal } from "./approval-policy.js";

const SECRET = "bridge-secret-value-never-printed";

function scratch(): string {
  const base = mkdtempSync(join(tmpdir(), "sam-pair-"));
  const root = join(base, "home");
  setVaultCredential(root, "operator", "bridge-key", SECRET, { purpose: "Desktop Bridge pairing" });
  const db = new ChatStore(root);
  try { db.createAgent("bridge-user", "Profile that will hold the paired connector"); } finally { db.close(); }
  return root;
}

function cleanup(root: string): void {
  rmSync(join(root, ".."), { recursive: true, force: true });
}

test("pair validation refuses a card that cannot execute", () => {
  const root = scratch();
  try {
    const good = JSON.stringify({ name: "Bridge", url: "http://127.0.0.1:8765/mcp", vaultKey: "bridge-key", profile: "bridge-user" });
    assert.equal(validatePairDetail(root, good).name, "Bridge");
    assert.throws(() => validatePairDetail(root, JSON.stringify({ name: "Bridge", url: "http://127.0.0.1:8765/mcp", vaultKey: "never-deposited", profile: "bridge-user" })), /No vault credential named/);
    assert.throws(() => validatePairDetail(root, JSON.stringify({ name: "Bridge", url: "http://127.0.0.1:8765/mcp", vaultKey: "bridge-key", profile: "ghost" })), /Unknown profile/);
    assert.throws(() => validatePairDetail(root, JSON.stringify({ name: "Bridge", url: "http://example.com:8765/mcp", vaultKey: "bridge-key", profile: "bridge-user" })), /loopback|HTTPS/);
    assert.throws(() => validatePairDetail(root, JSON.stringify({ name: "Bridge", url: "http://127.0.0.1/mcp", vaultKey: "bridge-key", profile: "bridge-user" })), /explicit port/);
    assert.throws(() => validatePairDetail(root, "not json"), /Invalid pair detail/);
  } finally { cleanup(root); }
});

test("the pair flow registers, allowlists, tests, pins, and ledgers - value nowhere", async () => {
  const root = scratch();
  try {
    const result = await pairConnector(root, "sam", { name: "Bridge", url: "http://127.0.0.1:8765/mcp", vaultKey: "bridge-key", profile: "bridge-user" }, {
      test: async () => ({ tools: ["whoami", "list_leads", "update_lead_stage"], approved: ["whoami", "list_leads"] }),
    });
    assert.equal(result.pinned, true);
    assert.deepEqual(result.approvedTools, ["whoami", "list_leads"]);
    const registered = connectors(root);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].vaultKey, "bridge-key");
    assert.equal(registered[0].tokenEnv, "");
    assert.deepEqual(pairAllowlistedHosts(root), ["127.0.0.1"]);
    const db = new ChatStore(root);
    try { assert.equal(db.agents().find(a => a.name === "bridge-user")?.connector_id, result.connector.id); } finally { db.close(); }
    assert.equal(connectorCredentialPresent(root, registered[0]), true);
    const lines = readActivity(root, 100).map(l => l.kind + " " + l.summary).join("\n");
    assert.match(lines, /connector-paired/);
    assert.match(lines, /bridge-key/);
    assert.equal(lines.includes(SECRET), false);
    assert.equal(JSON.stringify(registered).includes(SECRET), false);
  } finally { cleanup(root); }
});

test("a failed test rolls the registration back and ledgers the failure", async () => {
  const root = scratch();
  try {
    await assert.rejects(
      pairConnector(root, "sam", { name: "Bridge", url: "http://127.0.0.1:8765/mcp", vaultKey: "bridge-key", profile: "sam" }, {
        test: async () => { throw new Error("MCP request failed (HTTP 401)"); },
      }),
      /HTTP 401/,
    );
    assert.equal(connectors(root).length, 0);
    const lines = readActivity(root, 100).map(l => l.kind).join(",");
    assert.match(lines, /connector-pair-failed/);
  } finally { cleanup(root); }
});

test("a vault-bound connector resolves its credential at call time, ledgered by name only", async () => {
  const root = scratch();
  const originalFetch = globalThis.fetch;
  const before = process.env.SAM_MCP_ALLOWED_HOSTS;
  try {
    process.env.SAM_MCP_ALLOWED_HOSTS = "mcp.secondshiftos.com";
    const c = addConnectorVault(root, "Vaulted", "https://mcp.secondshiftos.com/mcp/v1", "bridge-key");
    let seenAuth = "";
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id?: string; method: string };
      seenAuth = (init?.headers as Record<string, string>).Authorization;
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = request.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {} }
        : { tools: [{ name: "whoami" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const check = await testConnector(c, root);
    assert.deepEqual(check.approved, ["whoami"]);
    assert.equal(seenAuth, "Bearer " + SECRET);
    assert.equal(process.env.SAM_VAULT_CREDENTIAL, undefined);
    const lines = readActivity(root, 100).filter(l => l.kind === "vault-use");
    assert.equal(lines.length, 1);
    assert.match(lines[0].summary, /bridge-key/);
    assert.equal(JSON.stringify(lines).includes(SECRET), false);
    // Without a root the same connector fails closed - never an env fallback.
    await assert.rejects(testConnector(c), /missing from vault/);
  } finally {
    globalThis.fetch = originalFetch;
    if (before === undefined) delete process.env.SAM_MCP_ALLOWED_HOSTS; else process.env.SAM_MCP_ALLOWED_HOSTS = before;
    cleanup(root);
  }
});

test("the gate: kind pair is consequential, never auto-approved in any mode, and approval executes the flow", async () => {
  const root = scratch();
  const originalFetch = globalThis.fetch;
  try {
    assert.equal(classifyProposal("pair", null).risk, "consequential");
    assert.equal(approvalAutoVia({ mode: "off", autoKinds: [], updatedAt: null }, "pair", null), null);
    assert.equal(approvalAutoVia({ mode: "smart", autoKinds: ["pair"], updatedAt: null }, "pair", null), null);
    assert.throws(
      () => proposeAction(root, { actor: "sam", kind: "pair", title: "Pair to nothing", detail: JSON.stringify({ name: "Nope", url: "http://127.0.0.1:8765/mcp", vaultKey: "ghost-key", profile: "sam" }) }),
      /No vault credential named/,
    );
    const proposal = proposeAction(root, {
      actor: "sam", kind: "pair", title: "Pair to the Desktop Bridge",
      detail: JSON.stringify({ name: "Bridge", url: "http://127.0.0.1:8765/mcp", vaultKey: "bridge-key", profile: "bridge-user" }),
    });
    assert.equal(proposal.risk, "consequential");
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id?: string; method: string };
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer " + SECRET);
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = request.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {} }
        : { tools: [{ name: "whoami" }, { name: "list_leads" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const decided = await decideAction(root, proposal.id, true);
    assert.equal(decided.status, "done");
    assert.match(decided.result ?? "", /Paired connector Bridge for profile bridge-user/);
    assert.match(decided.result ?? "", /bridge-key/);
    assert.equal((decided.result ?? "").includes(SECRET), false);
    assert.equal(connectors(root).length, 1);
    assert.equal(listActions(root).filter(a => a.status === "pending").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup(root);
  }
});
