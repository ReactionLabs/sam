import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { MemoryStore } from "./memory.js";
import { createLink } from "./links.js";
import { executeOwnTool, ownToolsChat } from "./own-tools.js";
import { readActivity } from "./activity.js";
import type { OpenAICompatibleProvider } from "./openai-compatible.js";

test("own tools: memory search is fenced to the acting profile's levels",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-own-"));
 try{
  const db=new ChatStore(root);db.createAgent("alex","A.");db.createAgent("blair","B.");db.close();
  const mem=new MemoryStore(join(root,".sam","missions.db"));
  mem.add({kind:"observation",content:"alex training block is mornings",source:"t",scope:"profile:alex"});
  mem.add({kind:"observation",content:"blair clinic opens at nine",source:"t",scope:"profile:blair"});
  mem.add({kind:"observation",content:"core routing table lives here",source:"t"});
  mem.close();
  const asAlex=executeOwnTool(root,"alex","sam_memory_search",{query:"training"}) as {records:Array<{content:string}>};
  assert.equal(asAlex.records.length,1);
  const asAlexCore=executeOwnTool(root,"alex","sam_memory_search",{query:"routing"}) as {records:unknown[]};
  assert.equal(asAlexCore.records.length,0);
  const asCore=executeOwnTool(root,"sam","sam_memory_search",{query:"routing"}) as {records:unknown[]};
  assert.equal(asCore.records.length,1);
  const link=createLink(root,"ab",["alex","blair"]);
  const mem2=new MemoryStore(join(root,".sam","missions.db"));
  mem2.add({kind:"decision",content:"shared launch date is friday",source:"t",scope:"link:"+link.id});
  mem2.close();
  const shared=executeOwnTool(root,"blair","sam_memory_search",{query:"launch"}) as {records:unknown[]};
  assert.equal(shared.records.length,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("own tools: workspace reads are confined and secrets are refused",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-own2-"));
 try{
  mkdirSync(join(root,"notes"),{recursive:true});
  writeFileSync(join(root,"notes","plan.md"),"the plan is simple");
  writeFileSync(join(root,"sam.env"),"SECRET=1");
  writeFileSync(join(root,"blob.bin"),Buffer.from([0,1,2,0]));
  const read=executeOwnTool(root,"sam","sam_workspace_read",{path:"notes/plan.md"}) as {content:string};
  assert.match(read.content,/the plan/);
  assert.deepEqual(executeOwnTool(root,"sam","sam_workspace_read",{path:"../outside.md"}),{error:"Path not available"});
  assert.deepEqual(executeOwnTool(root,"sam","sam_workspace_read",{path:"sam.env"}),{error:"That file is not readable"});
  assert.deepEqual(executeOwnTool(root,"sam","sam_workspace_read",{path:"blob.bin"}),{error:"Binary file"});
  const list=executeOwnTool(root,"sam","sam_workspace_list",{path:"."}) as {entries:Array<{name:string}>};
  assert.ok(!list.entries.some(e=>e.name==="sam.env"));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("own tools: the loop executes a memory search and answers from it",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-own3-"));
 try{
  const mem=new MemoryStore(join(root,".sam","missions.db"));
  mem.add({kind:"observation",content:"the vault code word is otter",source:"t"});
  mem.close();
  let step=0;
  const fake={
   async completeConnectorTurn(_model:string,messages:Array<Record<string,unknown>>,tools:unknown[]){
    step++;
    if(step===1)return {content:null,calls:[{id:"c1",name:"sam_memory_search",args:{query:"vault"}}]};
    const toolMsg=messages.find(m=>m.role==="tool");
    assert.ok(toolMsg&&String(toolMsg.content).includes("otter"));
    return {content:"The code word is otter, per stored memory.",calls:[]};
   }
  } as unknown as OpenAICompatibleProvider;
  const reply=await ownToolsChat(root,"sam",fake,"test-model",[{role:"user",content:"what is the vault code word?"}]);
  assert.match(reply,/otter/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("own tools: budget exhaustion stubs extra calls, answers from partial results, and logs the spend",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-own-budget-"));
 try{
  let step=0;
  const fake={
   async completeConnectorTurn(_model:string,messages:Array<Record<string,unknown>>,tools:unknown[]){
    step++;
    if(step===1)return {content:null,calls:[{id:"c1",name:"sam_memory_list",args:{}},{id:"c2",name:"sam_memory_list",args:{}},{id:"c3",name:"sam_memory_list",args:{}}]};
    // Synthesis step (tool-free): the transcript must be valid - every
    // tool_call answered - and the stub must say the budget ran out.
    const calledIds=messages.flatMap(m=>Array.isArray(m.tool_calls)?(m.tool_calls as Array<{id:string}>).map(c=>c.id):[]);
    const answeredIds=new Set(messages.filter(m=>m.role==="tool").map(m=>String(m.tool_call_id)));
    assert.deepEqual(calledIds.sort(),[...answeredIds].sort());
    const stub=messages.find(m=>m.role==="tool"&&String(m.content).includes("Tool budget exhausted"));
    assert.ok(stub,"the unexecuted call must be stubbed with the budget note");
    return {content:"Partial answer from the two lists I did read.",calls:[]};
   }
  } as unknown as OpenAICompatibleProvider;
  const reply=await ownToolsChat(root,"sam",fake,"test-model",[{role:"user",content:"list everything"}],undefined,undefined,{rounds:3,maxCalls:2});
  assert.equal(reply,"Partial answer from the two lists I did read.");
  const logged=readActivity(root,10,{kind:"tool-budget"});
  assert.equal(logged.length,1);
  assert.match(logged[0].summary,/2\/2 calls used/);
  assert.match(logged[0].summary,/sam_memory_list/);
  assert.match(logged[0].summary,/not executed: sam_memory_list/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
