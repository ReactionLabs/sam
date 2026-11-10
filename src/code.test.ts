import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCodeRoot, codeCommandNames, codeCommandSpec, codeRoot, codeSummary, codeWrites, editCodeFile, listCodeFiles, readCodeFile, runCodeCommand, setCodeRoot, writeCodeFile, type CodeRunner } from "./code.js";
import { verificationStatus } from "./verification.js";
import { readActivity } from "./activity.js";
import { executeOwnToolAsync } from "./own-tools.js";
import { ChatStore } from "./chats.js";

// Phase D item 2 (coder C1 + C2): write/edit hands confined to a
// designated code root, verify hands as a fixed allowlist. Fixtures:
// a SAM home and a SEPARATE project tree, both scratch.

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-code-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proj", scripts: { build: "tsc -p .", test: "node --test" } }));
  return { base, sam, proj };
}

test("code root designation: operator-set, never the SAM home / inside it / containing it", () => {
  const { base, sam, proj } = fixture();
  try {
    assert.equal(codeRoot(sam), null);
    assert.throws(() => listCodeFiles(sam), /No code root is designated/);
    assert.throws(() => setCodeRoot(sam, sam), /cannot be the SAM home itself/);
    mkdirSync(join(sam, "inner"), { recursive: true });
    assert.throws(() => setCodeRoot(sam, join(sam, "inner")), /inside the SAM home/);
    assert.throws(() => setCodeRoot(sam, base), /cannot contain the SAM home/);
    assert.throws(() => setCodeRoot(sam, join(base, "missing")), /does not exist/);
    assert.equal(setCodeRoot(sam, proj), proj);
    assert.equal(codeRoot(sam), proj);
    assert.equal(codeSummary(sam).root, proj);
    clearCodeRoot(sam);
    assert.equal(codeRoot(sam), null);
    assert.throws(() => writeCodeFile(sam, "sam", "a.txt", "x"), /No code root is designated/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("C1 write/edit: created + ledgered with a readable diff, unverified until C2 passes", async () => {
  const { base, sam, proj } = fixture();
  try {
    setCodeRoot(sam, proj);
    const w = writeCodeFile(sam, "sam", "src/app.ts", "export const a = 1;\n");
    assert.equal(w.created, true);
    assert.equal(w.addedLines, 1);
    assert.match(w.diff, /\+export const a = 1;/);
    assert.equal(w.verification, "pending");
    assert.equal(readFileSync(join(proj, "src", "app.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(verificationStatus(sam).state, "unverified");

    const e = editCodeFile(sam, "sam", "src/app.ts", "a = 1", "a = 2");
    assert.equal(e.created, false);
    assert.match(e.diff, /-export const a = 1;/);
    assert.match(e.diff, /\+export const a = 2;/);
    const writes = codeWrites(sam);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].path, "src/app.ts");
    assert.ok(readActivity(sam, 10).some(l => l.kind === "code-write"));

    // No-op writes and ambiguous/missing edits refuse.
    assert.throws(() => writeCodeFile(sam, "sam", "src/app.ts", "export const a = 2;\n"), /No change/);
    assert.throws(() => editCodeFile(sam, "sam", "src/app.ts", "nope", "x"), /not found/);
    writeCodeFile(sam, "sam", "dup.txt", "same same\n");
    assert.throws(() => editCodeFile(sam, "sam", "dup.txt", "same", "other"), /more than once/);

    // C2 verdicts settle the same ledger: build + test pass => verified.
    const okRunner: CodeRunner = async () => ({ exitCode: 0, output: "fine" });
    await runCodeCommand(sam, "sam", "build", { runner: okRunner });
    assert.equal(verificationStatus(sam).state, "unverified"); // build alone is not enough
    await runCodeCommand(sam, "sam", "test", { runner: okRunner });
    assert.equal(verificationStatus(sam).state, "verified");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("C1 fences: escapes, protected names, secrets, dot-paths, symlinks, binaries, oversize", () => {
    const { base, sam, proj } = fixture();
  try {
    setCodeRoot(sam, proj);
    for (const bad of ["../escape.txt", "/abs.txt", ".env", "src/.env.local", ".git/config", "node_modules/x.js", "my-secret-notes.txt", "id_ed25519", "cert.pem", ".hidden/file.txt", "data.db"]) {
      assert.throws(() => writeCodeFile(sam, "sam", bad, "x"), /Protected|Invalid/, bad);
    }
    assert.throws(() => writeCodeFile(sam, "sam", "bin.dat", "a\0b"), /must be text/);
    assert.throws(() => writeCodeFile(sam, "sam", "big.txt", "x".repeat(32_001)), /exceeds 32000/);
    // A symlinked directory inside the root is not a door out of it.
    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    let linked = true;
    try { symlinkSync(outside, join(proj, "link"), "junction"); }
    catch { try { symlinkSync(outside, join(proj, "link")); } catch { linked = false; } }
    if (linked) {
      assert.throws(() => writeCodeFile(sam, "sam", "link/evil.txt", "x"), /Symlink/);
      assert.equal(existsSync(join(outside, "evil.txt")), false);
    }
    // Reads ride the same fence.
    writeCodeFile(sam, "sam", "ok.txt", "hello\n");
    assert.equal(readCodeFile(sam, "ok.txt").content, "hello\n");
    assert.deepEqual(listCodeFiles(sam).entries.map(e => e.name).sort(), linked ? ["link", "ok.txt", "package.json"] : ["ok.txt", "package.json"]);
    assert.throws(() => readCodeFile(sam, "../home/.sam/code.json"), /Invalid|Protected/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("C2 allowlist: only fixed names build argv; scripts resolve from the root's package.json", () => {
  const { base, sam, proj } = fixture();
  try {
    setCodeRoot(sam, proj);
    assert.deepEqual(codeCommandSpec(sam, "build"), { file: "npm", args: ["run", "build"], cwd: proj, description: "The code root's own npm build script: tsc -p ." });
    assert.deepEqual(codeCommandSpec(sam, "git-log").args, ["log", "--oneline", "-20"]);
    assert.deepEqual(codeCommandSpec(sam, "agent-reach-channels"), { file: "agent-reach", args: ["channels"], cwd: proj, description: codeCommandSpec(sam, "agent-reach-channels").description });
    // No lint script in the fixture: refuses, naming what exists.
    assert.throws(() => codeCommandSpec(sam, "lint"), /no "lint" script \(it has: build, test\)/);
    // Anything not on the list refuses - there is no command line to give.
    for (const bad of ["ls", "npm test", "build; rm -rf /", "git-push", "agent-reach"]) {
      assert.throws(() => codeCommandSpec(sam, bad), /Allowlisted commands/, bad);
    }
    assert.ok(codeCommandNames().includes("agent-reach-doctor"));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("C2 runs: capped output, failure is data, agent-reach absence reports not-installed", async () => {
  const { base, sam, proj } = fixture();
  try {
    setCodeRoot(sam, proj);
    const big: CodeRunner = async () => ({ exitCode: 0, output: "y".repeat(20_000) });
    const capped = await runCodeCommand(sam, "sam", "git-status", { runner: big });
    assert.equal(capped.ok, true);
    assert.equal(capped.output.length, 8_000);
    assert.equal(capped.truncated, true);

    const fail: CodeRunner = async () => ({ exitCode: 2, output: "boom" });
    const failed = await runCodeCommand(sam, "sam", "build", { runner: fail });
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 2);
    // A failed build verdict records as failed, never verified.
    assert.equal(verificationStatus(sam).state, "clean"); // no changes yet: verdict alone
    assert.ok(readActivity(sam, 10).some(l => l.kind === "code-run" && /exit 2/.test(l.summary)));

    // The box state today: the agent-reach binary is absent. ENOENT
    // (exitCode null, no output) reads as a named not-installed error.
    const enoent: CodeRunner = async () => ({ exitCode: null, output: "" });
    const missing = await runCodeCommand(sam, "sam", "agent-reach-channels", { runner: enoent });
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? "", /agent-reach is not installed on this machine/);

    const timed: CodeRunner = async () => ({ exitCode: null, output: "partial", timedOut: true });
    const t = await runCodeCommand(sam, "sam", "test", { runner: timed });
    assert.equal(t.ok, false);
    assert.equal(t.timedOut, true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("C2 real runner: git status runs in a real repo root (no shell, fixed argv)", async () => {
  const { base, sam, proj } = fixture();
  try {
    setCodeRoot(sam, proj);
    writeCodeFile(sam, "sam", "tracked.txt", "one\n");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["-C", proj, "init", "-q"]);
    execFileSync("git", ["-C", proj, "add", "tracked.txt"]);
    const r = await runCodeCommand(sam, "sam", "git-status");
    assert.equal(r.ok, true);
    assert.match(r.output, /tracked\.txt/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("sam_code own tool: writes + runs through the chat seam; visitors refused", async () => {
  const { base, sam, proj } = fixture();
  try {
    setCodeRoot(sam, proj);
    const status = await executeOwnToolAsync(sam, "sam", "sam_code", { action: "status" }) as { codeRoot: string | null; commands: string[] };
    assert.equal(status.codeRoot, proj);
    assert.ok(status.commands.includes("build"));
    const w = await executeOwnToolAsync(sam, "sam", "sam_code", { action: "write", path: "note.ts", content: "export {};\n" }) as { path: string; verification: string };
    assert.equal(w.path, "note.ts");
    assert.equal(w.verification, "pending");
    const refused = await executeOwnToolAsync(sam, "sam", "sam_code", { action: "write", path: ".env", content: "X=1" }) as { error: string };
    assert.match(refused.error, /Protected/);
    const badRun = await executeOwnToolAsync(sam, "sam", "sam_code", { action: "run", command: "rm -rf /" }) as { error: string };
    assert.match(badRun.error, /Allowlisted commands/);

    // A visitor chat never touches the hands.
    const store = new ChatStore(sam);
    try {
      const chat = store.create("Web chat", "sam", { visitor: true });
      const v = await executeOwnToolAsync(sam, "sam", "sam_code", { action: "list" }, undefined, chat.id) as { error: string };
      assert.match(v.error, /Visitors cannot use coder hands/);
    } finally { store.close(); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
