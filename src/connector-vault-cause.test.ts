import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { addConnectorVault, allowlistPairHost, mcpCall, testConnector, type Connector } from "./connectors.js";
import { setVaultCredential } from "./vault.js";
import { readActivity } from "./activity.js";

// Connector vault-use failures carry their cause (gap found
// 2026-11-16, hourly run 07:04 EST, recorded as the next
// sibling; built 08:04 EST): the vault-use failure lines in
// mcpCall and testConnector took e.message alone over the MCP
// client's fetch transport, so a failed call against an
// unreachable endpoint ledgered "failed: fetch failed" and
// named nothing - DNS, connect, socket, and TLS failures all
// wore the same wrapper, with the real reason on error.cause.
// The failure outcome now composes through errorReason (the
// 04:04 bridge seam).

const SECRET = "vault-cause-secret-never-printed";

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-vault-cause-"));
  setVaultCredential(root, "operator", "cause-key", SECRET, { purpose: "vault cause test" });
  allowlistPairHost(root, "127.0.0.1");
  return root;
}

function vaultLines(root: string): string[] {
  return readActivity(root, 100).filter(l => l.kind === "vault-use").map(l => l.summary);
}

test("a refused tool call's vault-use line names the transport cause", async () => {
  const root = scratch();
  try {
    const c = addConnectorVault(root, "DeadEnd", "http://127.0.0.1:59998/mcp", "cause-key");
    await assert.rejects(mcpCall(c, "tools/list", {}, undefined, root), /fetch failed/);
    const lines = vaultLines(root);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\(tools\/list\) - failed: fetch failed: connect ECONNREFUSED 127\.0\.0\.1:59998/);
    assert.equal(lines[0].includes(SECRET), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a refused connector test's vault-use line names the transport cause", async () => {
  const root = scratch();
  try {
    const c = addConnectorVault(root, "DeadTest", "http://127.0.0.1:59998/mcp", "cause-key");
    await assert.rejects(testConnector(c, root), /fetch failed/);
    const lines = vaultLines(root);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\(connector test\) - failed: fetch failed: connect ECONNREFUSED/);
    assert.equal(lines[0].includes(SECRET), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a causeless HTTP failure reads exactly as before", async () => {
  const root = scratch();
  const server = createServer((_req, res) => { res.writeHead(401); res.end("no"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const c = addConnectorVault(root, "Refused", "http://127.0.0.1:" + port + "/mcp", "cause-key");
    await assert.rejects(testConnector(c, root), /MCP authorization failed/);
    const lines = vaultLines(root);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\(connector test\) - failed: MCP authorization failed$/);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an env-backed connector writes no vault-use line, cause or not", async () => {
  const root = scratch();
  try {
    const c: Connector = { id: "env-1", name: "EnvOnly", url: "http://127.0.0.1:59998/mcp", tokenEnv: "SAM_MCP_TOKEN_CAUSE_TEST", enabled: true, allowedTools: ["whoami"] };
    process.env.SAM_MCP_TOKEN_CAUSE_TEST = "env-token-value";
    await assert.rejects(mcpCall(c, "tools/list", {}, undefined, root), /fetch failed/);
    assert.equal(vaultLines(root).length, 0);
  } finally {
    delete process.env.SAM_MCP_TOKEN_CAUSE_TEST;
    rmSync(root, { recursive: true, force: true });
  }
});
