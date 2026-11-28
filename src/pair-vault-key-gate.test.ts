import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeVaultCredentialName, setVaultCredential, vaultCredentialBlocker } from "./vault.js";
import { validatePairDetail } from "./connector-pairing.js";
import { addConnectorVault, connectors } from "./connectors.js";
import { ChatStore } from "./chats.js";

// The vault-key gate for the pair door: a connector
// pairing is picked by the NAME of a vault credential -
// validatePairSpec (the ONE gate's proposal validation,
// its executor, and the operator CLI `sam pair`) and
// addConnectorVault (the registration seam pairConnector
// rides) each improvised the same "No vault credential
// named" refusal in two places, echoing the value but
// naming NONE of the credentials the vault holds and
// offering NO fold correction, so a folded name
// ("Bridge_Key", "BRIDGE KEY") dead-ended after the owner
// had deposited the credential under its canonical slug.
// vaultCredentialBlocker in vault.ts is now the ONE
// source both seams throw; it names the deposited
// credential NAMES as the registry (names only - the
// same names `sam vault list` prints, never a value) and
// corrects the fold when exactly one deposited name
// matches folded for case and separators.

const SECRET = "gate-secret-value-never-printed";

function scratch(): string {
  const base = mkdtempSync(join(tmpdir(), "sam-pair-vault-key-gate-"));
  const root = join(base, "home");
  setVaultCredential(root, "operator", "bridge-key", SECRET, { purpose: "Desktop Bridge pairing" });
  const db = new ChatStore(root);
  try { db.createAgent("bridge-user", "Profile that will hold the paired connector"); } finally { db.close(); }
  return root;
}

function cleanup(root: string): void {
  rmSync(join(root, ".."), { recursive: true, force: true });
}

test("pair vault-key gate: the fold strips case and separators", () => {
  assert.equal(normalizeVaultCredentialName("Bridge_Key"), "bridgekey");
  assert.equal(normalizeVaultCredentialName("BRIDGE KEY"), "bridgekey");
  assert.equal(normalizeVaultCredentialName("bridge-key"), "bridgekey");
  assert.equal(normalizeVaultCredentialName("bridgekey"), "bridgekey");
});

test("pair vault-key gate: an exact deposited name reads no blocker", () => {
  const root = scratch();
  try {
    assert.equal(vaultCredentialBlocker(root, "bridge-key"), null);
  } finally { cleanup(root); }
});

test("pair vault-key gate: an unknown name names the registry, no correction, no value", () => {
  const root = scratch();
  try {
    const out = vaultCredentialBlocker(root, "never-deposited")!;
    assert.equal(
      out,
      "No vault credential named \"never-deposited\" - the owner deposits credentials into the vault (sam vault set); SAM never creates one. Vault credentials: bridge-key",
    );
    assert.doesNotMatch(out, /Did you mean/);
    assert.ok(!out.includes(SECRET), "the refusal must never carry a credential value");
  } finally { cleanup(root); }
});

test("pair vault-key gate: an empty vault refuses naming none deposited", () => {
  const base = mkdtempSync(join(tmpdir(), "sam-pair-vault-key-gate-"));
  const root = join(base, "home");
  try {
    assert.equal(
      vaultCredentialBlocker(root, "bridge-key"),
      "No vault credential named \"bridge-key\" - the owner deposits credentials into the vault (sam vault set); SAM never creates one. Vault credentials: none deposited",
    );
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("pair vault-key gate: a folded name is refused with the correction", () => {
  const root = scratch();
  try {
    assert.match(vaultCredentialBlocker(root, "Bridge_Key")!, /Did you mean "bridge-key"\?$/);
    assert.match(vaultCredentialBlocker(root, "BRIDGE KEY")!, /Did you mean "bridge-key"\?$/);
    assert.match(vaultCredentialBlocker(root, "bridgekey")!, /Did you mean "bridge-key"\?$/);
  } finally { cleanup(root); }
});

test("pair vault-key gate: an ambiguous fold offers no correction", () => {
  const root = scratch();
  try {
    setVaultCredential(root, "operator", "a-b", SECRET, {});
    setVaultCredential(root, "operator", "ab", SECRET, {});
    const out = vaultCredentialBlocker(root, "A B")!;
    assert.match(out, /Vault credentials: bridge-key, a-b, ab$/);
    assert.doesNotMatch(out, /Did you mean/);
  } finally { cleanup(root); }
});

test("pair vault-key gate: validatePairDetail throws the ONE source's words and registers nothing", () => {
  const root = scratch();
  try {
    const detail = JSON.stringify({ name: "Bridge", url: "http://127.0.0.1:8765/mcp", vaultKey: "Bridge_Key", profile: "bridge-user" });
    assert.throws(
      () => validatePairDetail(root, detail),
      (e: unknown) => e instanceof Error && e.message === vaultCredentialBlocker(root, "Bridge_Key"),
    );
    assert.equal(connectors(root).length, 0);
    const clean = validatePairDetail(root, JSON.stringify({ name: "Bridge", url: "http://127.0.0.1:8765/mcp", vaultKey: "bridge-key", profile: "bridge-user" }));
    assert.equal(clean.vaultKey, "bridge-key");
  } finally { cleanup(root); }
});

test("pair vault-key gate: addConnectorVault throws the ONE source's words and registers nothing", () => {
  const root = scratch();
  try {
    assert.throws(
      () => addConnectorVault(root, "Vaulted", "https://mcp.secondshiftos.com/mcp/v1", "BRIDGE KEY"),
      (e: unknown) => e instanceof Error && e.message === vaultCredentialBlocker(root, "BRIDGE KEY"),
    );
    assert.equal(connectors(root).length, 0);
    const c = addConnectorVault(root, "Vaulted", "https://mcp.secondshiftos.com/mcp/v1", "bridge-key");
    assert.equal(c.vaultKey, "bridge-key");
  } finally { cleanup(root); }
});
