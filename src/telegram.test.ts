import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChannel, channels, setChannelOwners } from "./channels.js";
import { handleTelegramUpdate, runTelegramBridge, chunkText, loadBridgeState, type SamClient, type TelegramApi } from "./telegram.js";
import { readActivity } from "./activity.js";
import { issuePairingCode } from "./pairing.js";

test("channel registry stores env reference only and validates owners",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-channels-"));
 try{
  assert.throws(()=>addChannel(root,"telegram","bad","Trading","SAM_CHANNEL_TG"),/Invalid/);
  const c=addChannel(root,"telegram","Dip Telegram","trading","SAM_CHANNEL_TG_MAIN",[123]);
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
  const channel=addChannel(root,"telegram","Dip Telegram","trading","SAM_CHANNEL_TG_MAIN",[111]);
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

test("telegram bridge pairs a stranger who sends the pairing code, then relays them",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-tg-pair-"));
 try{
  const channel=addChannel(root,"telegram","Dip Telegram","trading","SAM_CHANNEL_TG_MAIN",[]);
  const issued=issuePairingCode(root,channel.id);
  const sent:Array<{chat:number;text:string}>=[];
  const relayed:string[]=[];
  const sam:SamClient={ensureChat:async()=>"sam-chat-1",postMessage:async(_id,content)=>{relayed.push(content);return "Reply to: "+content;}};
  const state=loadBridgeState(root);
  const deps={channel,sam,send:async(chat:number,text:string)=>{sent.push({chat,text});},state,root};
  // Ordinary stranger text: silence, candidate recorded, no pairing.
  await handleTelegramUpdate(deps,{update_id:1,message:{chat:{id:555},from:{id:999,username:"stranger"},text:"hello"}});
  assert.equal(sent.length,0);
  assert.deepEqual(channel.ownerIds,[]);
  // A wrong code: still silence (no oracle), still not an owner.
  await handleTelegramUpdate(deps,{update_id:2,message:{chat:{id:555},from:{id:999},text:"ZZZZ-ZZZZ"}});
  assert.equal(sent.length,0);
  assert.deepEqual(channel.ownerIds,[]);
  // The real code pairs them: one confirmation, owner list updated in the
  // live channel object AND persisted in the registry.
  await handleTelegramUpdate(deps,{update_id:3,message:{chat:{id:555},from:{id:999},text:issued.code}});
  assert.equal(sent.length,1);
  assert.match(sent[0].text,/Paired/);
  assert.deepEqual(channel.ownerIds,[999]);
  assert.deepEqual(channels(root)[0].ownerIds,[999]);
  // The code itself was not relayed as a chat turn, and the next message is.
  assert.deepEqual(relayed,[]);
  await handleTelegramUpdate(deps,{update_id:4,message:{chat:{id:555},from:{id:999},text:"stack health?"}});
  assert.deepEqual(relayed,["stack health?"]);
  // Default-deny ordering: an owner sending a code-shaped message is having
  // a conversation, not pairing - it relays like any other owner text.
  await handleTelegramUpdate(deps,{update_id:5,message:{chat:{id:555},from:{id:999},text:"ABCD-2345"}});
  assert.deepEqual(relayed,["stack health?","ABCD-2345"]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("telegram bridge pairs via the pair command form too",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-tg-pair2-"));
 try{
  const channel=addChannel(root,"telegram","Dip Telegram","trading","SAM_CHANNEL_TG_MAIN",[]);
  const issued=issuePairingCode(root,channel.id);
  const sent:string[]=[];
  const sam:SamClient={ensureChat:async()=>"sam-chat-1",postMessage:async()=>"unused"};
  const state=loadBridgeState(root);
  await handleTelegramUpdate({channel,sam,send:async(_chat:number,text:string)=>{sent.push(text);},state,root},{update_id:1,message:{chat:{id:777},from:{id:4242},text:"pair "+issued.code.toLowerCase()}});
  assert.equal(sent.length,1);
  assert.deepEqual(channels(root)[0].ownerIds,[4242]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("telegram bridge run loop ledgers a failed update once, consumes its offset, and keeps relaying",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-tg-fail-"));
 try{
  const channel=addChannel(root,"telegram","Dip Telegram","trading","SAM_CHANNEL_TG_MAIN",[111]);
  const sent:Array<{chat:number;text:string}>=[];
  const sam:SamClient={ensureChat:async()=>"sam-chat-1",postMessage:async(_id,content)=>{if(content==="first")throw new Error("SAM dashboard request failed (HTTP 500)");return "Reply to: "+content;}};
  let polls=0;
  const api={getUpdates:async()=>{polls++;return [
   {update_id:10,message:{chat:{id:555},from:{id:111},text:"first"}},
   {update_id:11,message:{chat:{id:555},from:{id:111},text:"second"}},
  ];},sendMessage:async(chat:number,text:string)=>{sent.push({chat,text});}};
  await runTelegramBridge({root,channel,sam,api:api as unknown as TelegramApi,pollRetryDelayMs:0,stop:()=>polls>=1});
  // The good update after the failed one still relays - one bad update
  // never kills the bridge - and the failed one's offset is consumed
  // and saved, so Telegram never redelivers it (redelivery could
  // duplicate a turn its postMessage already stored).
  assert.deepEqual(sent,[{chat:555,text:"Reply to: second"}]);
  assert.equal(loadBridgeState(root).offset,12);
  const failures=readActivity(root,50).filter(l=>l.kind==="bridge-failed");
  assert.equal(failures.length,1);
  assert.equal(failures[0].actor,"trading");
  assert.match(failures[0].summary,/update 10/);
  assert.match(failures[0].summary,/HTTP 500/);
  // The ledger line carries the error, never the owner's message text.
  assert.equal(failures[0].summary.includes("first"),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("telegram bridge run loop ledgers a poll outage once per streak, re-armed by a successful poll",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-tg-poll-"));
 try{
  const channel=addChannel(root,"telegram","Dip Telegram","trading","SAM_CHANNEL_TG_MAIN",[111]);
  const sam:SamClient={ensureChat:async()=>"sam-chat-1",postMessage:async()=>"unused"};
  const script:Array<"throw"|"ok">=["throw","throw","ok","throw","ok"];
  let polls=0;
  const api={getUpdates:async()=>{const step=script[polls]??"ok";polls++;if(step==="throw")throw new Error("Telegram request failed (HTTP 502)");return [];},sendMessage:async()=>{}};
  await runTelegramBridge({root,channel,sam,api:api as unknown as TelegramApi,pollRetryDelayMs:0,stop:()=>polls>=script.length});
  assert.equal(polls,script.length);
  const failures=readActivity(root,50).filter(l=>l.kind==="bridge-poll-failed");
  assert.equal(failures.length,2);
  assert.match(failures[0].summary,/HTTP 502/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
