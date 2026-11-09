import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel, channels, setChannelOwners } from "./channels.js";
import { handleTelegramUpdate, chunkText, loadBridgeState, type SamClient } from "./telegram.js";

test("channel registry stores env reference only and validates owners",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-channels-"));
 try{
  assert.throws(()=>addChannel(root,"bad","Trading","SAM_CHANNEL_TG"),/Invalid/);
  const c=addChannel(root,"Dip Telegram","trading","SAM_CHANNEL_TG_MAIN",[123]);
  assert.equal(channels(root).length,1);
  assert.equal(JSON.stringify(channels(root)).includes("bot-token"),false);
  assert.deepEqual(channels(root)[0].ownerIds,[123]);
  assert.equal(setChannelOwners(root,c.id,[456,456]).ownerIds.length,1);
  assert.throws(()=>setChannelOwners(root,c.id,[-1]),/Invalid owner/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("telegram bridge relays owner messages through the channel profile and ignores strangers",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-tg-"));
 try{
  const channel=addChannel(root,"Dip Telegram","trading","SAM_CHANNEL_TG_MAIN",[111]);
  const sent:Array<{chat:number;text:string}>=[];
  const seenChats:string[]=[];
  const sam:SamClient={ensureChat:async(title,profile)=>{seenChats.push(title+"|"+profile);return "sam-chat-1";},postMessage:async(id,content)=>{assert.equal(id,"sam-chat-1");return "Reply to: "+content;}};
  const state=loadBridgeState(root);
  const deps={channel,sam,send:async(chat:number,text:string)=>{sent.push({chat,text});},state};
  await handleTelegramUpdate(deps,{update_id:1,message:{chat:{id:555},from:{id:999,username:"stranger"},text:"hello"}});
  assert.equal(sent.length,0);
  assert.equal(state.pairingCandidate?.id,999);
  await handleTelegramUpdate(deps,{update_id:2,message:{chat:{id:555},from:{id:111},text:"stack health?"}});
  assert.deepEqual(seenChats,["Telegram · trading|trading"]);
  assert.deepEqual(sent,[{chat:555,text:"Reply to: stack health?"}]);
  await handleTelegramUpdate(deps,{update_id:3,message:{chat:{id:555},from:{id:111},text:"again"}});
  assert.equal(seenChats.length,1);
  assert.equal(state.offset,4);
  assert.deepEqual(chunkText("a".repeat(9000)).map(x=>x.length),[4000,4000,1000]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
