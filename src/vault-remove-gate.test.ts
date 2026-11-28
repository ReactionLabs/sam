import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listVaultCredentials, removeVaultCredential, setVaultCredential, vaultCredentialBlocker } from "./vault.js";

// The vault-key gate for the remove door: every other
// person-facing vault door reads the vault registry
// through vaultCredentialBlocker (validatePairSpec and
// addConnectorVault, the pair vault-key gate), but
// `sam vault remove <name>` rode removeVaultCredential
// alone - a folded name ("Bridge_Key", "BRIDGE KEY")
// died on validateVaultName's slug text, naming NONE of
// the credentials the vault holds and offering NO fold
// correction, and an unknown well-slugged name silently
// returned {removed:false}, naming nothing, so at the
// door that DELETES a credential the owner could not
// tell a typo or a fold from a genuinely absent
// credential. The CLI remove door now throws
// vaultCredentialBlocker before anything is removed;
// removeVaultCredential keeps its boolean contract
// (false on a miss) for internal callers - the store
// seam stays permissive by design, like
// getVaultCredentialValue.

const SECRET = "remove-gate-secret-never-printed";

function scratch(): string {
  const base = mkdtempSync(join(tmpdir(), "sam-vault-remove-gate-"));
  const root = join(base, "home");
  setVaultCredential(root, "operator", "bridge-key", SECRET, { purpose: "Desktop Bridge pairing" });
  return root;
}

function cleanup(root: string): void {
  rmSync(join(root, ".."), { recursive: true, force: true });
}

test("vault remove gate: an exact deposited name reads no blocker and removes", () => {
  const root = scratch();
  try {
    assert.equal(vaultCredentialBlocker(root, "bridge-key"), null);
    assert.equal(removeVaultCredential(root, "operator", "bridge-key"), true);
    assert.deepEqual(listVaultCredentials(root), []);
  } finally { cleanup(root); }
});

test("vault remove gate: a folded name is refused with the correction and removes nothing", () => {
  const root = scratch();
  try {
    const out = vaultCredentialBlocker(root, "Bridge_Key")!;
    assert.equal(
      out,
      "No vault credential named \"Bridge_Key\" - the owner deposits credentials into the vault (sam vault set); SAM never creates one. Vault credentials: bridge-key. Did you mean \"bridge-key\"?",
    );
    assert.ok(!out.includes(SECRET), "the refusal must never carry a credential value");
    // The door throws before the store seam runs, so the
    // credential is still deposited afterwards.
    assert.deepEqual(listVaultCredentials(root).map(c => c.name), ["bridge-key"]);
  } finally { cleanup(root); }
});

test("vault remove gate: a space-folded name corrects the same way", () => {
  const root = scratch();
  try {
    const out = vaultCredentialBlocker(root, "BRIDGE KEY")!;
    assert.match(out, /Did you mean "bridge-key"\?$/);
    assert.ok(!out.includes(SECRET));
  } finally { cleanup(root); }
});

test("vault remove gate: an unknown slug names the registry with no correction", () => {
  const root = scratch();
  try {
    const out = vaultCredentialBlocker(root, "ghost-key")!;
    assert.equal(
      out,
      "No vault credential named \"ghost-key\" - the owner deposits credentials into the vault (sam vault set); SAM never creates one. Vault credentials: bridge-key",
    );
    assert.doesNotMatch(out, /Did you mean/);
  } finally { cleanup(root); }
});

test("vault remove gate: an empty vault refuses naming none deposited", () => {
  const base = mkdtempSync(join(tmpdir(), "sam-vault-remove-gate-"));
  const root = join(base, "home");
  try {
    assert.equal(
      vaultCredentialBlocker(root, "bridge-key"),
      "No vault credential named \"bridge-key\" - the owner deposits credentials into the vault (sam vault set); SAM never creates one. Vault credentials: none deposited",
    );
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("vault remove gate: an ambiguous fold offers no correction", () => {
  const root = scratch();
  try {
    setVaultCredential(root, "operator", "bridgekey", SECRET, { purpose: "Second credential folding alike" });
    const out = vaultCredentialBlocker(root, "Bridge_Key")!;
    assert.doesNotMatch(out, /Did you mean/);
    assert.match(out, /Vault credentials: bridge-key, bridgekey/);
  } finally { cleanup(root); }
});

test("vault remove gate: the store seam stays permissive (false on a miss, nothing written)", () => {
  const root = scratch();
  try {
    assert.equal(removeVaultCredential(root, "operator", "ghost-key"), false);
    assert.deepEqual(listVaultCredentials(root).map(c => c.name), ["bridge-key"]);
  } finally { cleanup(root); }
});
