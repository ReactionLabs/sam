import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import {
  STANDING_FILES, clearStandingFile, readStandingFile, standingFileBlocker,
  standingSummary, writeStandingFile,
} from "./standing-files.js";

// The standing-file name gate: a standing file name is a
// registry name (persona / owner / ops) that a person picks
// at the agents files doors. The seams every standing-file
// read and write rides - standingPath (read / list / clear)
// and writeStandingFile - each improvised the same "Unknown
// standing file" text inline: it echoed the value and named
// the registry but offered NO fold correction, so a folded
// name ("Persona", "PERSONA") dead-ended at the door that
// picks which standing file a profile's prompt assembles.
// standingFileBlocker in standing-files.ts is now the ONE
// source carrying the refusal text; both seams throw it
// before any path is built or any file is touched.

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-standing-name-gate-"));
  const db = new ChatStore(root);
  try { db.createAgent("dip", "Dip's helper paragraph."); }
  finally { db.close(); }
  return root;
}

test("standing-file name gate: the three real names read no blocker", () => {
  for (const f of STANDING_FILES) assert.equal(standingFileBlocker(f.name), null);
  assert.deepEqual(STANDING_FILES.map(f => f.name), ["persona", "owner", "ops"]);
});

test("standing-file name gate: the folded registry has no collisions", () => {
  const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  assert.equal(new Set(STANDING_FILES.map(f => fold(f.name))).size, STANDING_FILES.length);
});

test("standing-file name gate: an unknown name names the registry, no correction", () => {
  assert.equal(
    standingFileBlocker("diary"),
    "Unknown standing file \"diary\". Standing files: persona, owner, ops",
  );
  assert.equal(
    standingFileBlocker("owner-brief"),
    "Unknown standing file \"owner-brief\". Standing files: persona, owner, ops",
  );
});

test("standing-file name gate: a folded name is refused with the correction", () => {
  assert.match(standingFileBlocker("Persona")!, /Did you mean "persona"\?$/);
  assert.match(standingFileBlocker("PERSONA")!, /Did you mean "persona"\?$/);
  assert.match(standingFileBlocker("Owner")!, /Did you mean "owner"\?$/);
  assert.match(standingFileBlocker(" ops ")!, /Did you mean "ops"\?$/);
});

test("standing-file name gate: a non-string or empty value refuses with no correction", () => {
  assert.equal(standingFileBlocker(""), "Unknown standing file \"\". Standing files: persona, owner, ops");
  assert.equal(standingFileBlocker(undefined), "Unknown standing file \"undefined\". Standing files: persona, owner, ops");
  assert.equal(standingFileBlocker(42), "Unknown standing file \"42\". Standing files: persona, owner, ops");
});

test("standing-file name gate: every seam throws the ONE source and touches nothing", () => {
  const root = scratch();
  try {
    assert.throws(() => writeStandingFile(root, "dip", "Persona", "x"), /Unknown standing file "Persona"\. Standing files: persona, owner, ops\. Did you mean "persona"\?/);
    assert.throws(() => readStandingFile(root, "dip", "OWNER"), /Did you mean "owner"\?/);
    assert.throws(() => clearStandingFile(root, "dip", "Ops"), /Did you mean "ops"\?/);
    // Nothing was written by the refusals.
    assert.deepEqual(standingSummary(root), []);
    // The canonical name still works through the same seams.
    writeStandingFile(root, "dip", "persona", "Warm and direct.");
    assert.equal(readStandingFile(root, "dip", "persona"), "Warm and direct.\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
