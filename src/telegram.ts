import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { channels, type Channel } from "./channels.js";
import { pairingAttemptCode, redeemPairingCode } from "./pairing.js";
import { resolveBindingProfile } from "./bindings.js";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";
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
// Telegram state store failure visibility (hourly run
// 2026-11-15 14:04 EST): this store is the bridge's one row -
// the poll offset, the telegram-chat -> SAM-chat map, and the
// pairing candidate - and every touch was unguarded.
// loadBridgeState rides runTelegramBridge's first load
// (uncaught: a dead store kills the bridge at its first line
// on start), the heartbeat tick's deliverToChannel
// (unguarded), and channelForChat, which folds every failure
// to null by design - so a dead store silently stripped a
// heartbeat proposal's inherited delivery channel and every
// loop's channel leg, dressed as a chat that lives on no
// channel. Now the store owns its touches (the code-store
// precedent, helpers here because this module already imports
// the ledger and is its own leaf for this seam): a failed
// open/read/write ledgers ONE telegram-state-failed line
// (phase read for the read door, phase write for the write
// door; actor sam; the verbatim reason collapsed and capped;
// never any state content - chat ids and the pairing
// candidate's identity are the owner's data) and rethrows
// exactly, tagged so a catching caller records nothing more
// for the same touch. channelForChat still folds to null
// exactly as before, now countable. An absent store still
// reads as the empty bridge state with no line and creates
// nothing, and a torn row payload still parses forgiving to
// the empty state - only the store touch is guarded.
export type TelegramStateStorePhase = "read" | "write";

export function telegramStateStoreFailureSummary(phase: TelegramStateStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Telegram state store " + phase + " failed: " + clean).slice(0, 200);
}

/**
 * The reason a telegram-state-failed line carries (census sprint
 * 2026-11-17): recordTelegramStateStoreFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function telegramStateStoreFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordTelegramStateStoreFailure(root: string, phase: TelegramStateStorePhase, error: unknown): void {
  const reason = telegramStateStoreFailureReason(error);
  recordActivity(root, "sam", "telegram-state-failed", telegramStateStoreFailureSummary(phase, reason));
}

function tagTelegramStateStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { telegramStateStoreLedgered?: boolean }).telegramStateStoreLedgered = true;
  }
}

export function isTelegramStateStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { telegramStateStoreLedgered?: boolean }).telegramStateStoreLedgered === true;
}

function failTelegramStateStore(root: string, phase: TelegramStateStorePhase, error: unknown): never {
  if (!isTelegramStateStoreLedgered(error)) recordTelegramStateStoreFailure(root, phase, error);
  tagTelegramStateStoreLedgered(error);
  throw error;
}

// The store's read door: the full bridge state through the store's
// own shape, or the empty state when none has ever been persisted -
// and a read on an install with no store at all creates nothing.
export function loadBridgeState(root:string):BridgeState{
 if(!bridgeStoreExists(root))return {offset:0,chats:{}};
 let db:Database.Database;
 try{db=openBridgeStore(root);}catch(error){failTelegramStateStore(root,"read",error);}
 try{
  const row=db!.prepare("SELECT data FROM telegram_state WHERE id = 1").get() as {data:string}|undefined;
  return row?(rowToBridgeState(row.data)??{offset:0,chats:{}}):{offset:0,chats:{}};
 }catch(error){failTelegramStateStore(root,"read",error);}
 finally{db!.close();}
}
export function saveBridgeState(root:string,state:BridgeState){
 let db:Database.Database;
 try{db=openBridgeStore(root);}catch(error){failTelegramStateStore(root,"write",error);}
 try{
  db!.prepare("INSERT INTO telegram_state (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(state));
 }catch(error){failTelegramStateStore(root,"write",error);}
 finally{db!.close();}
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
 private lastReplyByChat=new Map<string,string>();
 async postMessage(chatId:string,content:string):Promise<string>{
  // Queue parity (Defect 2): the dashboard accepts the message into
  // the chat's queue at any time (the old synchronous door 409'd a
  // message sent while a turn ran, and the bridge lost it). wait:true
  // holds this call until the queue drains and returns the reply in
  // the old shape. Telegram cannot steer a running turn, so this is
  // the floor the brief sets: queue-and-auto-run. A message that
  // folded into a turn whose reply an earlier waiter already claimed
  // returns silence - the answer already went out once.
  const result=await this.api("/chats/"+chatId+"/messages",{method:"POST",body:JSON.stringify({content,source:this.source,wait:true})}) as {reply?:{content?:string;id?:string|null;citation?:{available?:boolean;sourceTitle?:string;sourceChatId?:string;sourceMessageId?:string}|null}};
  const replyId=result.reply?.id??null;
  if(replyId){
   if(this.lastReplyByChat.get(chatId)===replyId)return "";
   this.lastReplyByChat.set(chatId,replyId);
  }
  const text=result.reply?.content??"No response.";
  // Issue #92: a cited reply carries its "Found in chat history"
  // line onto Telegram too - the chat title always, and a deep
  // link to the dashboard when a public base URL is configured
  // (the stable door), so the owner can land on the exact message.
  const citation=result.reply?.citation;
  if(citation?.available&&citation.sourceChatId&&citation.sourceMessageId){
   const base=(process.env.SAM_PUBLIC_URL??"").replace(/\/+$/,"");
   const link=base?base+"#chat="+citation.sourceChatId+"&msg="+citation.sourceMessageId:"";
   return text+"\n\nFound in chat history: "+(citation.sourceTitle||"an earlier chat")+(link?"\n"+link:"");
  }
  return text;
 }
}
export function dashboardTokenFromLog(logPath:string):string{
 const raw=readFileSync(logPath,"utf8");
 const matches=[...raw.matchAll(/dashboard\/([0-9a-f]{32})/g)];
 if(!matches.length)throw Error("Dashboard token not found in log");
 return matches[matches.length-1][1];
}
// Bridge failures are ledgered (hourly run 2026-11-12 22:04 EST):
// the run loop below used to swallow every failure - a thrown
// update handler and a thrown poll both vanished with no line
// anywhere, while the update's offset had already been consumed
// (handleTelegramUpdate advances it first, and the loop saves
// state after the catch), so a lost owner message was lost
// silently and the class was uncountable. The turn-failed seam
// is the precedent: one ledger line per failure, carrying the
// channel, the update id, and the error's own message - never
// the person's message text, never any token. Poll failures
// are once per outage streak (the rate-limit episode
// discipline): a dead token polling every few seconds must not
// flood the ledger, and the next successful poll re-arms it.
// The offset consumption itself does NOT change: redelivering
// an update whose postMessage may already have stored a turn
// would duplicate the owner's message and double-spend a model
// turn, and a poison update retried forever would wedge every
// later update behind it (the heartbeat-isolation lesson). The
// update stays consumed; the line makes the loss countable.
// The reason a bridge failure line carries lives in the
// leaf module error-reason.ts (moved 2026-11-17, hourly run
// 10:04 EST, so the activity ledger - which this module
// imports - can compose through the same seam with no
// import cycle) and is re-exported here so every existing
// import from telegram.js keeps working byte-for-byte.
export { errorReason } from "./error-reason.js";
export function bridgeFailureSummary(channelName:string,updateId:number,error:unknown):string{
 return ("Telegram bridge failed on update "+updateId+" for channel "+channelName+": "+errorReason(error)).slice(0,200);
}
export function bridgePollFailureSummary(channelName:string,error:unknown):string{
 return ("Telegram bridge poll failed for channel "+channelName+": "+errorReason(error)).slice(0,200);
}
export function recordBridgeFailure(root:string,channel:Channel,updateId:number,error:unknown):void{
 recordActivity(root,channel.profile,"bridge-failed",bridgeFailureSummary(channel.name,updateId,error));
}
export function recordBridgePollFailure(root:string,channel:Channel,error:unknown):void{
 recordActivity(root,channel.profile,"bridge-poll-failed",bridgePollFailureSummary(channel.name,error));
}
// The bridge-poll scorecard (2026-11-18, the measured-proof
// series): the bridge ledgers every poll failure burst as a
// "bridge-poll-failed" line - coalesced, one line per burst,
// the poll re-arming on the next success - and it is the
// largest failure class in the ledger, but no daily surface
// ever counted it, so a degrading network path to Telegram
// was invisible except as scattered ledger lines. This text
// folds the whole ledger's bridge-poll-failed lines to
// counts only: the total (in bursts, the honest unit the
// coalescing writes), and counts per fixed reason bucket
// folded from the summary's own reason text. A reason
// matching no shape is "other" and is never printed. No
// stamp, no channel name, no actor, and no verbatim reason
// enters the text, so a day no poll fails is byte-identical
// and P3-silent, and the first new failed burst is the
// news. A pure read: it creates nothing, spends no model
// call, and retries nothing - the ledger and the bridge are
// untouched, and fixing the network path stays the
// operator's call, not this surface's.
export type BridgePollBucket = "timeout" | "reset" | "http" | "network" | "other";
export function bridgePollBucket(summary:string):BridgePollBucket{
 if(/ETIMEDOUT|connect timeout|timed out|timeout/i.test(summary))return "timeout";
 if(/ECONNRESET|ECONNREFUSED|socket hang up/i.test(summary))return "reset";
 if(/Telegram request failed \(HTTP \d{3}\)/i.test(summary))return "http";
 if(/fetch failed/i.test(summary))return "network";
 return "other";
}
export function bridgePollScorecardText(root:string):string{
 const lines=readActivity(root,Number.MAX_SAFE_INTEGER,{kind:"bridge-poll-failed"});
 const buckets=new Map<BridgePollBucket,number>();
 for(const line of lines){
  const bucket=bridgePollBucket(line.summary);
  buckets.set(bucket,(buckets.get(bucket)??0)+1);
 }
 const byBucket=[...buckets.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
 const out:string[]=[];
 out.push("Bridge poll failures: "+(lines.length>0?"attention":"clear"));
 out.push("Failed poll bursts: "+String(lines.length));
 out.push("By reason: "+(byBucket.length?byBucket.map(([bucket,n])=>bucket+" "+String(n)).join(", "):"none"));
 out.push("Note: counts only, cumulative over the activity ledger, in coalesced bursts (one line per failure burst, not per attempt) - the scorecard never retries a poll or prints a channel name or reason; a new failed burst is the news");
 return out.join("\n");
}
// The bridge failed history scorecard (2026-11-22, the
// measured-proof series): the bridge ledgers every thrown
// update handler as a "bridge-failed" line through the ONE
// writer bridgeFailureSummary above - the update stays
// consumed, so the line is the only trace a lost owner
// message leaves - but the class was never folded, so how
// often an update died in the handler was invisible in
// aggregate (its sibling class, bridge-poll-failed, already
// has its poll scorecard). The parser learns only the fixed
// shape the writer writes: a numeric update id, a non-empty
// channel, and a non-empty reason, consumed and never
// printed; a line from any other kind never parses. The
// fold is counts only: no stamp, no actor, no channel name,
// no update id, and no verbatim reason - distinct channels
// surface as a number only. A pure read: it creates
// nothing, retries no update, and touches no channel.
export function parseBridgeFailedSummary(summary:string):{channel:string}|null{
 const m=/^Telegram bridge failed on update (\d+) for channel ([\s\S]+?): ([\s\S]+)$/.exec(summary);
 if(!m)return null;
 const channel=m[2]??""; const reason=m[3]??"";
 if(!channel.trim()||!reason.trim())return null;
 return {channel};
}
export function bridgeFailedHistoryScorecardText(root:string):string{
 const lines=readActivity(root,Number.MAX_SAFE_INTEGER,{kind:"bridge-failed"});
 let failed=0; let unparseable=0; const channels=new Set<string>();
 for(const line of lines){
  const parsed=parseBridgeFailedSummary(line.summary);
  if(parsed){failed+=1;channels.add(parsed.channel);continue;}
  unparseable+=1;
 }
 const parts:string[]=[];
 parts.push("Bridge failed history: "+(failed>0||unparseable>0?"attention":"clear"));
 parts.push(String(failed)+" failed");
 parts.push(String(channels.size)+" distinct channels");
 parts.push(String(lines.length)+" total");
 if(unparseable>0)parts.push(String(unparseable)+" unparseable");
 return parts.join(", ");
}
export async function runTelegramBridge(opts:{root:string;channel:Channel;sam:SamClient;api:TelegramApi;pollTimeoutSec?:number;pollRetryDelayMs?:number;stop?:()=>boolean}):Promise<void>{
 const state=loadBridgeState(opts.root);
 const timeout=opts.pollTimeoutSec??30;
 const retryDelayMs=opts.pollRetryDelayMs??3000;
 let pollFailureOpen=false;
 while(!opts.stop?.()){
  let updates:TelegramUpdate[]=[];
  try{updates=await opts.api.getUpdates(state.offset,timeout);pollFailureOpen=false;}catch(error){
   if(!pollFailureOpen){try{recordBridgePollFailure(opts.root,opts.channel,error);}catch{/* the ledger never breaks the bridge */}pollFailureOpen=true;}
   await new Promise(r=>setTimeout(r,retryDelayMs));continue;
  }
  for(const update of updates){
   try{await handleTelegramUpdate({channel:opts.channel,sam:opts.sam,send:(id,text)=>opts.api.sendMessage(id,text),state,root:opts.root},update);}catch(error){/* one bad update never kills the bridge - and it is ledgered, never silent */
    try{recordBridgeFailure(opts.root,opts.channel,update.update_id,error);}catch{/* the ledger never breaks the bridge */}
   }
   saveBridgeState(opts.root,state);
  }
 }
}
