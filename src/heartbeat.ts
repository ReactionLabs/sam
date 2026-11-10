import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatStore } from "./chats.js";
import { PreferenceStore, extractPreferences } from "./preferences.js";
import { detectCorrection, proposeCorrection, withoutCorrectedRules } from "./corrections.js";
import { readDashboardConfig } from "./dashboard.js";
import { channels } from "./channels.js";
import { loadBridgeState } from "./telegram.js";
import { recordActivity } from "./activity.js";
import { writeEpisode, type EpisodeChat } from "./episodes.js";
import { drainBackgroundTasks } from "./background.js";
import { assessDelivery } from "./worthiness.js";

// Heartbeats: SAM's scheduled self-maintenance and self-directed work.
// Every tick does two things:
//  1. Consolidation - scan new user messages across chats, capture preferences,
//     and promote the ones that earned it into law. This is how SAM's memory
//     updates itself instead of waiting to be told twice.
//  2. Due jobs - standing prompts ("check the stack, flag changes") executed as
//     real chat turns under a profile, with the reply optionally delivered to a
//     channel. A heartbeat is a chat SAM has with itself on a timer.
// Every tick appends to .sam/heartbeats.jsonl, so the engine room is auditable.
export interface HeartbeatJob { id:string; name:string; minutes:number; profile:string; prompt:string; channelId:string|null; enabled:boolean; lastRun:string|null }
function jobsPath(root:string){return join(resolve(root),".sam","heartbeat-jobs.json");}
function statePath(root:string){return join(resolve(root),".sam","heartbeat-state.json");}
function logPath(root:string){return join(resolve(root),".sam","heartbeats.jsonl");}
export function heartbeatJobs(root:string):HeartbeatJob[]{
 if(!existsSync(jobsPath(root)))return [];
 const value:unknown=JSON.parse(readFileSync(jobsPath(root),"utf8"));
 if(!Array.isArray(value)||value.length>32)throw Error("Invalid heartbeat jobs file");
 return value as HeartbeatJob[];
}
function saveJobs(root:string,items:HeartbeatJob[]){mkdirSync(join(resolve(root),".sam"),{recursive:true});writeFileSync(jobsPath(root),JSON.stringify(items,null,2),{mode:0o600});}
export function addHeartbeatJob(root:string,name:string,minutes:number,profile:string,prompt:string,channelId:string|null=null):HeartbeatJob{
 if(!/^[a-zA-Z0-9 _-]{1,80}$/.test(name))throw Error("Invalid heartbeat name");
 if(!Number.isSafeInteger(minutes)||minutes<5||minutes>10080)throw Error("Interval must be 5 to 10080 minutes");
 if(!/^[a-z][a-z0-9._-]{0,63}$/.test(profile))throw Error("Invalid profile");
 if(!prompt.trim()||prompt.length>2000)throw Error("Invalid heartbeat prompt");
 const items=heartbeatJobs(root);
 if(items.length>=32||items.some(j=>j.name===name))throw Error("Heartbeat limit or duplicate name");
 const item:HeartbeatJob={id:randomUUID(),name,minutes,profile,prompt:prompt.trim(),channelId,enabled:true,lastRun:null};
 saveJobs(root,[...items,item]);return item;
}
export function removeHeartbeatJob(root:string,id:string):boolean{
 const items=heartbeatJobs(root),rest=items.filter(j=>j.id!==id);
 if(rest.length===items.length)return false;saveJobs(root,rest);return true;
}
export interface HeartbeatOutputRecord { hash:string; at:string; preview:string; sig?:string }
interface HeartbeatState { chats:Record<string,string>; lastTick:string|null; outputs?:Record<string,HeartbeatOutputRecord> }
function loadState(root:string):HeartbeatState{
 if(!existsSync(statePath(root)))return {chats:{},lastTick:null,outputs:{}};
 const value:unknown=JSON.parse(readFileSync(statePath(root),"utf8"));
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid heartbeat state");
 const state=value as HeartbeatState;
 if(!state.outputs||typeof state.outputs!=="object"||Array.isArray(state.outputs))state.outputs={};
 return state;
}
// Heartbeat diffing (program P3): a job's reply is compared with its last one
// before anything is announced. The comparison is over a normalized form, not
// the raw text, so the model rephrasing the same facts (markdown, casing,
// punctuation, a fresh snapshot timestamp) still reads as unchanged, while
// any fact change (a number, a date, a verdict) reads as changed. The bias is
// fail-open: anything the normalizer cannot prove identical is delivered.
export function normalizeHeartbeatOutput(text:string):string{
 const kept:string[]=[];
 for(const rawLine of text.split(/\r?\n/)){
  // Volatile metadata lines carry a fresh clock reading every run, never a fact.
  if(/\b(as_of|snapshot|generated at|checked at|run at|report time)\b/i.test(rawLine))continue;
  const line=rawLine
   .replace(/\[([^\]]*)\]\([^)]*\)/g,"$1")
   .replace(/[*_`#>]/g,"")
   .toLowerCase()
   .replace(/[^a-z0-9]+/g," ")
   .trim();
  if(line)kept.push(line);
 }
 return kept.join("\n");
}
export function heartbeatOutputHash(text:string):string{
 return createHash("sha256").update(normalizeHeartbeatOutput(text)).digest("hex");
}
// Fact signatures (P3 follow-up, found live 2026-11-09): normalized text
// cannot absorb the model paraphrasing whole clauses between runs - stack
// watch announced a frozen stack as "changed" five due runs in a row while
// every fact (282,966 candidates, newest 2026-11-04, ALERT 9, 20 entered)
// stayed identical. So a second comparison rides alongside the text hash:
// the extracted facts - ISO dates and canonical numbers, as an
// order-insensitive bag. Two outputs whose fact bags are both rich (at
// least two facts) and identical are the same news however they are
// worded. Anything thinner falls back to the text comparison, and any
// fact difference delivers: the fail-open bias is unchanged, silence now
// requires proof from the facts as well as from the wording.
const MONTH_DATE=/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/gi;
// Second-precision canonicalization (P3 follow-up, found live 2026-11-09
// 12:56 UTC): the model sometimes renders the same candidate timestamp
// WITH milliseconds (2026-11-04T22:45:59.894Z) and sometimes truncated to
// the second (2026-11-04T22:45:59Z). Those are the same fact; a rendering
// wobble must not break fact-bag inclusion and re-announce a frozen
// stack. Canonicalize every ISO date fact to second precision - drop
// fractional seconds - both when a signature is extracted and when bags
// are compared, so a legacy stored signature that still carries
// milliseconds heals on the first comparison instead of delivering once
// more.
export function canonicalHeartbeatDateFact(fact:string):string{
 return fact.replace(/(\d{2}:\d{2}:\d{2})\.\d+/, "$1");
}
function canonicalDateMatch(m:string):string{
 return canonicalHeartbeatDateFact("d:"+m.toLowerCase().replace(" ","t"));
}
export function heartbeatFactSignature(text:string):string[]{
 const kept:string[]=[];
 for(const rawLine of text.split(/\r?\n/)){
  if(/\b(as_of|snapshot|generated at|checked at|run at|report time)\b/i.test(rawLine))continue;
  kept.push(rawLine);
 }
 // Textual dates ("Nov 4") duplicate the ISO date beside them in every
 // observed reply; left in, their day number would poison the bag.
 let body=kept.join("\n").replace(MONTH_DATE," ");
 const facts:string[]=[];
 body=body.replace(/\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?/gi,m=>{facts.push(canonicalDateMatch(m));return " ";});
 body.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g,m=>{const n=Number(m.replace(/,/g,""));facts.push("n:"+(Number.isSafeInteger(n)?String(n):String(n)));return " ";});
 return facts.sort();
}
export function heartbeatFactSignatureString(text:string):string{return heartbeatFactSignature(text).join("|");}
// Paraphrases also drop or repeat facts (one run spells out PASS/PENDING
// counts, the next omits them; one says "20 rows" twice), so the bags are
// compatible when neither contradicts the other: one is a multiset subset
// of the other. A changed value breaks inclusion in both directions, and
// both bags must carry at least two facts before they prove anything.
export function heartbeatFactBagsCompatible(a:string,b:string):boolean{
 const bagA=a.split("|").filter(Boolean).map(f=>f.startsWith("d:")?canonicalHeartbeatDateFact(f):f),bagB=b.split("|").filter(Boolean).map(f=>f.startsWith("d:")?canonicalHeartbeatDateFact(f):f);
 if(bagA.length<2||bagB.length<2)return false;
 const counts=(bag:string[])=>{const m=new Map<string,number>();for(const f of bag)m.set(f,(m.get(f)??0)+1);return m;};
 const within=(inner:Map<string,number>,outer:Map<string,number>)=>[...inner].every(([f,n])=>n<=(outer.get(f)??0));
 const mapA=counts(bagA),mapB=counts(bagB);
 return within(mapA,mapB)||within(mapB,mapA);
}
export function heartbeatOutputsEquivalent(prior:{hash:string;sig?:string}|undefined,hash:string,sig:string):boolean{
 if(!prior)return false;
 if(prior.hash===hash)return true;
 if(!prior.sig)return false;
 return heartbeatFactBagsCompatible(prior.sig,sig);
}
function saveState(root:string,state:HeartbeatState){mkdirSync(join(resolve(root),".sam"),{recursive:true});writeFileSync(statePath(root),JSON.stringify(state,null,2),{mode:0o600});}
export function heartbeatLog(root:string,limit=20):Array<Record<string,unknown>>{
 if(!existsSync(logPath(root)))return [];
 return readFileSync(logPath(root),"utf8").split("\n").filter(Boolean).slice(-limit).map(line=>{try{return JSON.parse(line) as Record<string,unknown>;}catch{return {raw:line};}});
}
function appendLog(root:string,entry:Record<string,unknown>){mkdirSync(join(resolve(root),".sam"),{recursive:true});appendFileSync(logPath(root),JSON.stringify({at:new Date().toISOString(),...entry})+"\n");}
export function consolidatePreferences(root:string):{scanned:number;noted:number;promoted:string[];episodes:string[];corrections:number;visitorSkipped:number}{
 const state=loadState(root);
 const config=readDashboardConfig(root);
 const db=new ChatStore(root);const prefs=new PreferenceStore(root);
 let scanned=0,noted=0,corrections=0,visitorSkipped=0;
 // Episodic evidence (P4): every new message, both roles, grouped by
 // profile and by the message's own date, on the same watermark scan.
 const evidence=new Map<string,Map<string,Map<string,EpisodeChat>>>();
 try{
  for(const chat of db.list()){
   const profile=chat.agent_name??config.defaultAgent;
   const watermark=state.chats[chat.id]??"";
   let newest=watermark;
   for(const msg of db.messages(chat.id)){
    if(msg.created_at>newest)newest=msg.created_at;
    if(msg.created_at<=watermark)continue;
    const date=msg.created_at.slice(0,10);
    if(/^\d{4}-\d{2}-\d{2}$/.test(date)){
     let byDate=evidence.get(profile);if(!byDate){byDate=new Map();evidence.set(profile,byDate);}
     let byChat=byDate.get(date);if(!byChat){byChat=new Map();byDate.set(date,byChat);}
     let entry=byChat.get(chat.id);if(!entry){entry={chatId:chat.id,title:chat.title,messages:[]};byChat.set(chat.id,entry);}
     entry.messages.push({role:msg.role,content:msg.content,created_at:msg.created_at});
    }
    if(msg.role!=="user")continue;
    scanned++;
    // Visitor chats (P12): episodes above still record that the visit
    // happened, but capture NEVER runs on visitor text - a customer's
    // words are not the owner's preferences, corrections, or facts.
    if(chat.visitor===1){visitorSkipped++;continue;}
    // Corrections (P6): this scan is the second capture path, so it routes
    // corrections to the same P1 gate (deduped against the turn path) and
    // never lets a corrected rule slip in here as instant law.
    let correction=null as ReturnType<typeof detectCorrection>;
    try{correction=detectCorrection(msg.content);if(correction){const routed=proposeCorrection(root,{actor:profile,chatId:chat.id,text:msg.content});if(routed?.created)corrections++;}}catch{/* the gate never breaks a tick */}
    for(const found of withoutCorrectedRules(extractPreferences(msg.content),correction)){prefs.note(profile,found.statement,found.kind,chat.id);noted++;}
   }
   state.chats[chat.id]=newest;
  }
  const promoted=prefs.promote().map(p=>p.profile+": "+p.statement);
  const episodes:string[]=[];
  for(const profile of [...evidence.keys()].sort()){
   const byDate=evidence.get(profile) as Map<string,Map<string,EpisodeChat>>;
   for(const date of [...byDate.keys()].sort()){
    if(writeEpisode(root,profile,date,[...(byDate.get(date) as Map<string,EpisodeChat>).values()]))episodes.push(profile+":"+date);
   }
  }
  state.lastTick=new Date().toISOString();saveState(root,state);
  appendLog(root,{type:"consolidate",scanned,noted,promoted,episodes,corrections,visitorSkipped});
  return {scanned,noted,promoted,episodes,corrections,visitorSkipped};
 }finally{db.close();prefs.close();}
}
export interface HeartbeatDeps { runTurn:(chatId:string,content:string)=>Promise<string>; runBackgroundTurn?:(chatId:string,content:string)=>Promise<string>; ensureChat:(title:string,profile:string)=>Promise<string>; deliver?:(channelId:string,text:string)=>Promise<void> }
export async function runHeartbeat(root:string,deps:HeartbeatDeps):Promise<{consolidation:ReturnType<typeof consolidatePreferences>;ran:string[];changed:string[];unchanged:string[];background:{ran:string[];failed:string[];recovered:string[]}}>{
 const consolidation=consolidatePreferences(root);
 const jobs=heartbeatJobs(root);const now=Date.now();const ran:string[]=[];const changed:string[]=[];const unchanged:string[]=[];
 // Loaded after consolidation, which saves this same state file for its
 // watermarks; the outputs map below is this tick's addition to it.
 const state=loadState(root);
 let dirty=false;let stateDirty=false;
 for(const job of jobs){
  if(!job.enabled)continue;
  const last=job.lastRun?Date.parse(job.lastRun):0;
  if(now-last<job.minutes*60000)continue;
  const chatId=await deps.ensureChat("Heartbeat · "+job.name,job.profile);
  const reply=await deps.runTurn(chatId,job.prompt);
  job.lastRun=new Date().toISOString();dirty=true;ran.push(job.name);
  const hash=heartbeatOutputHash(reply);
  const sig=heartbeatFactSignatureString(reply);
  const prior=(state.outputs??{})[job.id];
  const isChanged=!heartbeatOutputsEquivalent(prior,hash,sig);
  state.outputs={...(state.outputs??{}),[job.id]:{hash,sig,at:new Date().toISOString(),preview:reply.slice(0,300)}};stateDirty=true;
  if(!isChanged){
   // Unchanged: a silent ledger line only. No channel delivery, no activity
   // entry, no preview spam - a frozen stack stops announcing itself.
   unchanged.push(job.name);
   appendLog(root,{type:"job-unchanged",name:job.name,profile:job.profile});
   continue;
  }
  changed.push(job.name);
  appendLog(root,{type:"job",name:job.name,profile:job.profile,changed:true,replyPreview:reply.slice(0,300)});
  recordActivity(root,job.profile,"heartbeat","Heartbeat '"+job.name+"' changed: "+reply.replace(/\s+/g," ").trim().slice(0,180));
  if(job.channelId&&deps.deliver){
   // Notification worthiness (S5): the reply is already the chat
   // record; pushing it to a channel must first be worth the
   // owner's attention - duplicates, floods, and law-denied
   // topics are held, and the hold is ledgered either way.
   const verdict=assessDelivery(root,{profile:job.profile,kind:"heartbeat",text:reply});
   if(!verdict.deliver){
    appendLog(root,{type:"delivery-suppressed",name:job.name,profile:job.profile,reason:verdict.reason});
    recordActivity(root,job.profile,"delivery-suppressed","Heartbeat '"+job.name+"' update held: "+verdict.reason);
   }else{
    try{await deps.deliver(job.channelId,"🫀 SAM heartbeat · "+job.name+"\n\n"+reply);}catch{appendLog(root,{type:"delivery-failed",name:job.name});}
   }
  }
 }
 if(dirty)saveJobs(root,jobs);
 if(stateDirty)saveState(root,state);
 // Legs (P5): every tick also drains the background queue, so a task a chat
 // handed off runs within one tick on the deep background budget tier and
 // posts its result back into its chat. Drained after due jobs so a poll's
 // cheap tier never competes with the deep work.
 const background=await drainBackgroundTasks(root,{runTurn:deps.runBackgroundTurn??deps.runTurn});
 if(background.ran.length||background.failed.length||background.recovered.length)appendLog(root,{type:"background",ran:background.ran.length,failed:background.failed.length,recovered:background.recovered.length});
 return {consolidation,ran,changed,unchanged,background};
}
// Default delivery: Telegram channels send to their known owner chats, Discord
// channels post via webhook. Anything else is a no-op for this tick.
export async function deliverToChannel(root:string,channelId:string,text:string,sendTelegram:(chatId:number,text:string)=>Promise<void>,postDiscordFn:(channel:ReturnType<typeof channels>[number],text:string)=>Promise<number>):Promise<void>{
 const channel=channels(root).find(c=>c.id===channelId&&c.enabled);
 if(!channel)return;
 if(channel.kind==="discord"){await postDiscordFn(channel,text);return;}
 if(channel.kind==="telegram"){
  const state=loadBridgeState(root);
  for(const key of Object.keys(state.chats))await sendTelegram(Number(key),text);
 }
}
