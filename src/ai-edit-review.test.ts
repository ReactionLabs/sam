import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeEdit } from "./file-edits.js";
import { reviewEditWithAi } from "./ai-edit-review.js";

test("AI reviewer reports independent concerns without writing target",async()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-ai-review-"));
  try {
    const file=join(root,"example.ts");
    writeFileSync(file,"export const total = 1;\n");
    const proposal=proposeEdit(root,"example.ts","export const total = 0;\n");
    let calls=0;
    const result=await reviewEditWithAi(root,proposal.id,"mock",{
      async complete(request){
        calls++;
        assert.equal(request.messages.length,1);
        assert.ok(request.messages[0].content.includes("export const total = 0"));
        return {message:{content:JSON.stringify({verdict:"CONCERNS",summary:"Changed value",findings:[
          {severity:"WARNING",detail:"Behavior changes",evidence:"total = 1 becomes total = 0"}
        ]})}};
      }
    });
    assert.equal(calls,1);
    assert.equal(result.ai.findings[0].severity,"WARNING");
    assert.equal(result.removedLines,1);
    assert.equal(readFileSync(file,"utf8"),"export const total = 1;\n");
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("AI reviewer rejects malformed model output and does not write",async()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-ai-review-"));
  try {
    const file=join(root,"example.ts");
    writeFileSync(file,"const x = 1;\n");
    const proposal=proposeEdit(root,"example.ts","const x = 2;\n");
    await assert.rejects(reviewEditWithAi(root,proposal.id,"mock",{
      async complete(){return {message:{content:'{"verdict":"NO_CONCERNS","summary":"ok","findings":[{"severity":"BLOCKER","detail":"bad","evidence":"x"}]}'}};}
    }),/verdict conflicts/);
    assert.equal(readFileSync(file,"utf8"),"const x = 1;\n");
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("AI reviewer refuses stale proposals without contacting model",async()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-ai-review-"));
  try {
    const file=join(root,"example.ts");
    writeFileSync(file,"const x = 1;\n");
    const proposal=proposeEdit(root,"example.ts","const x = 2;\n");
    writeFileSync(file,"const x = 3;\n");
    await assert.rejects(reviewEditWithAi(root,proposal.id,"mock",{
      async complete(){throw new Error("Model must not be called");}
    }),/stale/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
