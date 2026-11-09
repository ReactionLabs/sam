import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectDirectory } from "./local-inspection.js";

test("local inspection lists only immediate entries and marks protected paths",()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-inspect-"));
  try {
    mkdirSync(join(root,"src"));writeFileSync(join(root,"README.md"),"ok");
    writeFileSync(join(root,".env"),"SECRET=hidden");
    const result=inspectDirectory(root);
    assert.equal(result.entries.find(e=>e.name==="src")?.type,"directory");
    assert.equal(result.entries.find(e=>e.name==="README.md")?.type,"file");
    assert.equal(result.entries.find(e=>e.name===".env")?.type,"blocked");
    assert.equal(result.truncated,false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("inspection rejects traversal, absolute paths and protected directories",()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-inspect-"));
  try {
    mkdirSync(join(root,".git"));
    for(const path of ["../","../../etc",join(root,".git"),".git"]) {
      assert.throws(()=>inspectDirectory(root,path));
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("inspection refuses symlinks rather than following them",()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-inspect-"));
  try {
    mkdirSync(join(root,"real"));
    symlinkSync(join(root,"real"),join(root,"linked"),"junction");
    assert.equal(inspectDirectory(root).entries.find(e=>e.name==="linked")?.type,"blocked");
    assert.throws(()=>inspectDirectory(root,"linked"));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("inspection limits directory output",()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-inspect-"));
  try {
    for(let i=0;i<105;i++)writeFileSync(join(root,"file-"+i),"");
    const result=inspectDirectory(root);
    assert.equal(result.entries.length,100);
    assert.equal(result.truncated,true);
  } finally {rmSync(root,{recursive:true,force:true});}
});
