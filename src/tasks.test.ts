import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";
import {MissionStore} from "./storage.js";
import {TaskScheduler} from "./tasks.js";
test("dependency ordering, fenced leases, crash recovery and mission gate",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-tasks-"));
  try {
    const path=join(dir,"missions.db"), store=new MissionStore(path);
    const m=store.create("Build mission");
    store.transition(m.code,"PLANNING");
    store.transition(m.code,"READY");
    const db=new Database(path), tasks=new TaskScheduler(db);
    const first=tasks.add(m.id,"inspect");
    const second=tasks.add(m.id,"fix",[first.id]);
    assert.equal(tasks.claim(m.id,"worker-a",1000),undefined);
    store.transition(m.code,"RUNNING");
    const lease=tasks.claim(m.id,"worker-a",1000,100);
    assert.equal(lease?.id,first.id);
    assert.equal(tasks.claim(m.id,"worker-b",1050),undefined);
    assert.equal(tasks.complete(first.id,"worker-a",lease!.lease_generation,true,1100),false);
    const recovered=tasks.claim(m.id,"worker-b",1100,100);
    assert.equal(recovered?.id,first.id);
    assert.equal(tasks.complete(first.id,"worker-a",lease!.lease_generation,true,1101),false);
    assert.equal(tasks.heartbeat(first.id,"worker-b",recovered!.lease_generation,1150,100),true);
    assert.equal(tasks.complete(first.id,"worker-b",recovered!.lease_generation,true,1200),true);
    const next=tasks.claim(m.id,"worker-b",1201,100);
    assert.equal(next?.id,second.id);
    assert.equal(tasks.complete(second.id,"worker-b",next!.lease_generation,true,1250),true);
    assert.equal(tasks.claim(m.id,"worker-c",1251),undefined);
    db.close();store.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("cross-mission dependency rejected",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-deps-"));
  try{
    const store=new MissionStore(join(dir,"db.sqlite"));
    const db=new Database(join(dir,"db.sqlite"));const tasks=new TaskScheduler(db);
    const a=store.create("A"),b=store.create("B");
    const task=tasks.add(a.id,"first");
    assert.throws(()=>tasks.add(b.id,"second",[task.id]),/Dependency/);
    db.close();store.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("lease timestamps reject non-integer, negative and overflowing values",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-lease-bounds-"));
  const path=join(dir,"missions.db");
  const store=new MissionStore(path);
  const db=new Database(path);
  try {
    const mission=store.create("Lease bounds");
    store.transition(mission.code,"PLANNING");
    store.transition(mission.code,"READY");
    store.transition(mission.code,"RUNNING");
    const tasks=new TaskScheduler(db);
    const task=tasks.add(mission.id,"safe claim");
    for(const [now,ttl] of [[NaN,100],[-1,100],[1.5,100],[100,0],[100,-1],
      [100,Infinity],[100,1.5],[Number.MAX_SAFE_INTEGER,1]]) {
      assert.throws(()=>tasks.claim(mission.id,"worker",now,ttl),/Invalid lease/);
    }
    const lease=tasks.claim(mission.id,"worker",100,100);
    assert.equal(lease?.id,task.id,"invalid attempts must not consume the task");
    for(const [now,ttl] of [[NaN,10],[-1,10],[150,Infinity],[150,0],
      [Number.MAX_SAFE_INTEGER,1]]) {
      assert.throws(()=>tasks.heartbeat(task.id,"worker",lease!.lease_generation,now,ttl),
        /Invalid lease/);
    }
    assert.throws(()=>tasks.complete(task.id,"worker",lease!.lease_generation,true,NaN),
      /Invalid completion timestamp/);
    assert.equal(tasks.heartbeat(task.id,"worker",lease!.lease_generation,150,100),true);
    assert.equal(tasks.complete(task.id,"worker",lease!.lease_generation,true,200),true);
  } finally {
    db.close();store.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
