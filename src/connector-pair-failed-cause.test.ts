import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairConnector, pairFailedSummary, pairFailureReason } from "./connector-pairing.js";
import { connectors } from "./connectors.js";
import { setVaultCredential } from "./vault.js";
import { ChatStore } from "./chats.js";
import { readActivity } from "./activity.js";

// Connector-pair failures carry their cause (gap found
// 2026-11-16, hourly run 20:04 EST): pairConnector's rollback
// line took e.message alone over testConnector's MCP fetch,
// so a pairing dying on transport read the bare "fetch
// failed" wrapper beside a vault-use line for the same test
// that (since 08:04) names the cause. The line's reason now
// composes through errorReason (the 04:04 bridge seam) via
// pairFailureReason / pairFailedSummary: causeless errors
// keep their plain message, a non-Error throw keeps the
// "unknown error" fallback, no bot token leaks, and the line
// still carries the vault credential's NAME only.

const SECRET = "bridge-secret-value-never-printed";

function scratch(): string {
  const base = mkdtempSync(join(tmpdir(), "sam-pair-cause-"));
  const root = join(base, "home");
  setVaultCredential(root, "operator", "bridge-key", SECRET, { purpose: "Desktop Bridge pairing" });
  const db = new ChatStore(root);
  try { db.createAgent("bridge-user", "Profile that will hold the paired connector"); } finally { db.close(); }
  return root;
}

function cleanup(root: string): void {
  rmSync(join(root, ".."), { recursive: true, force: true });
}

const dnsErr = () => new TypeError("fetch failed", {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND bridge.invalid"), { code: "ENOTFOUND" }),
});

test("a pair failure summary names the transport cause behind the wrapper", () => {
  assert.equal(
    pairFailedSummary("Bridge", "127.0.0.1", "bridge-key", dnsErr()),
    "Pairing connector \"Bridge\" at 127.0.0.1 using vault credential bridge-key failed and was rolled back: fetch failed: getaddrinfo ENOTFOUND bridge.invalid",
  );
  assert.equal(pairFailureReason(dnsErr()), "fetch failed: getaddrinfo ENOTFOUND bridge.invalid");
});

test("an errno code riding only on the cause is appended when the message omits it", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read"), { code: "ECONNRESET" }),
  });
  assert.equal(
    pairFailedSummary("Bridge", "127.0.0.1", "bridge-key", err),
    "Pairing connector \"Bridge\" at 127.0.0.1 using vault credential bridge-key failed and was rolled back: fetch failed: read (ECONNRESET)",
  );
});

test("causeless pair errors keep their plain message; a non-Error throw keeps the fallback", () => {
  assert.equal(
    pairFailedSummary("Bridge", "127.0.0.1", "bridge-key", new Error("MCP request failed (HTTP 401)")),
    "Pairing connector \"Bridge\" at 127.0.0.1 using vault credential bridge-key failed and was rolled back: MCP request failed (HTTP 401)",
  );
  assert.equal(pairFailureReason("plain string failure"), "unknown error");
  assert.equal(
    pairFailedSummary("Bridge", "127.0.0.1", "bridge-key", "plain string failure"),
    "Pairing connector \"Bridge\" at 127.0.0.1 using vault credential bridge-key failed and was rolled back: unknown error",
  );
});

test("no bot token leaks through a pair failure summary", () => {
  const url = "https://api.telegram.org/bot987654:AAE-secret_token/getMe";
  const err = new TypeError("fetch failed", { cause: new Error("request to " + url + " failed") });
  const summary = pairFailedSummary("Bridge", "127.0.0.1", "bridge-key", err);
  assert.equal(summary.includes("AAE-secret_token"), false);
  assert.equal(summary.includes("987654"), false);
  assert.match(summary, /bot<redacted>/);
});

test("a pairing dying on transport ledgers exactly one pair-failed line naming the cause, rolls back, rethrows, and never leaks the credential value", async () => {
  const root = scratch();
  try {
    await assert.rejects(
      pairConnector(root, "sam", { name: "Bridge", url: "http://127.0.0.1:8765/mcp", vaultKey: "bridge-key", profile: "sam" }, {
        test: async () => { throw dnsErr(); },
      }),
      /fetch failed/,
    );
    assert.equal(connectors(root).length, 0);
    const lines = readActivity(root, 100).filter(l => l.kind === "connector-pair-failed");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].summary, pairFailedSummary("Bridge", "127.0.0.1", "bridge-key", dnsErr()));
    assert.match(lines[0].summary, /ENOTFOUND/);
    assert.equal(JSON.stringify(lines).includes(SECRET), false);
  } finally { cleanup(root); }
});

test("a pairing dying on a causeless error reads byte-identically in its one ledger line", async () => {
  const root = scratch();
  try {
    await assert.rejects(
      pairConnector(root, "sam", { name: "Bridge", url: "http://127.0.0.1:8765/mcp", vaultKey: "bridge-key", profile: "sam" }, {
        test: async () => { throw new Error("MCP request failed (HTTP 401)"); },
      }),
      /HTTP 401/,
    );
    assert.equal(connectors(root).length, 0);
    const lines = readActivity(root, 100).filter(l => l.kind === "connector-pair-failed");
    assert.equal(lines.length, 1);
    assert.equal(
      lines[0].summary,
      "Pairing connector \"Bridge\" at 127.0.0.1 using vault credential bridge-key failed and was rolled back: MCP request failed (HTTP 401)",
    );
  } finally { cleanup(root); }
});
