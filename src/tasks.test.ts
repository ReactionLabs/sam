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

test("heartbeat cannot extend a lease while mission is paused or cancelled",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-heartbeat-gate-"));
  const path=join(dir,"missions.db");
  const store=new MissionStore(path);
  const db=new Database(path);
  try {
    const mission=store.create("Mission gate");
    store.transition(mission.code,"PLANNING");
    store.transition(mission.code,"READY");
    store.transition(mission.code,"RUNNING");
    const tasks=new TaskScheduler(db);
    const task=tasks.add(mission.id,"Do work");
    const lease=tasks.claim(mission.id,"worker",1000,1000)!;
    assert.equal(lease.id,task.id);
    store.transition(mission.code,"PAUSING");
    assert.equal(tasks.heartbeat(task.id,"worker",lease.lease_generation,1100,1000),false);
    assert.equal(tasks.list(mission.id)[0].lease_expires_at,2000,"rejected heartbeat must not mutate expiry");
    store.transition(mission.code,"PAUSED");
    assert.equal(tasks.heartbeat(task.id,"worker",lease.lease_generation,1200,1000),false);
    store.transition(mission.code,"RUNNING");
    assert.equal(tasks.heartbeat(task.id,"worker",lease.lease_generation,1300,1000),true);
    assert.equal(tasks.list(mission.id)[0].lease_expires_at,2300);
    store.transition(mission.code,"CANCELLED");
    assert.equal(tasks.heartbeat(task.id,"worker",lease.lease_generation,1400,1000),false);
    assert.equal(tasks.list(mission.id)[0].lease_expires_at,2300);
  } finally {
    db.close();store.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test("heartbeat never shortens an existing lease and stale workers cannot complete",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-lease-monotonic-"));
  const path=join(dir,"missions.db");
  const store=new MissionStore(path);
  const db=new Database(path);
  try {
    const mission=store.create("Monotonic leases");
    store.transition(mission.code,"PLANNING");
    store.transition(mission.code,"READY");
    store.transition(mission.code,"RUNNING");
    const tasks=new TaskScheduler(db);
    const task=tasks.add(mission.id,"Execute safely");
    const first=tasks.claim(mission.id,"worker-a",1000,1000)!;
    assert.equal(first.lease_expires_at,2000);
    assert.equal(tasks.heartbeat(task.id,"worker-a",first.lease_generation,1100,100),false);
    assert.equal(tasks.heartbeat(task.id,"worker-a",first.lease_generation,1100,900),false);
    assert.equal(tasks.list(mission.id)[0].lease_expires_at,2000);
    assert.equal(tasks.heartbeat(task.id,"worker-a",first.lease_generation,1200,1000),true);
    assert.equal(tasks.list(mission.id)[0].lease_expires_at,2200);
    assert.equal(tasks.claim(mission.id,"worker-b",2200,1000)?.lease_generation,first.lease_generation+1);
    assert.equal(tasks.heartbeat(task.id,"worker-a",first.lease_generation,2201,1000),false);
    assert.equal(tasks.complete(task.id,"worker-a",first.lease_generation,true,2201),false);
    assert.equal(tasks.complete(task.id,"worker-b",first.lease_generation+1,true,2201),true);
  } finally {
    db.close();store.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test("paused and cancelled missions reject completion without mutating task",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-complete-gate-"));
  const path=join(dir,"missions.db");
  const store=new MissionStore(path);
  const db=new Database(path);
  try {
    const mission=store.create("Completion gate");
    store.transition(mission.code,"PLANNING");
    store.transition(mission.code,"READY");
    store.transition(mission.code,"RUNNING");
    const tasks=new TaskScheduler(db);
    const task=tasks.add(mission.id,"Guard completion");
    const lease=tasks.claim(mission.id,"worker",1000,1000)!;
    store.transition(mission.code,"PAUSING");
    assert.equal(tasks.complete(task.id,"worker",lease.lease_generation,true,1100),false);
    store.transition(mission.code,"PAUSED");
    assert.equal(tasks.complete(task.id,"worker",lease.lease_generation,true,1200),false);
    assert.equal(tasks.list(mission.id)[0].status,"LEASED");
    store.transition(mission.code,"RUNNING");
    assert.equal(tasks.complete(task.id,"worker",lease.lease_generation,true,1300),true);
    assert.equal(tasks.list(mission.id)[0].status,"SUCCEEDED");
  } finally {
    db.close();store.close();
    rmSync(dir,{recursive:true,force:true});
  }
});


test("cancelled and failed missions fence completion without mutating the lease",()=>{
  for(const terminal of ["CANCELLED","FAILED"] as const) {
    const dir=mkdtempSync(join(tmpdir(),"sam-terminal-fence-"));
    const path=join(dir,"missions.db");
    const store=new MissionStore(path);
    const db=new Database(path);
    try {
      const mission=store.create("Terminal fence "+terminal);
      store.transition(mission.code,"PLANNING");
      store.transition(mission.code,"READY");
      store.transition(mission.code,"RUNNING");
      const tasks=new TaskScheduler(db);
      const task=tasks.add(mission.id,"Do not complete after termination");
      const lease=tasks.claim(mission.id,"worker",1000,1000)!;
      store.transition(mission.code,terminal);
      const before=tasks.list(mission.id)[0];
      assert.equal(tasks.complete(task.id,"worker",lease.lease_generation,true,1100),false);
      assert.equal(tasks.complete(task.id,"worker",lease.lease_generation,false,1100),false);
      assert.equal(tasks.heartbeat(task.id,"worker",lease.lease_generation,1100,1000),false);
      assert.deepEqual(tasks.list(mission.id)[0],before,"rejected actions must not mutate task");
      assert.equal(tasks.claim(mission.id,"other-worker",2000,1000),undefined);
    } finally {
      db.close();store.close();
      rmSync(dir,{recursive:true,force:true});
    }
  }
});

test("expired lease cannot complete until a new generation is claimed",()=>{
  const dir=mkdtempSync(join(tmpdir(),"sam-expired-complete-"));
  const path=join(dir,"missions.db");
  const store=new MissionStore(path);
  const db=new Database(path);
  try {
    const mission=store.create("Expired completion");
    store.transition(mission.code,"PLANNING");
    store.transition(mission.code,"READY");
    store.transition(mission.code,"RUNNING");
    const tasks=new TaskScheduler(db);
    const task=tasks.add(mission.id,"Complete with current lease only");
    const old=tasks.claim(mission.id,"worker-a",1000,100)!;
    assert.equal(tasks.complete(task.id,"worker-a",old.lease_generation,true,1100),false);
    assert.equal(tasks.list(mission.id)[0].status,"LEASED");
    const fresh=tasks.claim(mission.id,"worker-b",1100,100)!;
    assert.equal(fresh.lease_generation,old.lease_generation+1);
    assert.equal(tasks.complete(task.id,"worker-a",old.lease_generation,true,1101),false);
    assert.equal(tasks.complete(task.id,"worker-b",fresh.lease_generation,true,1101),true);
  } finally {
    db.close();store.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
