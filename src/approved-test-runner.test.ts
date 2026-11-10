import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestTestRun, executeApprovedTestRun } from "./approved-test-runner.js";

test("runner rejects nonallowlisted commands",()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-run-"));
  try {assert.throws(()=>requestTestRun(root,"powershell"),/Only build and test/);}
  finally {rmSync(root,{recursive:true,force:true});}
});
test("runner requires exact digest and consumes authorization once",async()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-run-"));
  try {
    mkdirSync(join(root,"dist"));
    writeFileSync(join(root,"package.json"),'{"type":"module"}');
    writeFileSync(join(root,"dist","demo.test.js"),'import test from "node:test"; test("works",()=>{});\n');
    const request=requestTestRun(root,"test");
    await assert.rejects(executeApprovedTestRun(root,request.id,"0".repeat(64)),/digest mismatch/);
    const result=await executeApprovedTestRun(root,request.id,request.digest,10000);
    assert.equal(result.passed,true);
    assert.match(result.output,/works/);
    await assert.rejects(executeApprovedTestRun(root,request.id,request.digest),/ENOENT/);
    const audit=readFileSync(join(root,".sam","execution-audit.jsonl"),"utf8");
    assert.match(audit,/"event":"started"/);
    assert.match(audit,/"event":"finished"/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("runner reports failed test without executing arbitrary commands",async()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-run-"));
  try {
    mkdirSync(join(root,"dist"));
    writeFileSync(join(root,"package.json"),'{"type":"module"}');
    writeFileSync(join(root,"dist","fail.test.js"),'import test from "node:test"; test("fails",()=>{throw Error("expected failure")});\n');
    const request=requestTestRun(root,"test");
    const result=await executeApprovedTestRun(root,request.id,request.digest,10000);
    assert.equal(result.passed,false);
    assert.notEqual(result.exitCode,0);
  } finally {rmSync(root,{recursive:true,force:true});}
});
