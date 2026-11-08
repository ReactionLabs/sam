import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./chats.js";

test("chat sessions persist separately across restarts",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-chats-"));
 try {
  const a=new ChatStore(root);
  const first=a.create("Research"),second=a.create("Code");
  a.add(first.id,"user","Find sources");
  a.add(second.id,"assistant","Ready");
  assert.equal(a.messages(first.id).length,1);
  assert.equal(a.messages(second.id)[0].content,"Ready");
  assert.throws(()=>a.add("missing","user","Hello"),/Chat not found/);
  assert.throws(()=>a.create(" "),/title/);
  a.close();
  const b=new ChatStore(root);
  assert.equal(b.list().length,2);
  assert.equal(b.messages(first.id)[0].content,"Find sources");
  b.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("chat branch snapshots messages without changing parent and persists agent profiles",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-branch-"));
 try{
  const db=new ChatStore(root);const parent=db.create("Original");
  db.add(parent.id,"user","First idea");
  const branch=db.branch(parent.id,"Alternative");
  assert.equal(branch.parent_chat_id,parent.id);
  assert.equal(db.messages(branch.id)[0].content,"First idea");
  db.add(branch.id,"user","Different approach");
  assert.equal(db.messages(parent.id).length,1);
  assert.throws(()=>db.branch("missing","Bad"),/Parent chat not found/);
  const agent=db.createAgent("researcher","Find grounded evidence");
  assert.equal(agent.name,"researcher");
  assert.throws(()=>db.createAgent("researcher","Duplicate"),/UNIQUE/);
  assert.throws(()=>db.createAgent("Bad Name","Instructions"),/Invalid agent/);
  db.close();
  const reopened=new ChatStore(root);
  assert.equal(reopened.agents()[0].instructions,"Find grounded evidence");
  assert.equal(reopened.list().find(c=>c.id===branch.id)?.parent_chat_id,parent.id);
  reopened.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
