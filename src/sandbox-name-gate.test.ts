import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { destroySandbox, listSandboxes, requireOwnSandbox, sandboxNameBlocker, sandboxPipArgv, writeSandboxFile } from "./code.js";

// The sandbox name gate: a sandbox name is a registry name
// (the sandboxes SAM created under this install) that a
// person picks at the sandbox use doors. requireOwnSandbox,
// the ONE seam every sandbox use rides, improvised its
// naming refusals in two pieces - the bare "Invalid sandbox
// name" for a shape-failing name and "No SAM sandbox named
// X" naming no registry for a well-shaped unknown - with NO
// fold correction either way, so a folded name ("Work",
// "SoulFind") dead-ended. sandboxNameBlocker in code.ts is
// now the ONE source carrying the refusal text; the seam
// throws it before any path is built, when no directory
// entry carries the name. The registry is dynamic per
// install, so a correction is offered only when exactly one
// created sandbox matches folded for case and separators.

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-sandbox-name-gate-"));
  for (const name of ["soulfind", "work"]) {
    const dir = join(root, ".sam", "sandboxes", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sandbox.json"), JSON.stringify({ version: 1, name, createdBy: "sam", at: "2026-11-27T00:00:00.000Z" }));
  }
  return root;
}

test("sandbox name gate: the created names read no blocker", () => {
  const root = scratch();
  try {
    assert.equal(sandboxNameBlocker(root, "soulfind"), null);
    assert.equal(sandboxNameBlocker(root, "work"), null);
    assert.deepEqual(listSandboxes(root).map(s => s.name), ["soulfind", "work"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sandbox name gate: on an empty install every name refuses, and the read creates nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-sandbox-name-gate-empty-"));
  try {
    assert.equal(sandboxNameBlocker(root, "work"), "No SAM sandbox named \"work\". Sandboxes: none created");
    assert.equal(existsSync(join(root, ".sam")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sandbox name gate: an unknown name names the registry, no correction", () => {
  const root = scratch();
  try {
    assert.equal(
      sandboxNameBlocker(root, "ghost"),
      "No SAM sandbox named \"ghost\". Sandboxes: soulfind, work",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sandbox name gate: a folded name is refused with the correction", () => {
  const root = scratch();
  try {
    assert.match(sandboxNameBlocker(root, "Work")!, /Did you mean "work"\?$/);
    assert.match(sandboxNameBlocker(root, "WORK")!, /Did you mean "work"\?$/);
    assert.match(sandboxNameBlocker(root, "SoulFind")!, /Did you mean "soulfind"\?$/);
    assert.match(sandboxNameBlocker(root, "soul_find")!, /Did you mean "soulfind"\?$/);
    assert.match(sandboxNameBlocker(root, "soul find")!, /Did you mean "soulfind"\?$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sandbox name gate: a non-string or empty value refuses with no correction", () => {
  const root = scratch();
  try {
    assert.equal(sandboxNameBlocker(root, ""), "No SAM sandbox named \"\". Sandboxes: soulfind, work");
    assert.equal(sandboxNameBlocker(root, undefined), "No SAM sandbox named \"undefined\". Sandboxes: soulfind, work");
    assert.equal(sandboxNameBlocker(root, 42), "No SAM sandbox named \"42\". Sandboxes: soulfind, work");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sandbox name gate: an unmarked directory is not the registry, and its safety refusal stands", () => {
  const root = scratch();
  try {
    const dir = join(root, ".sam", "sandboxes", "rogue");
    mkdirSync(dir, { recursive: true });
    // Not in the registry the blocker names (no SAM marker)...
    assert.equal(sandboxNameBlocker(root, "rogue"), "No SAM sandbox named \"rogue\". Sandboxes: soulfind, work");
    // ...but the seam's standing safety refusal, not the naming
    // refusal, answers for a directory entry that carries the name.
    assert.throws(() => requireOwnSandbox(root, "rogue"), /Refusing to use rogue: it is not a sandbox SAM created/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sandbox name gate: the seam throws the ONE source and touches nothing", () => {
  const root = scratch();
  try {
    assert.throws(() => requireOwnSandbox(root, "Work"), /No SAM sandbox named "Work"\. Sandboxes: soulfind, work\. Did you mean "work"\?/);
    assert.throws(() => destroySandbox(root, "sam", "SoulFind"), /Did you mean "soulfind"\?/);
    assert.throws(() => writeSandboxFile(root, "sam", "ghost", "a.txt", "hi"), /No SAM sandbox named "ghost"\. Sandboxes: soulfind, work$/);
    assert.throws(() => sandboxPipArgv(root, "WORK", "requests", "2.32.3"), /Did you mean "work"\?/);
    // Nothing was removed or written by the refusals.
    assert.deepEqual(listSandboxes(root).map(s => s.name), ["soulfind", "work"]);
    // The canonical names still work through the same seam.
    assert.equal(requireOwnSandbox(root, "work").name, "work");
    const written = writeSandboxFile(root, "sam", "work", "a.txt", "hi");
    assert.equal(written.sandbox, "work");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
