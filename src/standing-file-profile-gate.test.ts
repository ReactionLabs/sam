import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import {
  listStandingFiles, standingFileProfileBlocker, standingSummary, writeStandingFile,
} from "./standing-files.js";

// The profile gate for the standing-files door: every
// profile-naming door reads the profile registry through a
// ONE source in its owning module carrying the refusal text
// with a fold correction - but assertKnownProfile checked
// inline and refused with its own "Known profiles" wording
// and no correction, and a folded name died on the format
// check in front of it. standingFileProfileBlocker in
// standing-files.ts is now the ONE source carrying the
// refusal text, and assertKnownProfile throws it (keeping
// "Invalid profile name" only for a malformed name that
// folds to nothing), so list/read/write/clear and the CLI
// agents files doors all refuse in the same words before
// anything is read or written.

function fresh(): string { return mkdtempSync(join(tmpdir(), "sam-standing-file-profile-gate-")); }

function register(root: string, name: string): void {
  const db = new ChatStore(root);
  try { db.createAgent(name, "Test profile " + name); } finally { db.close(); }
}

test("standing file profile gate: sam and a registered profile read no blocker", () => {
  const root = fresh();
  try {
    assert.equal(standingFileProfileBlocker(root, "sam"), null);
    register(root, "second-shift");
    assert.equal(standingFileProfileBlocker(root, "second-shift"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standing file profile gate: an unknown profile names the registry and the fold correction", () => {
  const root = fresh();
  try {
    assert.equal(
      standingFileProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in standing file detail. Valid profiles: sam",
    );
    register(root, "second-shift");
    assert.equal(
      standingFileProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in standing file detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.equal(
      standingFileProfileBlocker(root, "nosuchprofile"),
      "Unknown profile \"nosuchprofile\" in standing file detail. Valid profiles: sam, second-shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standing file profile gate: an ambiguous fold names no correction", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    register(root, "second_shift");
    assert.equal(
      standingFileProfileBlocker(root, "Second Shift"),
      "Unknown profile \"Second Shift\" in standing file detail. Valid profiles: sam, second-shift, second_shift",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standing file profile gate: write throws the ONE source's words for a folded name and writes nothing", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.throws(
      () => writeStandingFile(root, "Second Shift", "persona", "x"),
      (e: unknown) => e instanceof Error && e.message === "Unknown profile \"Second Shift\" in standing file detail. Valid profiles: sam, second-shift. Did you mean \"second-shift\"?",
    );
    assert.deepEqual(standingSummary(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standing file profile gate: a malformed name that folds to nothing keeps the invalid-name refusal; a registered profile lists cleanly", () => {
  const root = fresh();
  try {
    register(root, "second-shift");
    assert.throws(() => listStandingFiles(root, "../etc"), /Invalid profile name/);
    assert.deepEqual(listStandingFiles(root, "second-shift").map(e => e.present), [false, false, false]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
