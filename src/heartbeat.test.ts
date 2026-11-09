import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { addHeartbeatJob, consolidatePreferences, heartbeatLog, heartbeatOutputHash, normalizeHeartbeatOutput, runHeartbeat } from "./heartbeat.js";
import { PreferenceStore } from "./preferences.js";
import { readActivity } from "./activity.js";

test("heartbeat consolidation learns from chats once, then promotes earned law",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-hb-"));
 try{
  const db=new ChatStore(root);
  const chat=db.create("Desk","trading");
  db.add(chat.id,"user","I like short answers");
  db.add(chat.id,"assistant","Noted.");
  db.add(chat.id,"user","I like short answers");
  db.close();
  const first=consolidatePreferences(root);
  assert.equal(first.scanned,2);
  assert.equal(first.noted,2);
  const second=consolidatePreferences(root);
  assert.equal(second.scanned,0);
  const db2=new ChatStore(root);
  db2.add(chat.id,"user","I like short answers");
  db2.close();
  const third=consolidatePreferences(root);
  assert.deepEqual(third.promoted,["trading: short answers"]);
  const prefs=new PreferenceStore(root);
  assert.equal(prefs.lawsFor("trading").length,1);
  prefs.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("heartbeat runs a due job once through the injected turn runner",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-hb2-"));
 try{
  addHeartbeatJob(root,"stack watch",15,"trading","Check the stack");
  const turns:string[]=[];
  const deps={ensureChat:async()=>"hb-chat",runTurn:async(_id:string,content:string)=>{turns.push(content);return "All quiet.";}};
  const first=await runHeartbeat(root,deps);
  assert.deepEqual(first.ran,["stack watch"]);
  assert.deepEqual(turns,["Check the stack"]);
  const second=await runHeartbeat(root,deps);
  assert.deepEqual(second.ran,[]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("heartbeat output normalization ignores rephrasing chrome but not fact changes",()=>{
 const a="- Candidates total: **282,966**\n- Newest candidate: **2026-11-04T22:45:59.894Z** - the stack is still frozen.\n- ALERT verdict count: **9**";
 const b="Candidates total: 282,966\nNewest candidate: 2026-11-04T22:45:59.894Z - THE STACK IS STILL FROZEN\nALERT verdict count: 9\nSnapshot as_of: 2026-11-09T03:46:20Z";
 assert.equal(heartbeatOutputHash(a),heartbeatOutputHash(b));
 assert.equal(normalizeHeartbeatOutput("**All** `quiet.`"),"all quiet");
 const changed="- Candidates total: **282,967**\n- Newest candidate: **2026-11-04T22:45:59.894Z** - the stack is still frozen.\n- ALERT verdict count: **9**";
 assert.notEqual(heartbeatOutputHash(a),heartbeatOutputHash(changed));
});

function makeJobDue(root:string){
 const path=join(root,".sam","heartbeat-jobs.json");
 const jobs=JSON.parse(readFileSync(path,"utf8")) as Array<Record<string,unknown>>;
 for(const job of jobs)job.lastRun="2000-01-01T00:00:00.000Z";
 writeFileSync(path,JSON.stringify(jobs,null,2));
}

test("heartbeat diffing: unchanged output stays silent, changed output delivers and lands in the activity ledger",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-hb3-"));
 try{
  addHeartbeatJob(root,"stack watch",30,"trading","Check the stack","chan-1");
  const deliveries:string[]=[];
  let reply="- Candidates total: **282,966**\n- ALERT verdict count: **9**";
  const deps={ensureChat:async()=>"hb-chat",runTurn:async()=>reply,deliver:async(_id:string,text:string)=>{deliveries.push(text);}};
  const first=await runHeartbeat(root,deps);
  assert.deepEqual(first.changed,["stack watch"]);
  assert.deepEqual(first.unchanged,[]);
  assert.equal(deliveries.length,1);
  assert.equal(readActivity(root,50).filter(a=>a.kind==="heartbeat").length,1);
  // Same facts, fresh chrome and a fresh snapshot line: silence.
  reply="Candidates total: 282,966\nALERT verdict count: 9\nSnapshot as_of: 2026-11-09T04:16:20Z";
  makeJobDue(root);
  const second=await runHeartbeat(root,deps);
  assert.deepEqual(second.ran,["stack watch"]);
  assert.deepEqual(second.changed,[]);
  assert.deepEqual(second.unchanged,["stack watch"]);
  assert.equal(deliveries.length,1);
  assert.equal(readActivity(root,50).filter(a=>a.kind==="heartbeat").length,1);
  const silent=heartbeatLog(root,50).filter(e=>e.type==="job-unchanged");
  assert.equal(silent.length,1);
  assert.equal(silent[0].name,"stack watch");
  // A real fact change announces itself again.
  reply="- Candidates total: **283,001**\n- ALERT verdict count: **10**";
  makeJobDue(root);
  const third=await runHeartbeat(root,deps);
  assert.deepEqual(third.changed,["stack watch"]);
  assert.equal(deliveries.length,2);
  assert.equal(readActivity(root,50).filter(a=>a.kind==="heartbeat").length,2);
  const state=JSON.parse(readFileSync(join(root,".sam","heartbeat-state.json"),"utf8")) as {outputs:Record<string,{hash:string}>};
  assert.equal(Object.values(state.outputs)[0].hash,heartbeatOutputHash(reply));
 }finally{rmSync(root,{recursive:true,force:true});}
});
