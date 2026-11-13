import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { channels, type Channel } from "./channels.js";
import { pairingAttemptCode, redeemPairingCode } from "./pairing.js";
import { resolveBindingProfile } from "./bindings.js";
import type { MessageSource } from "./message-provenance.js";

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
export interface BridgeState { offset:number; chats:Record<string,string>; pairingCandidate?:{id:number; username?:string; first_name?:string; at:string} }
function statePath(root:string){return join(resolve(root),".sam","telegram-state.json");}
function stateDbFile(root:string){return join(resolve(root),".sam","telegram-state.db");}
// State convergence (UNIFICATION item 4, twenty-third store): the
// bridge state is SQLite (.sam/telegram-state.db, the skill-curator
// singleton pattern), ONE row holding the state's full JSON so the
// singleton keeps its exact shape. The old telegram-state.json was
// rewritten whole by saveBridgeState after EVERY update the bridge
// handled, and loadBridgeState THREW on a malformed or non-object
// file: a torn write (crash mid-writeFileSync, which is not atomic)
// left the bridge dead at its first line on the next start - the
// runTelegramBridge load is uncaught - with the poll offset, the
// telegram-chat -> SAM-chat map, and any pairing candidate all in
// the one torn file, while readers in other processes (channelForChat
// on the action gate and the loop revisit, deliverToChannel in the
// heartbeat tick, the latter UNGUARDED) caught or propagated the
// same throw off a half-written read. Here each save is a
// single-row UPSERT and connections carry a busy_timeout (the F1
// cross-process lock seam), so no reader in any process can ever
// see a torn state. The migrated loader is forgiving where the old
// one threw (the pairing precedent): a malformed or non-object
// payload reads as the empty bridge state - a torn state's facts
// were already lost when the write tore; dying forever on it only
// adds an outage. First open imports a legacy telegram-state.json
// and renames it telegram-state.json.migrated - imported, never
// deleted; a malformed file or a non-object payload imports
// nothing and is left in place. A pure read on an install with
// neither file creates nothing (the old default-state read,
// preserved). The P9 backup snapshots every .sam/*.db generically,
// so the migrated store is carried with no backup change.
function openBridgeStore(root:string):Database.Database{
 const dir=join(resolve(root),".sam");
 mkdirSync(dir,{recursive:true,mode:0o700});
 if(lstatSync(dir).isSymbolicLink())throw new Error("Unsafe SAM state directory");
 const db=openDatabase(stateDbFile(root));
 db.exec("CREATE TABLE IF NOT EXISTS telegram_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
 migrateLegacyBridgeState(db,root);
 return db;
}
function migrateLegacyBridgeState(db:Database.Database,root:string):void{
 const row=db.prepare("SELECT data FROM telegram_state WHERE id = 1").get() as {data:string}|undefined;
 if(row)return;
 const file=statePath(root);
 if(!existsSync(file))return;
 let data:unknown;
 try{data=JSON.parse(readFileSync(file,"utf8"));}catch{return;}
 if(!data||typeof data!=="object"||Array.isArray(data))return;
 db.prepare("INSERT OR IGNORE INTO telegram_state (id, data) VALUES (1, ?)").run(JSON.stringify(data));
 renameSync(file,file+".migrated");
}
function rowToBridgeState(data:string):BridgeState|null{
 try{
  const value:unknown=JSON.parse(data);
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const raw=value as {offset?:unknown;chats?:unknown;pairingCandidate?:unknown};
  const chats:Record<string,string>={};
  if(raw.chats&&typeof raw.chats==="object"&&!Array.isArray(raw.chats)){
   for(const [key,chatId] of Object.entries(raw.chats as Record<string,unknown>))if(typeof chatId==="string")chats[key]=chatId;
  }
  const state:BridgeState={offset:typeof raw.offset==="number"&&Number.isFinite(raw.offset)?raw.offset:0,chats};
  if(raw.pairingCandidate&&typeof raw.pairingCandidate==="object"&&!Array.isArray(raw.pairingCandidate)){
   const candidate=raw.pairingCandidate as {id?:unknown;username?:unknown;first_name?:unknown;at?:unknown};
   if(typeof candidate.id==="number"){
    const kept:BridgeState["pairingCandidate"]={id:candidate.id,at:typeof candidate.at==="string"?candidate.at:""};
    if(typeof candidate.username==="string")kept.username=candidate.username;
    if(typeof candidate.first_name==="string")kept.first_name=candidate.first_name;
    state.pairingCandidate=kept;
   }
  }
  return state;
 }catch{return null;}
}
function bridgeStoreExists(root:string):boolean{
 return existsSync(stateDbFile(root))||existsSync(statePath(root));
}
// The store's read door: the full bridge state through the store's
// own shape, or the empty state when none has ever been persisted -
// and a read on an install with no store at all creates nothing.
export function loadBridgeState(root:string):BridgeState{
 if(!bridgeStoreExists(root))return {offset:0,chats:{}};
 const db=openBridgeStore(root);
 try{
  const row=db.prepare("SELECT data FROM telegram_state WHERE id = 1").get() as {data:string}|undefined;
  return row?(rowToBridgeState(row.data)??{offset:0,chats:{}}):{offset:0,chats:{}};
 }finally{db.close();}
}
export function saveBridgeState(root:string,state:BridgeState){
 const db=openBridgeStore(root);
 try{
  db.prepare("INSERT INTO telegram_state (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(state));
 }finally{db.close();}
}
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
 // Silence is a reply shape, not an error: an empty reply (the
 // rate-limit grace episode already spoke for this cap) sends
 // nothing at all - never an empty Telegram message.
 if(!reply.trim())return;
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
 constructor(private baseUrl:string,private token:()=>string,private fetchFn:typeof fetch=fetch,private source:MessageSource="api"){}
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
  const result=await this.api("/chats/"+chatId+"/messages",{method:"POST",body:JSON.stringify({content,source:this.source})}) as {reply?:{content?:string}};
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
