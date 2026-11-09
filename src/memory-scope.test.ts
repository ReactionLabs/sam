import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { MemoryStore } from "./memory.js";
import { createLink, visibleScopes } from "./links.js";
import { recallMemory } from "./memory-recall.js";

function seeded(){
 const root=mkdtempSync(join(tmpdir(),"sam-scope-"));
 const db=new ChatStore(root);
 db.createAgent("alex","Help Alex.");db.createAgent("blair","Help Blair.");db.createAgent("casey","Help Casey.");
 db.close();
 const memPath=join(root,".sam","memory.db");
 const store=new MemoryStore(memPath);
 store.add({kind:"observation",content:"core fact about the operation",source:"test"});
 store.add({kind:"observation",content:"alex private note about training",source:"test",scope:"profile:alex"});
 store.add({kind:"observation",content:"blair private note about patients",source:"test",scope:"profile:blair"});
 store.close();
 return {root,memPath};
}

test("memory levels: scoped search and list keep profiles blind to each other",()=>{
 const {root,memPath}=seeded();
 try{
  const link=createLink(root,"alex-blair",["alex","blair"]);
  const store=new MemoryStore(memPath);
  store.add({kind:"decision",content:"shared plan for the weekend project",source:"test",scope:"link:"+link.id});
  const alexScopes=visibleScopes(root,"alex");
  assert.deepEqual(alexScopes,["profile:alex","link:"+link.id]);
  assert.deepEqual(visibleScopes(root,"casey"),["profile:casey"]);
  assert.deepEqual(visibleScopes(root,"sam"),["core"]);
  const alexHits=store.search("note",20,alexScopes).map(r=>r.content);
  assert.ok(alexHits.some(c=>c.includes("alex private")));
  assert.ok(!alexHits.some(c=>c.includes("blair private")));
  assert.ok(!alexHits.some(c=>c.includes("core fact")));
  const shared=store.search("shared plan",20,visibleScopes(root,"blair"));
  assert.equal(shared.length,1);
  const caseyShared=store.search("shared plan",20,visibleScopes(root,"casey"));
  assert.equal(caseyShared.length,0);
  const coreList=store.list(undefined,["core"]);
  assert.equal(coreList.length,1);
  assert.equal(coreList[0].scope,"core");
  store.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("scoped recall: a profile recalls its own level and its links, never another profile",()=>{
 const {root,memPath}=seeded();
 try{
  createLink(root,"alex-blair",["alex","blair"]);
  const alexRecall=recallMemory(memPath,10,"alex");
  assert.ok(alexRecall);
  assert.match(alexRecall!.content,/alex private note/);
  assert.doesNotMatch(alexRecall!.content,/blair private note/);
  assert.doesNotMatch(alexRecall!.content,/core fact/);
  const coreRecall=recallMemory(memPath,10,"sam");
  assert.match(coreRecall!.content,/core fact/);
  assert.doesNotMatch(coreRecall!.content,/alex private note/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
