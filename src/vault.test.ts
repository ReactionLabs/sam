import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readActivity } from "./activity.js";
import { cloneCredentialEnv, cloneIntoCodeRoot, setCodeRoot, type CodeRunner } from "./code.js";
import {
  getVaultCredentialValue, listVaultCredentials, removeVaultCredential, setVaultCredential,
  vaultAskpassPath, vaultCredentialForUrl, vaultDir, vaultStatus, VAULT_CREDENTIAL_ENV,
} from "./vault.js";

// The SAM VAULT (Dip ruling 2026-11-12): owner-only custody
// outside the SAM home, name-only references, executor injection
// for git-clone, and a ledger that carries name + purpose +
// outcome and never a value. These tests pin the custody shape:
// no surface (views, status, ledger, askpass script, clone
// result) ever carries the secret; only the executor door and
// the injected child env do.

const SECRET = "ghp_test_value_never_printed_1234567890";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-vault-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  return { base, sam };
}

function ledgerText(root: string): string {
  const file = join(root, ".sam", "activity.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

test("vault: a pure read on an install with no vault creates nothing", () => {
  const { base, sam } = fixture();
  try {
    assert.deepEqual(listVaultCredentials(sam), []);
    const status = vaultStatus(sam);
    assert.equal(status.exists, false);
    assert.deepEqual(status.credentials, []);
    assert.equal(getVaultCredentialValue(sam, "github"), null);
    assert.equal(vaultCredentialForUrl(sam, "https://github.com/ReactionLabs/sam"), null);
    assert.equal(existsSync(join(base, ".sam-vault")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("vault: deposit roundtrip - metadata everywhere, the value only through the executor door", () => {
  const { base, sam } = fixture();
  try {
    const view = setVaultCredential(sam, "operator", "github", SECRET, { purpose: "read-scoped clones", hosts: ["GitHub.com"] });
    assert.equal(view.name, "github");
    assert.deepEqual(view.hosts, ["github.com"]);
    assert.equal(view.purpose, "read-scoped clones");
    assert.equal("value" in view, false);

    assert.deepEqual(listVaultCredentials(sam).map(v => v.name), ["github"]);
    assert.equal(getVaultCredentialValue(sam, "github"), SECRET);
    assert.equal(getVaultCredentialValue(sam, "nope"), null);

    // No surface carries the value: views, status, the ledger.
    assert.equal(JSON.stringify(listVaultCredentials(sam)).includes(SECRET), false);
    assert.equal(JSON.stringify(vaultStatus(sam)).includes(SECRET), false);
    const ledger = ledgerText(sam);
    assert.match(ledger, /vault-set/);
    assert.match(ledger, /github/);
    assert.equal(ledger.includes(SECRET), false);

    // Custody permissions (POSIX only; Windows mode bits are not
    // the contract, per the windows-pass-2 precedent).
    if (process.platform !== "win32") {
      assert.equal(statSync(join(base, ".sam-vault")).mode & 0o777, 0o700);
      assert.equal(statSync(join(base, ".sam-vault", "vault.db")).mode & 0o777, 0o600);
    }

    // Replace keeps the creation stamp and swaps the value.
    const again = setVaultCredential(sam, "operator", "github", SECRET + "2", { purpose: "rotated", hosts: ["github.com"] });
    assert.equal(again.createdAt, view.createdAt);
    assert.equal(getVaultCredentialValue(sam, "github"), SECRET + "2");
    assert.match(ledgerText(sam), /replaced/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("vault: validation refuses bad names, bad values, and bad hosts before any store exists", () => {
  const { base, sam } = fixture();
  try {
    assert.throws(() => setVaultCredential(sam, "operator", "Git Hub", SECRET), /lowercase slug/);
    assert.throws(() => setVaultCredential(sam, "operator", "-github", SECRET), /lowercase slug/);
    assert.throws(() => setVaultCredential(sam, "operator", "github", ""), /must not be empty/);
    assert.throws(() => setVaultCredential(sam, "operator", "github", "two\nlines"), /single line/);
    assert.throws(() => setVaultCredential(sam, "operator", "github", SECRET, { hosts: ["https://github.com"] }), /bare hostnames/);
    assert.throws(() => setVaultCredential(sam, "operator", "github", SECRET, { hosts: ["github.com:443"] }), /bare hostnames/);
    assert.throws(() => setVaultCredential(sam, "operator", "github", SECRET, { hosts: ["github"] }), /bare hostnames/);
    assert.equal(existsSync(join(base, ".sam-vault")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("vault: removal is ledgered and final; a missing name removes nothing", () => {
  const { base, sam } = fixture();
  try {
    assert.equal(removeVaultCredential(sam, "operator", "github"), false);
    setVaultCredential(sam, "operator", "github", SECRET, { hosts: ["github.com"] });
    assert.equal(removeVaultCredential(sam, "operator", "github"), true);
    assert.equal(getVaultCredentialValue(sam, "github"), null);
    assert.equal(removeVaultCredential(sam, "operator", "github"), false);
    const lines = readActivity(sam, 20).filter(l => l.kind === "vault-remove");
    assert.equal(lines.length, 1);
    assert.equal(ledgerText(sam).includes(SECRET), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("vault: host resolution is https-only, host-exact, and hostless credentials never auto-inject", () => {
  const { base, sam } = fixture();
  try {
    setVaultCredential(sam, "operator", "github", SECRET, { hosts: ["github.com"] });
    setVaultCredential(sam, "operator", "standby", SECRET + "x", {});
    const hit = vaultCredentialForUrl(sam, "https://github.com/ReactionLabs/agent-bridge");
    assert.equal(hit?.name, "github");
    assert.equal(hit?.value, SECRET);
    assert.equal(vaultCredentialForUrl(sam, "https://api.github.com/x"), null);
    assert.equal(vaultCredentialForUrl(sam, "https://example.com/x"), null);
    assert.equal(vaultCredentialForUrl(sam, "ssh://git@github.com/x"), null);
    assert.equal(vaultCredentialForUrl(sam, "file:///tmp/x"), null);
    assert.equal(vaultCredentialForUrl(sam, "not a url"), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("vault: SAM_VAULT_DIR overrides the location and must be absolute", () => {
  const { base, sam } = fixture();
  try {
    const custom = join(base, "elsewhere");
    assert.equal(vaultDir(sam, { SAM_VAULT_DIR: custom } as NodeJS.ProcessEnv), custom);
    assert.throws(() => vaultDir(sam, { SAM_VAULT_DIR: "relative/dir" } as NodeJS.ProcessEnv), /absolute path/);
    assert.equal(vaultDir(sam, {} as NodeJS.ProcessEnv), join(dirname(sam), ".sam-vault"));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("vault: clone env injection - the value rides the child env only, the askpass script holds no secret", () => {
  const { base, sam } = fixture();
  try {
    // No credential: the env is the plain clone env.
    const plain = cloneCredentialEnv(sam, "https://github.com/ReactionLabs/sam");
    assert.equal(plain.credentialName, null);
    assert.equal(plain.env.GIT_ASKPASS, undefined);
    assert.equal(plain.env[VAULT_CREDENTIAL_ENV], undefined);

    setVaultCredential(sam, "operator", "github", SECRET, { hosts: ["github.com"] });
    const injected = cloneCredentialEnv(sam, "https://github.com/ReactionLabs/agent-bridge");
    assert.equal(injected.credentialName, "github");
    assert.equal(injected.env[VAULT_CREDENTIAL_ENV], SECRET);
    assert.equal(injected.env.GIT_ASKPASS, vaultAskpassPath(sam));
    const script = readFileSync(injected.env.GIT_ASKPASS as string, "utf8");
    assert.match(script, /x-access-token/);
    assert.equal(script.includes(SECRET), false);
    if (process.platform !== "win32") {
      assert.equal(statSync(injected.env.GIT_ASKPASS as string).mode & 0o777, 0o700);
    }
    // A different host gets nothing.
    const other = cloneCredentialEnv(sam, "https://example.com/repo.git");
    assert.equal(other.credentialName, null);
    assert.equal(other.env[VAULT_CREDENTIAL_ENV], undefined);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("vault: a clone through the executor names its credential and ledgers the use - never the value", async () => {
  const { base, sam } = fixture();
  const proj = join(base, "proj");
  try {
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: {} }));
    setCodeRoot(sam, proj);
    setVaultCredential(sam, "operator", "github", SECRET, { purpose: "private clones", hosts: ["github.com"] });

    const runner: CodeRunner = async () => ({ exitCode: 0, output: "cloned" });
    const result = await cloneIntoCodeRoot(sam, "sam", "https://github.com/ReactionLabs/agent-bridge", "agent-bridge", { runner });
    assert.equal(result.ok, true);
    assert.equal(result.vaultCredential, "github");
    assert.equal(JSON.stringify(result).includes(SECRET), false);

    const uses = readActivity(sam, 30).filter(l => l.kind === "vault-use");
    assert.equal(uses.length, 1);
    assert.match(uses[0].summary, /github/);
    assert.match(uses[0].summary, /github\.com/);
    assert.match(uses[0].summary, /ok/);
    assert.equal(ledgerText(sam).includes(SECRET), false);

    // A public clone of an uncovered host uses nothing.
    const plain = await cloneIntoCodeRoot(sam, "sam", "https://example.com/repo.git", "lib", { runner });
    assert.equal(plain.vaultCredential, undefined);
    assert.equal(readActivity(sam, 30).filter(l => l.kind === "vault-use").length, 1);

    // A failed clone still ledgers the use, with its outcome.
    const failing: CodeRunner = async () => ({ exitCode: 128, output: "fatal: could not read" });
    const failed = await cloneIntoCodeRoot(sam, "sam", "https://github.com/ReactionLabs/agent-bridge", "again", { runner: failing });
    assert.equal(failed.ok, false);
    const uses2 = readActivity(sam, 30).filter(l => l.kind === "vault-use");
    assert.equal(uses2.length, 2);
    assert.match(uses2[1].summary, /exit 128/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
