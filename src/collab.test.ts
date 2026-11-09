import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";
import { createLink } from "./links.js";
import { linkExchange } from "./collab.js";

test("linked profiles plan back and forth in one shared chat; unlinked are refused",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-collab-"));
 try{
  const db=new ChatStore(root);
  db.createAgent("alex","A.");db.createAgent("blair","B.");db.createAgent("casey","C.");
  db.close();
  const link=createLink(root,"project",["alex","blair"]);
  const seen:Array<{chatId:string;content:string;bound:string|null}>=[];
  const runTurn=async(chatId:string,content:string)=>{
    const store=new ChatStore(root);
    try{seen.push({chatId,content,bound:store.list().find(c=>c.id===chatId)?.agent_name??null});}finally{store.close();}
    return "reply to: "+content;
  };
  const r1=await linkExchange(root,link.id,"alex","blair","Draft the launch plan?",{runTurn});
  assert.match(r1,/\[alex\] Draft the launch plan/);
  assert.equal(seen[0].bound,"blair");
  const r2=await linkExchange(root,link.id,"blair","alex","Tighten step two.",{runTurn});
  assert.equal(seen[1].chatId,seen[0].chatId);
  assert.equal(seen[1].bound,"alex");
  await assert.rejects(()=>linkExchange(root,link.id,"alex","casey","Hello?",{runTurn}),/must belong to the link/);
  await assert.rejects(()=>linkExchange(root,link.id,"alex","alex","Me?",{runTurn}),/itself/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
