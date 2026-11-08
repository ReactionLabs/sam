import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdit, proposeEdit } from "./file-edits.js";

test("explicit digest approval applies a proposed replacement once", () => {
  const root=mkdtempSync(join(tmpdir(),"sam-edit-"));
  try {
    writeFileSync(join(root,"a.txt"),"before");
    const proposal=proposeEdit(root,"a.txt","after");
    assert.equal(readFileSync(join(root,"a.txt"),"utf8"),"before");
    assert.throws(()=>applyEdit(root,proposal.id,"0".repeat(64)),/not approved/);
    assert.equal(applyEdit(root,proposal.id,proposal.digest).applied,true);
    assert.equal(readFileSync(join(root,"a.txt"),"utf8"),"after");
    assert.throws(()=>applyEdit(root,proposal.id,proposal.digest));
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("stale file and protected paths fail closed", () => {
  const root=mkdtempSync(join(tmpdir(),"sam-edit-"));
  try {
    writeFileSync(join(root,"a.txt"),"before");
    const proposal=proposeEdit(root,"a.txt","after");
    writeFileSync(join(root,"a.txt"),"someone else edited");
    assert.throws(()=>applyEdit(root,proposal.id,proposal.digest),/changed since proposal/);
    assert.equal(readFileSync(join(root,"a.txt"),"utf8"),"someone else edited");
    writeFileSync(join(root,".env"),"secret");
    assert.throws(()=>proposeEdit(root,".env","leak"),/Protected/);
    assert.throws(()=>proposeEdit(root,"../outside","x"),/outside/);
    mkdirSync(join(root,"nested"));
    writeFileSync(join(root,"nested","a.txt"),"safe");
    try {
      symlinkSync(join(root,"nested","a.txt"),join(root,"link.txt"),"file");
      assert.throws(()=>proposeEdit(root,"link.txt","bad"),/Symlink/);
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=="EPERM") throw error;
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
