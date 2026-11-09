import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIdentity, withIdentity } from "./identity.js";

test("SAM has an accurate identity without a SOUL.md file", () => {
  const dir = mkdtempSync(join(tmpdir(),"sam-identity-"));
  try {
    const identity = loadIdentity(dir);
    assert.match(identity,/Secret Agent Man/);
    assert.match(identity,/tools explicitly advertised and authorized/);
    assert.match(identity,/unrestricted shell access/);
    assert.doesNotMatch(identity,/cannot yet use computer tools/);
    assert.equal(withIdentity(dir,[{role:"user",content:"Hi"}])[0]?.role,"system");
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("workspace SOUL.md augments identity and does not erase capability limits", () => {
  const dir = mkdtempSync(join(tmpdir(),"sam-identity-"));
  try {
    writeFileSync(join(dir,"SOUL.md"),"Speak concisely. Call yourself SAM.");
    const identity=loadIdentity(dir);
    assert.match(identity,/Speak concisely/);
    assert.match(identity,/tools explicitly advertised and authorized/);
    assert.match(identity,/unrestricted shell access/);
    assert.doesNotMatch(identity,/cannot yet use computer tools/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("oversized identity is rejected before sending model requests", () => {
  const dir=mkdtempSync(join(tmpdir(),"sam-identity-"));
  try {
    writeFileSync(join(dir,"SOUL.md"),"x".repeat(16_001));
    assert.throws(()=>loadIdentity(dir),/exceeds/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
