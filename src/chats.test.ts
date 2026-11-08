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
