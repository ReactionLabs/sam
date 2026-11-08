import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionBoxStorage } from "./box-storage.js";

function fixture(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "sam-box-storage-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("owner and instance pairs receive separate paths; repeated provisioning is stable", () => fixture(root => {
  const a = provisionBoxStorage(root, "owner-a", "sam-one");
  const b = provisionBoxStorage(root, "owner-a", "sam-two");
  const c = provisionBoxStorage(root, "owner-b", "sam-one");
  assert.notEqual(a.database, b.database);
  assert.notEqual(a.database, c.database);
  assert.notEqual(a.vault, b.vault);
  assert.notEqual(a.workspace, c.workspace);
  assert.deepEqual(provisionBoxStorage(root, "owner-a", "sam-one"), a);
}));

test("rejects traversal, Windows reserved names, wildcard and malformed IDs", () => fixture(root => {
  for (const id of ["../other", "a/b", "a\\b", "*", "", "CON", "com1", "UPPER", "a ", "a".repeat(65)]) {
    assert.throws(() => provisionBoxStorage(root, "owner", id), /Invalid instance ID/);
  }
  assert.throws(() => provisionBoxStorage(root, "../owner", "sam"), /Invalid owner ID/);
}));

test("rejects symlinked state, owner, instance and child directories", () => fixture(root => {
  const outside = mkdtempSync(join(tmpdir(), "sam-outside-"));
  try {
    symlinkSync(outside, join(root, ".sam"), "dir");
    assert.throws(() => provisionBoxStorage(root, "owner", "sam"), /Unsafe/);
    rmSync(join(root, ".sam"));
    mkdirSync(join(root, ".sam", "boxes", "owner"), { recursive: true });
    symlinkSync(outside, join(root, ".sam", "boxes", "owner", "sam"), "dir");
    assert.throws(() => provisionBoxStorage(root, "owner", "sam"), /Unsafe/);
    rmSync(join(root, ".sam", "boxes", "owner", "sam"));
    mkdirSync(join(root, ".sam", "boxes", "owner", "sam"));
    symlinkSync(outside, join(root, ".sam", "boxes", "owner", "sam", "vault"), "dir");
    assert.throws(() => provisionBoxStorage(root, "owner", "sam"), /Unsafe/);
  } finally { rmSync(outside, { recursive: true, force: true }); }
}));

test("rejects file occupying a storage directory", () => fixture(root => {
  mkdirSync(join(root, ".sam"));
  writeFileSync(join(root, ".sam", "boxes"), "not a directory");
  assert.throws(() => provisionBoxStorage(root, "owner", "sam"), /Unsafe/);
}));
