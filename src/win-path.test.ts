import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandCandidates, commandFileNames, probeDelimiter, windowsCmdShim } from "./bin-path.js";
import { engineBinary } from "./engine.js";
import { sensesBinary } from "./senses.js";

// Windows path resolution, simulated. The host stays Linux; platform
// and delimiter are injected so a drive-letter PATH is not split on
// ":" and .exe/.cmd are the names the lookup tries.

const WIN: { platform: NodeJS.Platform; delimiter: string } = { platform: "win32", delimiter: ";" };
const POSIX: { platform: NodeJS.Platform; delimiter: string } = { platform: "linux", delimiter: ":" };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sam-win-path-"));
}
function touch(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, "");
  return file;
}

test("probe delimiter follows path.delimiter on the host and the injected platform otherwise", () => {
  assert.equal(probeDelimiter(), process.platform === "win32" ? ";" : ":");
  assert.equal(probeDelimiter(WIN), ";");
  assert.equal(probeDelimiter(POSIX), ":");
  assert.equal(probeDelimiter({ platform: "win32", delimiter: ":" }), ":");
});

test("win32 command names try .exe, then .cmd, then the bare name", () => {
  assert.deepEqual(commandFileNames("claude", "win32"), ["claude.exe", "claude.cmd", "claude"]);
  assert.deepEqual(commandFileNames("gog", "win32"), ["gog.exe", "gog.cmd", "gog"]);
  assert.deepEqual(commandFileNames("claude.exe", "win32"), ["claude.exe"]);
  assert.deepEqual(commandFileNames("claude", "linux"), ["claude"]);
});

test("a Windows drive path stays one PATH entry and the real directory is still searched", () => {
  const root = scratch();
  try {
    const bin = join(root, "bin");
    const exe = touch(bin, "claude.exe");
    touch(bin, "claude.cmd");
    const path = "C:\\Program Files\\Claude;" + bin;
    assert.deepEqual(commandCandidates(path, ";", "claude", "win32").slice(0, 3), [
      join("C:\\Program Files\\Claude", "claude.exe"),
      join("C:\\Program Files\\Claude", "claude.cmd"),
      join("C:\\Program Files\\Claude", "claude"),
    ]);
    assert.equal(engineBinary({ PATH: path }, WIN), exe);
    assert.equal(engineBinary({ PATH: path }, POSIX), null, "splitting that same string on colon glues the real directory to the drive fragment");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("win32 PATH resolution prefers .exe over .cmd over the bare name, and .cmd is enough", () => {
  const root = scratch();
  try {
    const both = join(root, "both");
    const exe = touch(both, "claude.exe");
    touch(both, "claude.cmd");
    touch(both, "claude");
    assert.equal(engineBinary({ PATH: both }, WIN), exe);
    const cmdOnly = join(root, "cmd");
    const cmd = touch(cmdOnly, "claude.cmd");
    assert.equal(engineBinary({ PATH: "C:\\Missing;" + cmdOnly }, WIN), cmd);
    const bare = join(root, "bare");
    const plain = touch(bare, "claude");
    assert.equal(engineBinary({ PATH: bare }, WIN), plain);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SAM_ENGINE_BIN on win32 resolves a sibling .exe or .cmd when the exact path is absent", () => {
  const root = scratch();
  try {
    const exe = touch(root, "claude.exe");
    assert.equal(engineBinary({ SAM_ENGINE_BIN: join(root, "claude"), PATH: "" }, WIN), exe);
    rmSync(exe);
    const cmd = touch(root, "claude.cmd");
    assert.equal(engineBinary({ SAM_ENGINE_BIN: join(root, "claude"), PATH: "" }, WIN), cmd);
    const elsewhere = join(root, "elsewhere");
    touch(elsewhere, "claude.exe");
    assert.equal(engineBinary({ SAM_ENGINE_BIN: join(root, "missing"), PATH: elsewhere }, WIN), null, "a named path that is not a file does not fall through to PATH");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("linux lookup still splits on colon and wants the bare name", () => {
  const root = scratch();
  try {
    const bin = join(root, "bin");
    const claude = touch(bin, "claude");
    touch(bin, "claude.exe");
    const path = "/usr/bin:" + bin;
    assert.equal(engineBinary({ PATH: path }, POSIX), claude);
    assert.equal(engineBinary({ PATH: "/nonexistent-dir" }, POSIX), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("senses reader uses the same win32 PATH rules for gog", () => {
  const root = scratch();
  try {
    const bin = join(root, "bin");
    const gog = touch(bin, "gog.exe");
    const path = "C:\\Program Files\\Gog;" + bin;
    assert.equal(sensesBinary({ PATH: path }, WIN), gog);
    const named = touch(root, "gog.cmd");
    assert.equal(sensesBinary({ SAM_GOG_BIN: join(root, "gog"), PATH: path }, WIN), named);
    assert.equal(sensesBinary({ PATH: path }, POSIX), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the windows cmd shim quotes node and the script and forwards argv", () => {
  const text = windowsCmdShim("C:\\Program Files\\nodejs\\node.exe", "C:\\sam\\claude-fake.mjs");
  assert.equal(text, "@echo off\r\n\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\sam\\claude-fake.mjs\" %*\r\n");
});

test("engine probe lstatSync lines stay byte-identical", () => {
  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const src = readFileSync(join(repoRoot, "src", "engine.ts"), "utf8");
  const probes = src.split("\n").filter(line => line.includes("lstatSync("));
  assert.deepEqual(probes, [
    "    try { return lstatSync(named).isFile() ? named : null; } catch { return null; }",
    "    try { if (lstatSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }",
  ]);
});
