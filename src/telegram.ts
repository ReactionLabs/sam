import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { channels, type Channel } from "./channels.js";
import { pairingAttemptCode, redeemPairingCode } from "./pairing.js";
import { resolveBindingProfile } from "./bindings.js";

// Telegram bridge: long-polls the bot API (no public webhook needed, so it works
// from a NAT/tailnet box), maps each allowed Telegram chat to a SAM chat bound to
// the channel's profile, and relays messages both ways. Anyone not on the owner
// list is ignored silently; their id is recorded as a pairing candidate for
// visibility, and a pairing code (pairing.ts, Phase A item 3) is the door in:
// send the code, join the owner list, no hand-copied numeric ids.
export interface SamClient {
 ensureChat(title:string,profile:string):Promise<string>;
 postMessage(chatId:string,content:string):Promise<string>;
}
export interface TelegramUpdate { update_id:number; message?:{ chat:{id:number}; from?:{id:number; username?:string; first_name?:string}; text?:string } }
interface BridgeState { offset:number; chats:Record<string,string>; pairingCandidate?:{id:number; username?:string; first_name?:string; at:string} }
function statePath(root:string){return join(resolve(root),".sam","telegram-state.json");}
export function loadBridgeState(root:string):BridgeState{
 if(!existsSync(statePath(root)))return {offset:0,chats:{}};
 const value:unknown=JSON.parse(readFileSync(statePath(root),"utf8"));
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid telegram bridge state");
 return value as BridgeState;
}
export function saveBridgeState(root:string,state:BridgeState){mkdirSync(join(resolve(root),".sam"),{recursive:true});writeFileSync(statePath(root),JSON.stringify(state,null,2),{mode:0o600});}
// The channel a SAM chat lives on, if any: a chat id found in the
// Telegram bridge state belongs to that bridge's telegram channel.
// This is the one resolver for "which channel is this conversation
// on" - the loop-revisit engine's channel leg rides it, and the
// action gate rides it to inherit a heartbeat proposal's delivery
// channel from the chat the proposal was made in. Discord and
// webhook chats carry no chat binding, so they return null.
export function channelForChat(root:string,chatId:string):string|null{
 try{
  const state=loadBridgeState(root);
  if(!Object.values(state.chats).includes(chatId))return null;
 }catch{return null;}
 const telegram=channels(root).find(c=>c.kind==="telegram"&&c.enabled);
 return telegram?telegram.id:null;
}
export function chunkText(text:string,limit=4000):string[]{
 const out:string[]=[];let rest=text;
 while(rest.length>limit){let cut=rest.lastIndexOf("\n",limit);if(cut<limit/2)cut=limit;out.push(rest.slice(0,cut));rest=rest.slice(cut).replace(/^\n/,"");}
 if(rest)out.push(rest);
 return out.length?out:[""];
}
export async function handleTelegramUpdate(deps:{channel:Channel;sam:SamClient;send:(chatId:number,text:string)=>Promise<void>;state:BridgeState;root?:string},update:TelegramUpdate):Promise<void>{
 const msg=update.message;
 deps.state.offset=Math.max(deps.state.offset,update.update_id+1);
 if(!msg||typeof msg.text!=="string"||!msg.text.trim())return;
 const fromId=msg.from?.id;
 if(!fromId||!deps.channel.ownerIds.includes(fromId)){
  deps.state.pairingCandidate={id:fromId??0,username:msg.from?.username,first_name:msg.from?.first_name,at:new Date().toISOString()};
  // Pairing (Phase A item 3): a non-owner whose message is a pairing code
  // (or "pair <code>") redeems it and joins the owner list. Owners are
  // checked FIRST, above, so an owner's code-shaped chat message is never
  // consumed as a code. A failed attempt gets silence, never an oracle -
  // the attempt is counted toward the channel lockout inside redeem.
  if(fromId&&deps.root){
   const attempt=pairingAttemptCode(msg.text);
   if(attempt){
    try{
     const result=redeemPairingCode(deps.root,deps.channel.id,attempt,fromId);
     if(result.ok){
      deps.channel.ownerIds=result.channel.ownerIds;
      await deps.send(msg.chat.id,"Paired - you are on the owner list for this SAM channel now. Send any message to start talking.");
     }
    }catch{/* a pairing error never kills the bridge and never talks to strangers */}
   }
  }
  return;
 }
 // Deterministic bindings (Phase C item 3): the sender's id is the peer;
 // a peer binding beats a channel-wide binding beats the channel's own
 // profile. No root (older test harnesses) means the channel profile,
 // exactly as before. A routed profile gets its own chat key so two
 // profiles sharing one telegram chat never share a SAM chat.
 const profile=deps.root?resolveBindingProfile(deps.root,deps.channel,fromId).profile:deps.channel.profile;
 const key=profile===deps.channel.profile?String(msg.chat.id):String(msg.chat.id)+":"+profile;
 let chatId=deps.state.chats[key];
 if(!chatId){
  chatId=await deps.sam.ensureChat("Telegram · "+profile,profile);
  deps.state.chats[key]=chatId;
 }
 const reply=await deps.sam.postMessage(chatId,msg.text.trim());
 for(const part of chunkText(reply))await deps.send(msg.chat.id,part);
}
export class TelegramApi {
 constructor(private token:string,private fetchFn:typeof fetch=fetch){}
 private async call(method:string,params:Record<string,unknown>):Promise<unknown>{
  const response=await this.fetchFn("https://api.telegram.org/bot"+this.token+"/"+method,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(params)});
  if(!response.ok)throw Error("Telegram request failed (HTTP "+response.status+")");
  const data:unknown=await response.json();
  if(!data||typeof data!=="object"||!(data as {ok?:unknown}).ok)throw Error("Telegram API error");
  return (data as {result:unknown}).result;
 }
 async getUpdates(offset:number,timeoutSec:number):Promise<TelegramUpdate[]>{
  const result=await this.call("getUpdates",{offset,timeout:timeoutSec,allowed_updates:["message"]});
  return Array.isArray(result)?result as TelegramUpdate[]:[];
 }
 async sendMessage(chatId:number,text:string):Promise<void>{await this.call("sendMessage",{chat_id:chatId,text});}
}
// SAM dashboard client for the bridge. The dashboard token rotates on every
// dashboard restart, so the bridge discovers it through a provider: an explicit
// token when given, otherwise the latest dashboard URL found in the log file of
// the dashboard running on this same host. Same machine, same owner, files are
// owner-only; a stable service credential is the future replacement for this seam.
export class DashboardSamClient implements SamClient {
 constructor(private baseUrl:string,private token:()=>string,private fetchFn:typeof fetch=fetch){}
 private async api(path:string,init?:RequestInit):Promise<unknown>{
  const response=await this.fetchFn(this.baseUrl+"/api/"+this.token()+path,{...init,headers:{"Content-Type":"application/json","X-SAM-Request":"dashboard",...(init?.headers??{})}});
  if(!response.ok)throw Error("SAM dashboard request failed (HTTP "+response.status+")");
  return response.json();
 }
 async ensureChat(title:string,profile:string):Promise<string>{
  // Reuse an existing chat with this title + profile when one exists (e.g. after
  // bridge state loss), instead of piling up duplicate SAM chats.
  try{
   const response=await this.fetchFn(this.baseUrl+"/api/status/"+this.token());
   if(response.ok){
    const status=await response.json() as {chats?:Array<{id:string;title:string;agent_name?:string|null}>};
    const found=(status.chats??[]).find(c=>c.title===title&&(c.agent_name??null)===(profile==="sam"?null:profile));
    if(found)return found.id;
   }
  }catch{/* fall through to create */}
  const created=await this.api("/chats",{method:"POST",body:JSON.stringify({title,agent:profile==="sam"?undefined:profile})}) as {id:string};
  return created.id;
 }
 async postMessage(chatId:string,content:string):Promise<string>{
  const result=await this.api("/chats/"+chatId+"/messages",{method:"POST",body:JSON.stringify({content})}) as {reply?:{content?:string}};
  return result.reply?.content??"No response.";
 }
}
export function dashboardTokenFromLog(logPath:string):string{
 const raw=readFileSync(logPath,"utf8");
 const matches=[...raw.matchAll(/dashboard\/([0-9a-f]{32})/g)];
 if(!matches.length)throw Error("Dashboard token not found in log");
 return matches[matches.length-1][1];
}
export async function runTelegramBridge(opts:{root:string;channel:Channel;sam:SamClient;api:TelegramApi;pollTimeoutSec?:number;stop?:()=>boolean}):Promise<void>{
 const state=loadBridgeState(opts.root);
 const timeout=opts.pollTimeoutSec??30;
 while(!opts.stop?.()){
  let updates:TelegramUpdate[]=[];
  try{updates=await opts.api.getUpdates(state.offset,timeout);}catch{await new Promise(r=>setTimeout(r,3000));continue;}
  for(const update of updates){
   try{await handleTelegramUpdate({channel:opts.channel,sam:opts.sam,send:(id,text)=>opts.api.sendMessage(id,text),state,root:opts.root},update);}catch{/* one bad update never kills the bridge */}
   saveBridgeState(opts.root,state);
  }
 }
}
