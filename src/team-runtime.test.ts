import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync } from "node:fs";
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
