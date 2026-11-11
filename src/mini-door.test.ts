import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnMini } from "./minis.js";
import { issueDoorKey, disableDoor, doorForKey, doorHomeLink, listDoors, peekSessionChat, sessionChat, RateLimiter, miniDoorPage } from "./mini-door.js";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

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

test("mini door: new keys are 256-bit with a 30-day expiry, and the audit shows both",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-door4-"));
 try{
  spawnMini(root,{name:"alex",person:"Alex",instructions:"Help Alex."});
  const key=issueDoorKey(root,"alex");
  assert.match(key,/^[0-9a-f]{64}$/);
  assert.equal(doorForKey(root,key),"alex");
  const audit=listDoors(root);
  assert.equal(audit.length,1);
  assert.equal(audit[0].keyVersion,2);
  assert.equal(audit[0].expired,false);
  assert.equal(Date.parse(audit[0].expires_at)-Date.parse(audit[0].created_at),30*86400000);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("mini door: legacy 128-bit keys still resolve inside their TTL and die at it",()=>{
  // Each scenario is its own install: a legacy file is a migration
  // fixture, imported once on first read (UNIFICATION item 4,
  // thirteenth store), so a second direct write in the same root
  // would no longer be the store's shape.
  const legacy="a".repeat(32);
  const hash=createHash("sha256").update(legacy).digest("hex");
  const scenario=(createdAt:string,expiresAt?:string)=>{
    const root=mkdtempSync(join(tmpdir(),"sam-door5-"));
    try{
      spawnMini(root,{name:"alex",person:"Alex",instructions:"Help Alex."});
      mkdirSync(join(root,".sam"),{recursive:true});
      writeFileSync(join(root,".sam","mini-doors.json"),JSON.stringify({doors:[{mini:"alex",keyHash:hash,enabled:true,created_at:createdAt,...(expiresAt?{expires_at:expiresAt}:{})}],sessions:[]}));
      return root;
    }catch(error){rmSync(root,{recursive:true,force:true});throw error;}
  };
  // A pre-expiry-era record (no expires_at) resolves while it is young...
  let root=scenario(new Date().toISOString());
  try{
    assert.equal(doorForKey(root,legacy),"alex");
    assert.equal(listDoors(root)[0].keyVersion,1);
  }finally{rmSync(root,{recursive:true,force:true});}
  // ...and is dead 31 days after issue even though it was never disabled.
  root=scenario(new Date(Date.now()-31*86400000).toISOString());
  try{
    assert.equal(doorForKey(root,legacy),null);
    assert.equal(listDoors(root)[0].expired,true);
  }finally{rmSync(root,{recursive:true,force:true});}
  // An explicit expires_at in the past kills a young record too.
  root=scenario(new Date().toISOString(),new Date(Date.now()-1000).toISOString());
  try{
    assert.equal(doorForKey(root,legacy),null);
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

test("mini door page: copy path has the iOS fallback and honest feedback (defect 2026-11-09 18:00)",()=>{
  const page=miniDoorPage("Dip","dip");
  assert.match(page,/function fallbackCopyText\(text\)/);
  assert.match(page,/ta\.readOnly=true/);
  assert.match(page,/ta\.setSelectionRange\(0,text\.length\)/);
  assert.match(page,/ok=document\.execCommand\("copy"\)/);
  assert.match(page,/Long-press text to copy/);
  assert.doesNotMatch(page,/catch\(e\)\{\}c\.textContent="Copied"/);
  assert.match(page,/\.copy\{[^}]*min-height:36px/);
});
