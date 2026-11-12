import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCodeRoot, codeRoot, codeSummary, readCodeStore, setCodeRoot } from "./code.js";

// State convergence (UNIFICATION item 4, thirty-second store):
// the designated code root migrated from whole-file code.json
// rewrites (two writers holding the same snapshot could lose a
// designation - and the designation is the C1 fence, the one
// record that decides which tree SAM may write in at all) to
// a one-row SQLite singleton. These tests pin the migration
// contract: a legacy file imports with its root intact, is
// renamed (never deleted), a malformed / misshapen file
// imports nothing and stays put while reading as unset, a
// pure read creates nothing (not even the .sam directory the
// old read path created), a refused designation creates
// nothing, and saves ride the DB as single-row UPSERTs.

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sam-code-store-"));
  const sam = join(base, "home");
  const proj = join(base, "proj");
  const proj2 = join(base, "proj2");
  mkdirSync(sam, { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(proj2, { recursive: true });
  return { base, sam, proj, proj2 };
}

test("code store: a legacy code.json imports intact, file renamed not deleted", () => {
  const { base, sam, proj } = fixture();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    writeFileSync(join(sam, ".sam", "code.json"), JSON.stringify({ version: 1, root: proj }, null, 2));
    assert.deepEqual(readCodeStore(sam), { version: 1, root: proj });
    assert.equal(codeRoot(sam), proj);
    assert.equal(codeSummary(sam).root, proj);
    assert.equal(existsSync(join(sam, ".sam", "code.db")), true);
    assert.equal(existsSync(join(sam, ".sam", "code.json")), false);
    assert.equal(existsSync(join(sam, ".sam", "code.json.migrated")), true);
    const kept = JSON.parse(readFileSync(join(sam, ".sam", "code.json.migrated"), "utf8")) as { root: string };
    assert.equal(kept.root, proj);
    // A designation after migration rides the DB; no JSON is
    // recreated.
    clearCodeRoot(sam);
    assert.deepEqual(readCodeStore(sam), { version: 1, root: null });
    assert.equal(codeRoot(sam), null);
    assert.equal(existsSync(join(sam, ".sam", "code.json")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code store: a legacy explicit null root imports as a recorded unset", () => {
  const { base, sam } = fixture();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    writeFileSync(join(sam, ".sam", "code.json"), JSON.stringify({ version: 1, root: null }));
    assert.deepEqual(readCodeStore(sam), { version: 1, root: null });
    assert.equal(codeRoot(sam), null);
    assert.equal(existsSync(join(sam, ".sam", "code.json.migrated")), true);
    assert.equal(existsSync(join(sam, ".sam", "code.json")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code store: malformed and misshapen legacy files import nothing, stay in place, and read as unset", () => {
  const { base, sam, proj } = fixture();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    for (const payload of ["{ not json", JSON.stringify({ version: 1, root: 42 }), JSON.stringify({ version: 1 }), JSON.stringify(["not", "an", "object"])]) {
      writeFileSync(join(sam, ".sam", "code.json"), payload);
      assert.equal(readCodeStore(sam), null, payload);
      assert.equal(codeRoot(sam), null, payload);
      assert.equal(existsSync(join(sam, ".sam", "code.json")), true);
      assert.equal(existsSync(join(sam, ".sam", "code.json.migrated")), false);
    }
    // A designation over an unimportable legacy file still
    // lands in the DB; the file itself is left exactly as found.
    assert.equal(setCodeRoot(sam, proj), proj);
    assert.deepEqual(readCodeStore(sam), { version: 1, root: proj });
    assert.equal(existsSync(join(sam, ".sam", "code.json")), true);
    assert.equal(existsSync(join(sam, ".sam", "code.db")), true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code store: a pure read on an empty install creates nothing, and a refused designation creates nothing", () => {
  const base = mkdtempSync(join(tmpdir(), "sam-code-store-"));
  const sam = join(base, "home");
  mkdirSync(sam, { recursive: true });
  try {
    assert.equal(readCodeStore(sam), null);
    assert.equal(codeRoot(sam), null);
    assert.equal(existsSync(join(sam, ".sam")), false);
    // The fence refusals run before any store is touched.
    assert.throws(() => setCodeRoot(sam, sam), /cannot be the SAM home itself/);
    assert.throws(() => setCodeRoot(sam, join(base, "missing")), /does not exist/);
    assert.equal(existsSync(join(sam, ".sam")), false);
    assert.equal(readCodeStore(sam), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code store: successive designations replace through the DB, never resurrecting the older one", () => {
  const { base, sam, proj, proj2 } = fixture();
  try {
    assert.equal(setCodeRoot(sam, proj), proj);
    assert.equal(setCodeRoot(sam, proj2), proj2);
    assert.deepEqual(readCodeStore(sam), { version: 1, root: proj2 });
    assert.equal(codeRoot(sam), proj2);
    clearCodeRoot(sam);
    assert.equal(codeRoot(sam), null);
    assert.deepEqual(readCodeStore(sam), { version: 1, root: null });
    assert.equal(existsSync(join(sam, ".sam", "code.json")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("code store: a newer designation over a migrated legacy root persists - the snapshot-revert shape is gone", () => {
  const { base, sam, proj, proj2 } = fixture();
  try {
    mkdirSync(join(sam, ".sam"), { recursive: true });
    writeFileSync(join(sam, ".sam", "code.json"), JSON.stringify({ version: 1, root: proj }));
    assert.equal(codeRoot(sam), proj);
    assert.equal(setCodeRoot(sam, proj2), proj2);
    assert.equal(codeRoot(sam), proj2);
    assert.deepEqual(readCodeStore(sam), { version: 1, root: proj2 });
    assert.equal(existsSync(join(sam, ".sam", "code.json.migrated")), true);
    assert.equal(existsSync(join(sam, ".sam", "code.json")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
