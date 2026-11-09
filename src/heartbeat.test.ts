import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { addHeartbeatJob, consolidatePreferences, runHeartbeat } from "./heartbeat.js";
import { PreferenceStore } from "./preferences.js";

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
