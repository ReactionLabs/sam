import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnMini } from "./minis.js";
import { issueDoorKey, disableDoor, doorForKey, doorHomeLink, peekSessionChat, sessionChat, RateLimiter, miniDoorPage } from "./mini-door.js";

test("mini door: keys resolve to exactly one mini, rotation kills the old key",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-door-"));
 try{
  spawnMini(root,{name:"alex",person:"Alex <b>",instructions:"Help Alex."});
  const key=issueDoorKey(root,"alex");
  assert.equal(doorForKey(root,key),"alex");
  assert.equal(doorForKey(root,"0".repeat(32)),null);
  assert.equal(doorForKey(root,"not-a-key"),null);
  const rotated=issueDoorKey(root,"alex");
  assert.equal(doorForKey(root,key),null);
  assert.equal(doorForKey(root,rotated),"alex");
  disableDoor(root,"alex");
  assert.equal(doorForKey(root,rotated),null);
  const page=miniDoorPage("Alex <b>","alex");
  assert.match(page,/Alex &lt;b&gt;'s SAM/);
  assert.doesNotMatch(page,/Alex <b>/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("mini door: a session keeps one chat, and the limiter trips on floods",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-door2-"));
 try{
  spawnMini(root,{name:"alex",person:"Alex",instructions:"Help Alex."});
  let created=0;const make=()=>"chat-"+(++created);
  const session="session-1234567890";
  assert.equal(sessionChat(root,"alex",session,make),"chat-1");
  assert.equal(sessionChat(root,"alex",session,make),"chat-1");
  assert.equal(sessionChat(root,"alex","session-abcdefghij",make),"chat-2");
  const limiter=new RateLimiter(3,60000,0);
  assert.equal(limiter.allow("s",1000),true);
  assert.equal(limiter.allow("s",1001),true);
  assert.equal(limiter.allow("s",1002),true);
  assert.equal(limiter.allow("s",1003),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("mini door: the core can hold a door, and the home-link flag rides the record",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-door3-"));
 try{
  spawnMini(root,{name:"alex",person:"Alex",instructions:"Help Alex."});
  const coreKey=issueDoorKey(root,"sam",{homeLink:true});
  assert.equal(doorForKey(root,coreKey),"sam");
  assert.equal(doorHomeLink(root,coreKey),true);
  const miniKey=issueDoorKey(root,"alex");
  assert.equal(doorHomeLink(root,miniKey),false);
  assert.equal(peekSessionChat(root,"alex","session-1234567890"),null);
 }finally{rmSync(root,{recursive:true,force:true});}
});
