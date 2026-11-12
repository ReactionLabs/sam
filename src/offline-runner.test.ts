import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import {MissionStore} from "./storage.js";
import {TaskScheduler} from "./tasks.js";
import {OfflineMissionRunner} from "./offline-runner.js";
import {LocalEchoAdapter,type ExecutionAdapter} from "./execution.js";

function fixture(fn:(db:Database.Database,store:MissionStore,tasks:TaskScheduler,runner:OfflineMissionRunner)=>Promise<void>) {
  return async()=>{
    const dir=mkdtempSync(join(tmpdir(),"sam-runner-"));
    const path=join(dir,"missions.db"),store=new MissionStore(path),db=openDatabase(path);
    db.pragma("foreign_keys = ON");
    const tasks=new TaskScheduler(db),runner=new OfflineMissionRunner(db);
    try { await fn(db,store,tasks,runner); }
    finally {db.close();store.close();rmSync(dir,{recursive:true,force:true});}
  };
}
test("offline task completes and verified result survives a new runner instance",fixture(async(db,store,tasks,runner)=>{
  const mission=store.create("offline");store.transition(mission.code,"PLANNING");store.transition(mission.code,"READY");
  const task=tasks.add(mission.id,"echo me");store.transition(mission.code,"RUNNING");
  const result=await runner.runOne(mission.id,"local-worker",new LocalEchoAdapter());
  assert.equal(result?.task_id,task.id);
  assert.equal(result?.output,"echo me");
  assert.equal(tasks.list(mission.id)[0].status,"SUCCEEDED");
  assert.deepEqual(new OfflineMissionRunner(db).result(task.id),result);
}));
test("tampered evidence is never stored or marked successful",fixture(async(_db,store,tasks,runner)=>{
  const mission=store.create("tamper");store.transition(mission.code,"PLANNING");store.transition(mission.code,"READY");
  const task=tasks.add(mission.id,"echo");store.transition(mission.code,"RUNNING");
  const adapter:ExecutionAdapter={id:"local-echo-test",async execute(req){
    return {...await new LocalEchoAdapter().execute(req),output:"tampered"};
  }};
  await assert.rejects(runner.runOne(mission.id,"worker",adapter),/Invalid execution evidence/);
  assert.equal(runner.result(task.id),undefined);
  assert.equal(tasks.list(mission.id)[0].status,"LEASED");
}));
test("rejects non-offline adapters before claiming",fixture(async(_db,store,tasks,runner)=>{
  const mission=store.create("safe");store.transition(mission.code,"PLANNING");store.transition(mission.code,"READY");
  tasks.add(mission.id,"echo");store.transition(mission.code,"RUNNING");
  await assert.rejects(runner.runOne(mission.id,"worker",{id:"remote",execute:async(req)=>new LocalEchoAdapter().execute(req)}),/offline/);
  assert.equal(tasks.list(mission.id)[0].status,"PENDING");
}));
test("expired lease cannot persist evidence or mark task complete",fixture(async(_db,store,tasks,runner)=>{
  const mission=store.create("expired");store.transition(mission.code,"PLANNING");store.transition(mission.code,"READY");
  const task=tasks.add(mission.id,"echo");store.transition(mission.code,"RUNNING");
  const adapter:ExecutionAdapter={id:"local-echo-test",async execute(req){
    const evidence=await new LocalEchoAdapter().execute(req);
    tasks.claim(mission.id,"replacement",Date.now()+60_000,30_000);
    return evidence;
  }};
  await assert.rejects(runner.runOne(mission.id,"worker",adapter),/Lease expired/);
  assert.equal(runner.result(task.id),undefined);
  assert.equal(tasks.list(mission.id)[0].lease_owner,"replacement");
}));


test("verified failure persists as FAILED and does not unlock dependent work",fixture(async(_db,store,tasks,runner)=>{
  const mission=store.create("failure");store.transition(mission.code,"PLANNING");store.transition(mission.code,"READY");
  const first=tasks.add(mission.id,"first");
  const dependent=tasks.add(mission.id,"dependent",[first.id]);
  store.transition(mission.code,"RUNNING");
  const adapter:ExecutionAdapter={id:"local-echo-test",async execute(req){
    return {...await new LocalEchoAdapter().execute(req),outcome:"FAILED"};
  }};
  const result=await runner.runOne(mission.id,"worker",adapter);
  assert.equal(result?.outcome,"FAILED");
  assert.equal(runner.result(first.id)?.outcome,"FAILED");
  assert.equal(tasks.list(mission.id).find(t=>t.id===first.id)?.status,"FAILED");
  assert.equal(tasks.list(mission.id).find(t=>t.id===dependent.id)?.status,"PENDING");
  assert.equal(await runner.runOne(mission.id,"worker",new LocalEchoAdapter()),undefined);
}));

test("mission pause during execution rejects completion and leaves no evidence",fixture(async(_db,store,tasks,runner)=>{
  const mission=store.create("pause during execution");
  store.transition(mission.code,"PLANNING");
  store.transition(mission.code,"READY");
  const task=tasks.add(mission.id,"echo");
  store.transition(mission.code,"RUNNING");
  const adapter:ExecutionAdapter={id:"local-echo-test",async execute(req){
    const evidence=await new LocalEchoAdapter().execute(req);
    store.transition(mission.code,"PAUSING");
    return evidence;
  }};
  await assert.rejects(runner.runOne(mission.id,"worker",adapter),/mission no longer running/);
  assert.equal(runner.result(task.id),undefined);
  assert.equal(tasks.list(mission.id)[0].status,"LEASED");
}));


test("mission cancellation during execution rejects completion and stores no evidence",fixture(async(_db,store,tasks,runner)=>{
  const mission=store.create("cancel during execution");
  store.transition(mission.code,"PLANNING");
  store.transition(mission.code,"READY");
  const task=tasks.add(mission.id,"echo");
  store.transition(mission.code,"RUNNING");
  const adapter:ExecutionAdapter={id:"local-echo-test",async execute(req){
    const evidence=await new LocalEchoAdapter().execute(req);
    store.transition(mission.code,"CANCELLED");
    return evidence;
  }};
  await assert.rejects(runner.runOne(mission.id,"worker",adapter),/mission no longer running/);
  assert.equal(runner.result(task.id),undefined);
  assert.equal(tasks.list(mission.id)[0].status,"LEASED");
  assert.equal(await runner.runOne(mission.id,"worker",new LocalEchoAdapter()),undefined);
}));

test("injected clock fences completion without consulting wall clock",fixture(async(db,store,tasks)=> {
  const mission=store.create("clock fence");store.transition(mission.code,"PLANNING");store.transition(mission.code,"READY");
  const task=tasks.add(mission.id,"echo");store.transition(mission.code,"RUNNING");
  let time=1_000;
  const runner=new OfflineMissionRunner(db,()=>time);
  const adapter:ExecutionAdapter={id:"local-echo-test",async execute(req){
    time=1_010;
    return {...await new LocalEchoAdapter().execute(req),completedAt:new Date(time).toISOString()};
  }};
  const result=await runner.runOne(mission.id,"worker",adapter,1_000,20);
  assert.equal(result?.task_id,task.id);
  assert.equal(tasks.list(mission.id)[0].status,"SUCCEEDED");
}));
test("expired injected lease rolls back evidence and task completion",fixture(async(db,store,tasks)=> {
  const mission=store.create("clock expiry");store.transition(mission.code,"PLANNING");store.transition(mission.code,"READY");
  const task=tasks.add(mission.id,"echo");store.transition(mission.code,"RUNNING");
  let time=1_000;
  const runner=new OfflineMissionRunner(db,()=>time);
  const adapter:ExecutionAdapter={id:"local-echo-test",async execute(req){
    time=1_021;
    return {...await new LocalEchoAdapter().execute(req),completedAt:new Date(time).toISOString()};
  }};
  await assert.rejects(runner.runOne(mission.id,"worker",adapter,1_000,20),/Lease expired/);
  assert.equal(runner.result(task.id),undefined);
  assert.equal(tasks.list(mission.id)[0].status,"LEASED");
}));
test("future or pre-claim evidence timestamps cannot persist",fixture(async(db,store,tasks)=> {
  for(const timestamp of [999,1_011]){
    const mission=store.create("invalid evidence time");store.transition(mission.code,"PLANNING");store.transition(mission.code,"READY");
    const task=tasks.add(mission.id,"echo");store.transition(mission.code,"RUNNING");
    let time=1_000;
    const runner=new OfflineMissionRunner(db,()=>time);
    const adapter:ExecutionAdapter={id:"local-echo-test",async execute(req){
      time=1_010;
      return {...await new LocalEchoAdapter().execute(req),completedAt:new Date(timestamp).toISOString()};
    }};
    await assert.rejects(runner.runOne(mission.id,"worker",adapter,1_000,20),/outside execution window/);
    assert.equal(runner.result(task.id),undefined);
    assert.equal(tasks.list(mission.id)[0].status,"LEASED");
  }
}));
