import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeModelEdit } from "./model-edit.js";
import { applyEdit } from "./file-edits.js";

test("model may propose but cannot apply until human confirms digest", async()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-model-edit-"));
  try {
    writeFileSync(join(root,"hello.txt"),"old");
    const provider={complete:async()=>({message:{content:JSON.stringify({replacement:"new"})}})};
    const proposal=await proposeModelEdit(root,"hello.txt","Change old to new","fake",provider);
    assert.equal(readFileSync(join(root,"hello.txt"),"utf8"),"old");
    assert.equal(applyEdit(root,proposal.id,proposal.digest).applied,true);
    assert.equal(readFileSync(join(root,"hello.txt"),"utf8"),"new");
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("malformed model responses and protected paths never create writes",async()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-model-edit-"));
  try {
    writeFileSync(join(root,"hello.txt"),"old");
    writeFileSync(join(root,".env"),"SECRET");
    const bad={complete:async()=>({message:{content:'{"replacement":"new","extra":true}'}})};
    await assert.rejects(proposeModelEdit(root,"hello.txt","change it","fake",bad),/schema/);
    await assert.rejects(proposeModelEdit(root,".env","read secrets","fake",bad),/Protected/);
    assert.equal(readFileSync(join(root,"hello.txt"),"utf8"),"old");
  } finally {rmSync(root,{recursive:true,force:true});}
});
