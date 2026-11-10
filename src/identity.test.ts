import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_STATEMENT, loadIdentity, withIdentity } from "./identity.js";

test("SAM has an accurate identity without a SOUL.md file", () => {
  const dir = mkdtempSync(join(tmpdir(),"sam-identity-"));
  try {
    const identity = loadIdentity(dir);
    assert.match(identity,/Secret Agent Man/);
    assert.equal(identity,CAPABILITY_STATEMENT);
    assert.equal(withIdentity(dir,[{role:"user",content:"Hi"}])[0]?.role,"system");
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("the one capability statement describes the live turn truthfully", () => {
  // What the live turn can actually do today (UNIFICATION item 1).
  for (const truth of [
    /chats persist/,
    /standing law/,
    /background work/,
    /for the owner's approval/,
    /content-scanned first and a flagged skill/,
    /waits for the owner instead of installing/,
    /read-only tools/,
    /drafts are stored records the owner sends/,
  ]) assert.match(CAPABILITY_STATEMENT,truth);
  // The retired description claimed the opposite of all of it.
  assert.doesNotMatch(CAPABILITY_STATEMENT,/cannot yet use computer tools/);
  assert.doesNotMatch(CAPABILITY_STATEMENT,/future workforce commander/);
  // The hard fences stay stated, never softened.
  assert.match(CAPABILITY_STATEMENT,/never move money, trade, or run arbitrary shell commands/);
  assert.match(CAPABILITY_STATEMENT,/Never claim to have performed an action unless a tool result confirms it/);
});

test("the live turn consumes the same statement (one description, both surfaces)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // Tests run from dist/, so this reads the compiled live turn.
  const turn = readFileSync(join(here,"agent-turn.js"),"utf8");
  assert.match(turn,/CAPABILITY_STATEMENT/);
  assert.match(turn,/base: CAPABILITY_STATEMENT/);
  assert.doesNotMatch(turn,/local-first mission assistant/);
});

test("workspace SOUL.md augments identity and does not erase the capability statement", () => {
  const dir = mkdtempSync(join(tmpdir(),"sam-identity-"));
  try {
    writeFileSync(join(dir,"SOUL.md"),"Speak concisely. Call yourself SAM.");
    const identity=loadIdentity(dir);
    assert.match(identity,/Speak concisely/);
    assert.match(identity,/chats persist/);
    assert.match(identity,/for the owner's approval/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("oversized identity is rejected before sending model requests", () => {
  const dir=mkdtempSync(join(tmpdir(),"sam-identity-"));
  try {
    writeFileSync(join(dir,"SOUL.md"),"x".repeat(16_001));
    assert.throws(()=>loadIdentity(dir),/exceeds/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
