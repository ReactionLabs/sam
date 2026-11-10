import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore, isReactionText } from "./chats.js";

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

test("chat pin and rename persist, pinned chats sort first",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-pin-"));
 try{
  const db=new ChatStore(root);const a=db.create("First"),b=db.create("Second");
  assert.equal(db.rename(a.id,"Renamed"),true);
  assert.equal(db.pin(a.id,true),true);
  assert.equal(db.list()[0].id,a.id);
  assert.equal(db.list()[0].title,"Renamed");
  assert.equal(db.list()[0].pinned,1);
  assert.equal(db.pin(a.id,false),true);
  assert.equal(db.list().find(c=>c.id===a.id)?.pinned,0);
  assert.equal(db.rename("missing","Nope"),false);
  assert.throws(()=>db.rename(a.id," "),/title/);
  db.pin(b.id,true);db.close();
  const reopened=new ChatStore(root);
  assert.equal(reopened.list()[0].id,b.id);
  reopened.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("agent profiles carry model and connector pins, and chats bind to a profile",()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-profiles-"));
  try{
    const db=new ChatStore(root);
    const cid="123e4567-e89b-42d3-a456-426614174000";
    const agent=db.createAgent("trading","Watch the stack",{model:"MiniMax-M3",connectorId:cid});
    assert.equal(agent.model,"MiniMax-M3");
    assert.equal(agent.connector_id,cid);
    assert.throws(()=>db.createAgent("badmodel","x",{model:"not a model"}),/Invalid agent/);
    assert.throws(()=>db.createAgent("badconn","x",{connectorId:"nope"}),/Invalid agent/);
    const chat=db.create("Trading desk","trading");
    assert.equal(chat.agent_name,"trading");
    const child=db.branch(chat.id,"Trading branch");
    assert.equal(child.agent_name,"trading");
    const plain=db.create("Plain chat");
    assert.equal(plain.agent_name,null);
    db.close();
    const reopened=new ChatStore(root);
    assert.equal(reopened.agents()[0].model,"MiniMax-M3");
    assert.equal(reopened.agents()[0].connector_id,cid);
    assert.equal(reopened.list().find(c=>c.id===chat.id)?.agent_name,"trading");
    reopened.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("agent profile pins can be re-pinned and cleared after creation",()=>{
  const root=mkdtempSync(join(tmpdir(),"sam-repin-"));
  try{
    const db=new ChatStore(root);
    const cid="123e4567-e89b-42d3-a456-426614174000";
    const cid2="123e4567-e89b-42d3-a456-426614174001";
    db.createAgent("trading","Watch the stack",{model:"MiniMax-M3",connectorId:cid});
    // The 2026-11-09 box switch, as a supported operation this time.
    const moved=db.setAgentModel("trading","MiniMax-M2.5");
    assert.equal(moved?.model,"MiniMax-M2.5");
    assert.equal(moved?.connector_id,cid);
    const reconnected=db.setAgentConnector("trading",cid2);
    assert.equal(reconnected?.connector_id,cid2);
    assert.equal(reconnected?.model,"MiniMax-M2.5");
    // Clearing a pin returns the profile to the tier table / no connector.
    assert.equal(db.setAgentModel("trading",null)?.model,null);
    assert.equal(db.setAgentConnector("trading",null)?.connector_id,null);
    // Same validation as creation; unknown names change nothing.
    assert.throws(()=>db.setAgentModel("trading","not a model"),/Invalid agent/);
    assert.throws(()=>db.setAgentConnector("trading","nope"),/Invalid agent/);
    assert.equal(db.setAgentModel("missing","MiniMax-M3"),null);
    assert.equal(db.setAgentConnector("missing",cid),null);
    db.close();
    const reopened=new ChatStore(root);
    assert.equal(reopened.agents()[0].model,null);
    assert.equal(reopened.agents()[0].connector_id,null);
    reopened.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("message reactions: set, read back, clear; text is refused; a foreign chat cannot stamp", () => {
 const root = mkdtempSync(join(tmpdir(), "sam-reactions-"));
 try {
  const db = new ChatStore(root);
  const chat = db.create("Reactions");
  const other = db.create("Other");
  const mine = db.add(chat.id, "user", "Ship it");
  const foreign = db.add(other.id, "user", "Not yours");
  assert.equal(mine.reaction, null);
  assert.equal(db.setReaction(chat.id, mine.id, "\uD83D\uDC40"), true);
  assert.equal(db.messages(chat.id)[0].reaction, "\uD83D\uDC40");
  assert.equal(db.setReaction(chat.id, mine.id, "\u2764\uFE0F"), true);
  assert.equal(db.messages(chat.id)[0].reaction, "\u2764\uFE0F");
  assert.equal(db.setReaction(chat.id, mine.id, null), true);
  assert.equal(db.messages(chat.id)[0].reaction, null);
  assert.equal(db.setReaction(chat.id, foreign.id, "\uD83D\uDC40"), false);
  assert.equal(db.messages(other.id)[0].reaction, null);
  assert.throws(() => db.setReaction(chat.id, mine.id, "great"), /Invalid reaction/);
  assert.throws(() => db.setReaction(chat.id, mine.id, "ok \uD83D\uDC4D"), /Invalid reaction/);
  assert.ok(isReactionText("\uD83C\uDF89"));
  assert.ok(isReactionText("\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67"));
  assert.ok(!isReactionText(""));
  db.close();
 } finally { rmSync(root, { recursive: true, force: true }); }
});
