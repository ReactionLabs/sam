import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { PreferenceStore } from "./preferences.js";
import { heartbeatJobs } from "./heartbeat.js";
import { minis, spawnMini, removeMini } from "./minis.js";

test("minis: spawn creates the profile, a bound welcome chat, and the registry entry",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-mini-"));
 try{
  const mini=spawnMini(root,{name:"alex",person:"Alex",instructions:"Help Alex plan training.",starterHeartbeat:true});
  assert.equal(mini.name,"alex");
  const db=new ChatStore(root);
  const profile=db.agents().find(a=>a.name==="alex");
  assert.ok(profile);
  const chats=db.list().filter(c=>c.agent_name==="alex");
  assert.equal(chats.length,1);
  assert.equal(chats[0].title,"Meet Alex");
  db.close();
  assert.equal(minis(root).length,1);
  const jobs=heartbeatJobs(root).filter(j=>j.profile==="alex");
  assert.equal(jobs.length,1);
  assert.throws(()=>spawnMini(root,{name:"alex",person:"Alex",instructions:"Again"}),/already exists/);
  assert.equal(removeMini(root,"alex"),true);
  assert.equal(minis(root).length,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("minis: law and connector scope never leak across minis",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-mini2-"));
 try{
  const cid="11111111-2222-4333-8444-555555555555";
  spawnMini(root,{name:"trader-j",person:"Johnny",instructions:"Watch the stack.",connectorId:cid});
  spawnMini(root,{name:"coach-k",person:"Kaylee",instructions:"Help patients book."});
  const prefs=new PreferenceStore(root);
  prefs.note("trader-j","Never trade on Fridays","rule","seed");
  assert.equal(prefs.lawsFor("trader-j").length,1);
  assert.equal(prefs.lawsFor("coach-k").length,0);
  prefs.close();
  const db=new ChatStore(root);
  assert.equal(db.agents().find(a=>a.name==="trader-j")?.connector_id,cid);
  assert.equal(db.agents().find(a=>a.name==="coach-k")?.connector_id,null);
  db.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
