import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeCommandBlocker, codeCommandNames, codeCommandSpec, setCodeRoot } from "./code.js";

// The code-command gate: the command name is a registry
// name (the codeCommandNames allowlist in code.ts: build,
// test, lint, git-status, git-diff, git-log,
// git-latest-files, git-clone, agent-reach-channels,
// agent-reach-doctor) that a person types at the CLI
// `code spec` / `code run` doors and the model names in
// the sam_code run action. The ONE seam every name rides,
// codeCommandSpec, refused an unknown name with a text
// that named the allowlist but offered no fold
// correction - and only after requireCodeRoot, so a
// folded name on an install with no code root met the
// code-root refusal instead. codeCommandBlocker in
// code.ts is now the ONE source carrying the refusal
// text, thrown before any root is required. The
// package-script refusal (a real command whose script
// the root's package.json lacks) is unchanged: it
// already names what the root has.

test("code command gate: every exact allowlisted command reads no blocker", () => {
  for (const name of codeCommandNames()) assert.equal(codeCommandBlocker(name), null, name);
  assert.equal(codeCommandNames().length, 10);
});

test("code command gate: an unknown command names the allowlist and keeps the safety sentence, no correction", () => {
  assert.equal(
    codeCommandBlocker("deploy"),
    "Unknown code command 'deploy'. Allowlisted commands: build, test, lint, git-status, git-diff, git-log, git-latest-files, git-clone, agent-reach-channels, agent-reach-doctor. There is no way to run anything else - no arbitrary commands, flags, or shell.",
  );
});

test("code command gate: a folded name is refused with the correction", () => {
  assert.match(codeCommandBlocker("Git Status")!, /Did you mean 'git-status'\?$/);
  assert.match(codeCommandBlocker("git_status")!, /Did you mean 'git-status'\?$/);
  assert.match(codeCommandBlocker("BUILD")!, /Did you mean 'build'\?$/);
  assert.match(codeCommandBlocker("git clone")!, /Did you mean 'git-clone'\?$/);
  assert.match(codeCommandBlocker("Agent Reach Doctor")!, /Did you mean 'agent-reach-doctor'\?$/);
});

test("code command gate: a non-string or empty value refuses naming the allowlist, no correction", () => {
  assert.match(codeCommandBlocker(42)!, /^Unknown code command '42'\. Allowlisted commands:/);
  assert.doesNotMatch(codeCommandBlocker(42)!, /Did you mean/);
  assert.match(codeCommandBlocker("")!, /^Unknown code command ''\. Allowlisted commands:/);
  assert.doesNotMatch(codeCommandBlocker("")!, /Did you mean/);
});

test("code command gate: the codeCommandSpec seam refuses a folded name before any code root, and an exact name builds its spec", () => {
  const sam = mkdtempSync(join(tmpdir(), "code-command-gate-sam-"));
  const proj = mkdtempSync(join(tmpdir(), "code-command-gate-proj-"));
  try {
    // No code root designated on this install: the name refusal still lands first.
    assert.throws(() => codeCommandSpec(sam, "Git Status"), /Did you mean 'git-status'\?$/);
    assert.throws(() => codeCommandSpec(sam, "deploy"), /^Error: Unknown code command 'deploy'\. Allowlisted commands:/);
    writeFileSync(join(proj, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    setCodeRoot(sam, proj);
    const spec = codeCommandSpec(sam, "git-status");
    assert.equal(spec.file, "git");
    assert.deepEqual(spec.args, ["status", "--short", "--branch", "--untracked-files=normal"]);
  } finally { rmSync(sam, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});
