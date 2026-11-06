import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperativeRegistry } from "./operatives.js";
import Database from "better-sqlite3";

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

test("stale or paused operatives cannot be assigned even when capacity exists",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-operative-heartbeat-"));
  try {
    const path=join(dir,"db.sqlite");
    const db=new OperativeRegistry(path);
    const worker=db.register({name:"worker",adapter:"local",capabilities:["code"]});
    assert.equal(db.heartbeat(worker.id),false);
    db.setState(worker.id,"available");
    assert.equal(db.reserve(worker.id),true);
    assert.equal(db.release(worker.id),true);
    db.setState(worker.id,"paused");
    assert.equal(db.heartbeat(worker.id),false);
    assert.equal(db.reserve(worker.id),false);
    db.setState(worker.id,"available");
    db.close();
    const raw=new Database(path);
    raw.prepare("UPDATE operatives SET last_seen_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z",worker.id);
    raw.close();
    const reopened=new OperativeRegistry(path);
    assert.deepEqual(reopened.candidates(["code"]),[]);
    assert.equal(reopened.reserve(worker.id),false);
    assert.equal(reopened.heartbeat(worker.id),true);
    assert.equal(reopened.reserve(worker.id),true);
    reopened.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
