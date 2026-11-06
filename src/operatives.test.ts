import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperativeRegistry } from "./operatives.js";

test("routes only to healthy capable operatives and respects capacity",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-operatives-"));
  try {
    const path=join(dir,"registry.sqlite");
    const db=new OperativeRegistry(path);
    const a=db.register({name:"mita",adapter:"local",capabilities:["code","review"]});
    const b=db.register({name:"jack",adapter:"local",capabilities:["marketing"]});
    assert.equal(db.candidates(["code"]).length,0);
    assert.equal(db.setState(a.id,"available"),true);
    assert.equal(db.setState(b.id,"available"),true);
    assert.deepEqual(db.candidates(["code"]).map(x=>x.name),["mita"]);
    assert.equal(db.reserve(a.id),true);
    assert.equal(db.reserve(a.id),false);
    assert.equal(db.candidates(["code"]).length,0);
    assert.equal(db.release(a.id),true);
    assert.equal(db.release(a.id),false);
    db.close();
    const reopened=new OperativeRegistry(path);
    assert.deepEqual(reopened.candidates(["review"]).map(x=>x.name),["mita"]);
    reopened.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test("rejects invalid declarations and duplicate names",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-operatives-"));
  try {
    const db=new OperativeRegistry(join(dir,"db.sqlite"));
    assert.throws(()=>db.register({name:"shell; rm -rf",adapter:"local",capabilities:["code"]}),/Invalid/);
    assert.throws(()=>db.register({name:"empty",adapter:"local",capabilities:[]}),/Invalid/);
    db.register({name:"worker",adapter:"local",capabilities:["code"]});
    assert.throws(()=>db.register({name:"worker",adapter:"local",capabilities:["code"]}));
    assert.throws(()=>db.candidates([]),/Invalid/);
    db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
