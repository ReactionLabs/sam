import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { MemoryStore } from "./memory.js";
import { createLink } from "./links.js";
import { executeOwnTool, ownToolsChat, ownToolsFor, skillCatalogForPrompt, SKILL_AUTO_SELECT_DIRECTIVE } from "./own-tools.js";
import { readActivity } from "./activity.js";
import { recentSkillUse, lastSkillByChat } from "./skill-use.js";
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

function seedSkill(root:string,name:string,description:string,body:string){
 const dir=join(root,".agents","skills",name);
 mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,"SKILL.md"),"---\nname: "+name+"\ndescription: "+description+"\n---\n"+body);
}

test("own tools: installed skills list and read in chat, refusals name their reason",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-own-skills-"));
 try{
  seedSkill(root,"agent-reach","Reach the public web","Step one: run the reach check.");
  seedSkill(root,"reporting","Write the weekly report","Use the three-part shape.");
  const list=executeOwnTool(root,"sam","sam_list_skills",{}) as {untrusted:boolean;skills:Array<{name:string;description:string}>};
  assert.equal(list.untrusted,true);
  assert.deepEqual(list.skills.map(s=>s.name),["agent-reach","reporting"]);
  // Metadata only: listing must not inline any skill's instructions.
  assert.ok(!JSON.stringify(list).includes("Step one"));
  const read=executeOwnTool(root,"sam","sam_read_skill",{name:"agent-reach"}) as {untrusted:boolean;instructions:string};
  assert.equal(read.untrusted,true);
  assert.match(read.instructions,/run the reach check/);
  // A traversal name and a missing skill refuse with their real reasons,
  // so the model can correct itself instead of hallucinating contents.
  assert.match((executeOwnTool(root,"sam","sam_read_skill",{name:"../.env"}) as {error:string}).error,/Invalid skill name/);
  assert.match((executeOwnTool(root,"sam","sam_read_skill",{name:"missing"}) as {error:string}).error,/Skill not found/);
  assert.match((executeOwnTool(root,"sam","sam_read_skill",{}) as {error:string}).error,/Invalid skill name/);
  // Both tools are in the definitions every chat turn is offered.
  const names=ownToolsFor(root).map(t=>(t as {function:{name:string}}).function.name);
  assert.ok(names.includes("sam_list_skills")&&names.includes("sam_read_skill"));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("own tools: the skill catalog rides the chat system prompt, names and descriptions only",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-own-catalog-"));
 try{
  // No skills installed: no catalog line, no error.
  assert.equal(skillCatalogForPrompt(root),"");
  seedSkill(root,"agent-reach","Reach the public web","SECRET-BODY-TEXT");
  const line=skillCatalogForPrompt(root);
  assert.match(line,/agent-reach: Reach the public web/);
  assert.match(line,/sam_read_skill/);
  assert.ok(!line.includes("SECRET-BODY-TEXT"),"the catalog must never inline instructions");
  let step=0;
  const fake={
   async completeConnectorTurn(_model:string,messages:Array<Record<string,unknown>>,tools:Array<{function?:{name?:string}}>){
    step++;
    if(step===1){
     // The turn is offered the read tool and told the catalog up front.
     assert.ok(tools.some(t=>t.function?.name==="sam_read_skill"));
     const system=messages.find(m=>m.role==="system");
     assert.ok(system&&String(system.content).includes("agent-reach: Reach the public web"));
     return {content:null,calls:[{id:"c1",name:"sam_read_skill",args:{name:"agent-reach"}}]};
    }
    const toolMsg=messages.find(m=>m.role==="tool");
    assert.ok(toolMsg&&String(toolMsg.content).includes("SECRET-BODY-TEXT"));
    assert.ok(toolMsg&&String(toolMsg.content).includes('"untrusted":true'));
    return {content:"Read it.",calls:[]};
   }
  } as unknown as OpenAICompatibleProvider;
  const reply=await ownToolsChat(root,"sam",fake,"test-model",[{role:"user",content:"use the reach skill"}]);
  assert.equal(reply,"Read it.");
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("own tools: the catalog carries the auto-selection directive, and only when a skill is installed",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-own-autoselect-"));
 try{
  // No skills installed: no catalog, and no directive either - there is
  // nothing to select, so the prompt must not talk about selecting.
  assert.equal(skillCatalogForPrompt(root),"");
  seedSkill(root,"agent-reach","Reach the public web","SECRET-BODY-TEXT");
  const line=skillCatalogForPrompt(root);
  // The directive is the ruling in prompt form: never name a skill, match
  // the task to a description, read BEFORE acting, announce the skill.
  assert.ok(line.includes(SKILL_AUTO_SELECT_DIRECTIVE));
  assert.match(line,/never has to name a skill/);
  assert.match(line,/matches an installed skill's description/);
  assert.match(line,/BEFORE you start the task/);
  assert.match(line,/say in your reply which skill you are using/);
  // The directive sits ahead of the entries, so the length cap keeps it.
  assert.ok(line.indexOf("Skill auto-selection")<line.indexOf("agent-reach: Reach the public web"));
  assert.ok(!line.includes("SECRET-BODY-TEXT"),"the catalog must never inline instructions");
  // The read tool's own description carries the same unprompted rule.
  const readDef=ownToolsFor(root).find(t=>(t as {function:{name:string}}).function.name==="sam_read_skill") as {function:{description:string}};
  assert.match(readDef.function.description,/read it unprompted/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("own tools: a task matching a skill description triggers the read with no skill named, and the reply announces it",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-own-autoselect-flow-"));
 try{
  seedSkill(root,"agent-reach","Reach the public web","Step one: run the reach check.");
  seedSkill(root,"reporting","Write the weekly report","Use the three-part shape.");
  // A directive-following model, simulated: it reads the system message,
  // and when the owner's task matches a catalog description it reads that
  // skill first - the owner never names any skill in either task below.
  const fake={
   async completeConnectorTurn(_model:string,messages:Array<Record<string,unknown>>,tools:Array<{function?:{name?:string}}>){
    const system=messages.find(m=>m.role==="system");
    assert.ok(system&&String(system.content).includes("Skill auto-selection"),"the directive must ride the turn's system prompt");
    const toolMsg=messages.find(m=>m.role==="tool");
    if(toolMsg){
     // The read landed: instructions arrived framed as untrusted data.
     assert.ok(String(toolMsg.content).includes("run the reach check"));
     assert.ok(String(toolMsg.content).includes('"untrusted":true'));
     return {content:"Using the agent-reach skill for this. Here is what people are saying.",calls:[]};
    }
    const user=[...messages].reverse().find(m=>m.role==="user");
    const task=String(user?.content??"");
    if(/public web/.test(task)&&tools.some(t=>t.function?.name==="sam_read_skill")){
     return {content:null,calls:[{id:"c1",name:"sam_read_skill",args:{name:"agent-reach"}}]};
    }
    return {content:"Done, no skill needed.",calls:[]};
   }
  } as unknown as OpenAICompatibleProvider;
  // Matching task, no skill named by the owner: the read fires and the
  // final reply announces the skill it used.
  const matched=await ownToolsChat(root,"sam",fake,"test-model",[{role:"user",content:"check the public web for what people are saying about the launch"}]);
  assert.match(matched,/Using the agent-reach skill/);
  // Non-matching task: no read is forced and no skill is announced.
  const plain=await ownToolsChat(root,"sam",fake,"test-model",[{role:"user",content:"what time is it in Tampa"}]);
  assert.equal(plain,"Done, no skill needed.");
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("own tools: budget exhaustion stubs extra calls, answers from partial results, and logs the spend",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-own-budget-"));
 try{
  let step=0;
  const fake={
   async completeConnectorTurn(_model:string,messages:Array<Record<string,unknown>>,tools:unknown[]){
    step++;
    // Distinct calls on purpose: since duplicate suppression
    // (2026-11-14) an identical repeat returns the earlier result
    // instead of executing, so a budget test varies the calls to
    // keep the call budget itself the binding constraint.
    if(step===1)return {content:null,calls:[{id:"c1",name:"sam_memory_list",args:{}},{id:"c2",name:"sam_memory_search",args:{query:"a"}},{id:"c3",name:"sam_memory_search",args:{query:"b"}}]};
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
  assert.match(logged[0].summary,/not executed: sam_memory_search/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("own tools: a model skill read is ledgered as skill use; a refused read is not", () => {
 const root = mkdtempSync(join(tmpdir(), "sam-own-skilluse-"));
 try {
  seedSkill(root, "agent-reach", "Reach the public web", "Step one: run the reach check.");
  const db = new ChatStore(root); const chat = db.create("Working"); db.close();
  const read = executeOwnTool(root, "sam", "sam_read_skill", { name: "agent-reach" }, chat.id) as { name?: string };
  assert.equal(read.name, "agent-reach");
  const uses = recentSkillUse(root, 10);
  assert.equal(uses.length, 1);
  assert.equal(uses[0].skill, "agent-reach");
  assert.equal(uses[0].chatId, chat.id);
  assert.equal(lastSkillByChat(root).get(chat.id)?.skill, "agent-reach");
  assert.ok(readActivity(root, 10).some(a => a.kind === "skill-use" && a.summary.includes("agent-reach")));
  const refused = executeOwnTool(root, "sam", "sam_read_skill", { name: "no-such-skill" }, chat.id) as { error?: string };
  assert.ok(refused.error);
  assert.equal(recentSkillUse(root, 10).length, 1);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("own tools: sam_react stamps the triggering message, refuses text, assistant messages, visitors, and context-free calls", () => {
 const root = mkdtempSync(join(tmpdir(), "sam-own-react-"));
 try {
  const db = new ChatStore(root);
  const chat = db.create("Chat");
  const userMsg = db.add(chat.id, "user", "Deploy it");
  const samMsg = db.add(chat.id, "assistant", "On it");
  const visitorChat = db.create("Door", null, { visitor: true });
  const visitorMsg = db.add(visitorChat.id, "user", "Hello");
  db.close();
  const noCtx = executeOwnTool(root, "sam", "sam_react", { reaction: "\uD83D\uDC40" }) as { error?: string };
  assert.match(noCtx.error ?? "", /live chat turn/);
  const ok = executeOwnTool(root, "sam", "sam_react", { reaction: "\uD83C\uDF89" }, chat.id, userMsg.id) as { reacted?: string };
  assert.equal(ok.reacted, "\uD83C\uDF89");
  const check = new ChatStore(root);
  assert.equal(check.messages(chat.id).find(m => m.id === userMsg.id)?.reaction, "\uD83C\uDF89");
  check.close();
  const onSam = executeOwnTool(root, "sam", "sam_react", { reaction: "\uD83D\uDC40", messageId: samMsg.id }, chat.id, userMsg.id) as { error?: string };
  assert.match(onSam.error ?? "", /owner's messages/);
  const text = executeOwnTool(root, "sam", "sam_react", { reaction: "nice" }, chat.id, userMsg.id) as { error?: string };
  assert.match(text.error ?? "", /Invalid reaction/);
  const visitor = executeOwnTool(root, "sam", "sam_react", { reaction: "\uD83D\uDC40" }, visitorChat.id, visitorMsg.id) as { error?: string };
  assert.match(visitor.error ?? "", /visitor/);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
