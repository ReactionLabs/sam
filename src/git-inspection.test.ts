import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectGitWorkspace } from "./git-inspection.js";

test("Git inspection is read-only, bounded and scoped to repository root", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-git-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "sample.txt"), "hello\n");
    const status = JSON.parse(inspectGitWorkspace(root, "status"));
    assert.equal(status.untrusted, true);
    assert.match(status.output, /sample\.txt/);
    assert.equal(JSON.parse(inspectGitWorkspace(root, "diff")).action, "diff");
    const nested = join(root, "nested");
    mkdirSync(nested);
    assert.throws(() => inspectGitWorkspace(nested, "status"), /root must match/);
    assert.throws(() => inspectGitWorkspace(root, "delete" as "status"), /Unsupported/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Git inspection rejects non-repository workspaces", () => {
  const root = mkdtempSync(join(tmpdir(), "sam-no-git-"));
  try { assert.throws(() => inspectGitWorkspace(root, "status"), /not a Git repository/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
