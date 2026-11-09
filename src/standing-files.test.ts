import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import {
  STANDING_FILE_MAX_CHARS, composeSystemPrompt, listStandingFiles,
  readStandingFile, standingPromptParts, standingSummary,
  writeStandingFile, clearStandingFile,
} from "./standing-files.js";
import { createBackup, restoreBackup, verifyBackup } from "./backup.js";

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sam-standing-"));
  const db = new ChatStore(root);
  try {
    db.createAgent("dip", "Dip's helper paragraph.");
    db.createAgent("trading", "Trading paragraph.");
  } finally { db.close(); }
  return root;
}

test("standing files: write/read/list/clear roundtrip for a registered profile and the sam core", () => {
  const root = scratch();
  try {
    assert.deepEqual(listStandingFiles(root, "dip").map(e => e.present), [false, false, false]);
    const entry = writeStandingFile(root, "dip", "persona", "You are Dip's SAM. Warm, direct, brief.");
    assert.equal(entry.present, true);
    assert.equal(entry.tier, "stable");
    assert.equal(readStandingFile(root, "dip", "persona"), "You are Dip's SAM. Warm, direct, brief.\n");
    assert.equal(readStandingFile(root, "dip", "owner"), null);
    const core = writeStandingFile(root, "sam", "ops", "Box checks first, then the report.");
    assert.equal(core.tier, "context");
    assert.equal(clearStandingFile(root, "dip", "persona"), true);
    assert.equal(clearStandingFile(root, "dip", "persona"), false);
    assert.equal(readStandingFile(root, "dip", "persona"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standing files: bad profile, bad file name, empty and oversize content all refuse", () => {
  const root = scratch();
  try {
    assert.throws(() => writeStandingFile(root, "nobody", "persona", "x"), /Unknown profile "nobody"\. Known profiles: sam, dip, trading/);
    assert.throws(() => writeStandingFile(root, "dip", "diary", "x"), /Unknown standing file "diary"\. Standing files: persona, owner, ops/);
    assert.throws(() => writeStandingFile(root, "dip", "persona", "   "), /empty/);
    assert.throws(() => writeStandingFile(root, "dip", "persona", "x".repeat(STANDING_FILE_MAX_CHARS + 1)), /cap is/);
    assert.throws(() => listStandingFiles(root, "../etc"), /Invalid profile name|Unknown profile/);
    // Nothing was written by the refusals.
    assert.deepEqual(standingSummary(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standing files: tiers split persona (stable) from owner+ops (context), scoped per profile", () => {
  const root = scratch();
  try {
    writeStandingFile(root, "dip", "persona", "PERSONA-DIP");
    writeStandingFile(root, "dip", "owner", "OWNER-DIP");
    writeStandingFile(root, "dip", "ops", "OPS-DIP");
    writeStandingFile(root, "trading", "persona", "PERSONA-TRADING");
    const dip = standingPromptParts(root, "dip");
    assert.match(dip.stable, /PERSONA-DIP/);
    assert.match(dip.stable, /stable tier/);
    assert.match(dip.context, /OWNER-DIP/);
    assert.match(dip.context, /OPS-DIP/);
    assert.ok(dip.context.indexOf("OWNER-DIP") < dip.context.indexOf("OPS-DIP"), "owner brief precedes ops notes");
    assert.ok(!dip.stable.includes("OWNER-DIP") && !dip.context.includes("PERSONA-DIP"), "tiers do not bleed into each other");
    const trading = standingPromptParts(root, "trading");
    assert.match(trading.stable, /PERSONA-TRADING/);
    assert.ok(!trading.stable.includes("DIP") && !trading.context.includes("DIP"), "one profile's files never enter another's prompt");
    const empty = standingPromptParts(root, "sam");
    assert.deepEqual(empty, { stable: "", context: "" });
    assert.deepEqual(standingSummary(root).map(s => s.profile), ["dip", "trading"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("composeSystemPrompt: tier order is base+style, stable, role, context, volatile+law; empties vanish", () => {
  const prompt = composeSystemPrompt({
    base: "BASE", style: "STYLE", stable: "PERSONA", role: "ROLE", context: "CTX", volatile: "VISITOR", law: "LAW",
  });
  const at = (s: string) => prompt.indexOf(s);
  assert.ok(at("BASE") < at("STYLE") && at("STYLE") < at("PERSONA") && at("PERSONA") < at("ROLE")
    && at("ROLE") < at("CTX") && at("CTX") < at("VISITOR") && at("VISITOR") < at("LAW"),
    "stable < context < volatile, law last: " + prompt);
  const bare = composeSystemPrompt({ base: "BASE", style: "STYLE", stable: "", role: "", context: "", volatile: "", law: "" });
  assert.equal(bare, "BASE STYLE", "a profile with no files and no law gets exactly base + style");
});

test("standing files ride the nightly backup: manifest lists them and restore brings them back", () => {
  const root = scratch();
  const dest = mkdtempSync(join(tmpdir(), "sam-standing-bkdest-"));
  const root2 = mkdtempSync(join(tmpdir(), "sam-standing-restore-"));
  try {
    writeStandingFile(root, "dip", "persona", "PERSONA-DIP");
    writeStandingFile(root, "dip", "ops", "OPS-DIP");
    const info = createBackup(root, dest);
    const check = verifyBackup(info.path);
    assert.equal(check.ok, true, check.errors.join("; "));
    const restored = restoreBackup(root2, info.path);
    assert.ok(existsSync(join(restored.restored, "standing", "dip", "persona.md")));
    assert.equal(readStandingFile(root2, "dip", "persona"), "PERSONA-DIP\n");
    assert.equal(readStandingFile(root2, "dip", "ops"), "OPS-DIP\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});
