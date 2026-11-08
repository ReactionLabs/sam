import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Config + MCP policy CLI wiring: configuration is readable through
 * the CLI without ever printing a secret value, and the MCP policy
 * command is a local dry-run that denies by default.
 */
test("config show reports readiness and never leaks secret values", () => {
  const workspace = mkdtempSync(join(tmpdir(), "sam-config-cli-"));
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const env = {
    ...process.env,
    SAM_MODEL_PROVIDER: "minimax",
    SAM_MODEL: "MiniMax-M2",
    MINIMAX_API_KEY: "test-secret-do-not-print",
    SECOND_SHIFT_MCP_URL: "https://mcp.secondshift.site",
    SECOND_SHIFT_MCP_TOKEN: "test-token-do-not-print",
  };
  try {
    const result = spawnSync(process.execPath, [cli, "--workspace", workspace, "--json", "config", "show"], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes("test-secret-do-not-print"), "API key must never be printed");
    assert.ok(!result.stdout.includes("test-token-do-not-print"), "MCP token must never be printed");
    const shown = JSON.parse(result.stdout);
    assert.equal(shown.modelReady, true);
    assert.equal(shown.mcpReady, true);
    assert.equal(shown.minimaxApiKey, "present");
    assert.equal(shown.secondShiftMcpToken, "present");

    const bare = spawnSync(process.execPath, [cli, "--workspace", workspace, "--json", "config", "show"], {
      encoding: "utf8",
      env: { ...process.env, SAM_MODEL_PROVIDER: "", MINIMAX_API_KEY: "", SECOND_SHIFT_MCP_URL: "", SECOND_SHIFT_MCP_TOKEN: "" },
    });
    assert.equal(bare.status, 0, bare.stderr);
    const bareShown = JSON.parse(bare.stdout);
    assert.equal(bareShown.modelReady, false);
    assert.equal(bareShown.mcpReady, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("mcp authorize is a local dry-run that denies by default", () => {
  const workspace = mkdtempSync(join(tmpdir(), "sam-mcp-cli-"));
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, "--workspace", workspace, "--json", ...args], { encoding: "utf8" });
  try {
    // No trust flag: denied even for an allowlisted, advertised tool.
    const untrusted = run("mcp", "authorize", "secondshift.leads.list", "--advertised", "secondshift.leads.list", "--allow", "secondshift.leads.list");
    assert.notEqual(untrusted.status, 0);
    assert.deepEqual(JSON.parse(untrusted.stdout), { allowed: false, reason: "untrusted-server" });

    // Trusted but not allowlisted: denied.
    const notAllowed = run("mcp", "authorize", "secondshift.leads.delete", "--advertised", "secondshift.leads.delete", "--trust-server");
    assert.notEqual(notAllowed.status, 0);
    assert.deepEqual(JSON.parse(notAllowed.stdout), { allowed: false, reason: "not-allowlisted" });

    // Wildcards never match.
    const wildcard = run("mcp", "authorize", "secondshift.*", "--advertised", "secondshift.leads.list", "--allow", "secondshift.*", "--trust-server");
    assert.notEqual(wildcard.status, 0);

    // Exact match + advertised + allowlisted + trusted: allowed.
    const allowed = run("mcp", "authorize", "secondshift.leads.list", "--advertised", "secondshift.leads.list,secondshift.leads.delete", "--allow", "secondshift.leads.list", "--trust-server");
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.deepEqual(JSON.parse(allowed.stdout), { allowed: true, tool: "secondshift.leads.list" });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
