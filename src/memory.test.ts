import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MemoryStore} from "./memory.js";

test("mission memory survives restart and supports search and archive",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-memory-"));
  try {
    const path=join(dir,"memory.sqlite");
    const a=new MemoryStore(path);
    const record=a.add({missionId:"OP-1",kind:"failure",content:"Build failed because dependency was missing",source:"test-run:42"});
    assert.equal(record.source_hash.length,64);
    a.close();
    const b=new MemoryStore(path);
    assert.equal(b.list("OP-1").length,1);
    assert.equal(b.search("dependency").length,1);
    assert.equal(b.archive(record.id),true);
    assert.equal(b.search("dependency").length,0);
    assert.equal(b.archive(record.id),false);
    b.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("memory requires source provenance",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-memory-"));
  try {
    const db=new MemoryStore(join(dir,"memory.sqlite"));
    assert.throws(()=>db.add({kind:"observation",content:"Something",source:""}),/provenance/);
    db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
