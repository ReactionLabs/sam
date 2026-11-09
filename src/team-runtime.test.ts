import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { runResearchTeam } from "./team-runtime.js";
import type { ModelProvider,ConversationRequest } from "./model-conversation.js";

test("research and QA make three real isolated model calls and persist attributable exchange",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-team-runtime-"));
 let db:ChatStore|undefined;
 try{
  db=new ChatStore(root);const chat=db.create("Team run");db.close();db=undefined;
  const calls:ConversationRequest[]=[];
  const provider:ModelProvider={id:"stub",async complete(req){calls.push(req);return {provider:"stub",model:req.model,message:{role:"assistant",content:"Turn "+calls.length}};}};
  const members=[{name:"research",role:"Research"},{name:"qa",role:"QA"}];
  const result=await runResearchTeam(root,chat.id,"Compare two approaches",members,provider,"offline-test");
  assert.equal(result.summary,"Turn 3");
  assert.equal(calls.length,3);
  assert.equal(calls[0].messages[0].content.includes("research"),true);
  assert.equal(calls[1].messages[0].content.includes("qa"),true);
  assert.equal(calls[1].messages[1].content.includes("Turn 1"),true);
  db=new ChatStore(root);
  assert.deepEqual(db.events(chat.id).map(e=>e.agent),["sam","sam","sam","research","qa","sam"]);
  db.close();db=undefined;
  await assert.rejects(()=>runResearchTeam(root,chat.id,"test",[{name:"same",role:"A"},{name:"same",role:"B"}],provider,"offline-test"),/Invalid team/);
  assert.equal(calls.length,3);
 }finally{db?.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test("researcher chooses real read-only workspace tools and records audit events",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-team-tools-"));
 try{
  writeFileSync(join(root,"package.json"),'{"name":"sam-test"}');
  const store=new ChatStore(root);const chat=store.create("Tool run");store.close();
  let turn=0;
  const provider:ModelProvider & {completeToolTurn:(model:string,messages:import("./memory-tool.js").ToolMessage[],enabled:boolean,workspaceEnabled?:boolean)=>Promise<import("./memory-tool.js").ToolTurn>}={
   id:"stub",
   async complete(req){return {provider:"stub",model:req.model,message:{role:"assistant",content:"Review "+req.messages.length}};},
   async completeToolTurn(_model,messages,enabled,workspaceEnabled){
    assert.equal(workspaceEnabled,true);
    turn++;
    if(turn===1){
     assert.equal(enabled,true);
     return {content:null,tool_calls:[{id:"call1",type:"function",function:{name:"read_file",arguments:JSON.stringify({path:"package.json"})}}]};
    }
    assert.ok(messages.some(m=>m.role==="tool"&&m.content.includes("sam-test")));
    return {content:"Verified package.json by tool"};
   }
  };
  const result=await runResearchTeam(root,chat.id,"Inspect package",[{name:"research",role:"Research"},{name:"qa",role:"QA"}],provider,"test-model",{agentTools:true});
  assert.equal(result.research,"Verified package.json by tool");
  const saved=new ChatStore(root);
  const events=saved.events(chat.id);
  assert.ok(events.some(e=>e.agent==="research"&&e.kind==="tool"&&e.content.includes("read_file")));
  assert.ok(events.some(e=>e.agent==="research"&&e.kind==="result"&&e.content.includes("completed")));
  saved.close();
 }finally{rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
