import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeEdit, rejectEdit } from "./file-edits.js";
import { reviewEdit } from "./edit-review.js";

test("review flags removed think markup and reject leaves original unchanged",()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-review-"));
  try {
    const path=join(root,"README.md");
    writeFileSync(path,"Documentation for <think>...</think> markup\n");
    const proposal=proposeEdit(root,"README.md","Documentation for markup\n");
    const result=reviewEdit(root,proposal.id);
    assert.equal(result.stale,false);
    assert.ok(result.diff.includes("-Documentation for <think>...</think> markup"));
    assert.ok(result.findings.some(x=>x.code==="REMOVED_LITERAL"));
    assert.equal(rejectEdit(root,proposal.id).rejected,true);
    assert.equal(readFileSync(path,"utf8"),"Documentation for <think>...</think> markup\n");
    assert.throws(()=>reviewEdit(root,proposal.id));
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("review flags stale source",()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-review-"));
  try {
    writeFileSync(join(root,"file.txt"),"a\n");
    const proposal=proposeEdit(root,"file.txt","b\n");
    writeFileSync(join(root,"file.txt"),"c\n");
    assert.ok(reviewEdit(root,proposal.id).findings.some(x=>x.code==="STALE_SOURCE"));
  } finally {rmSync(root,{recursive:true,force:true});}
});
