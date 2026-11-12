import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { ChatStore } from "./chats.js";
import { PreferenceStore, extractPreferences } from "./preferences.js";
import { detectCorrection, proposeCorrection, withoutCorrectedRules } from "./corrections.js";
import { readDashboardConfig } from "./dashboard.js";
import { channels } from "./channels.js";
import { loadBridgeState } from "./telegram.js";
import { recordActivity } from "./activity.js";
import { writeEpisode, type EpisodeChat } from "./episodes.js";
import { drainBackgroundTasks } from "./background.js";
import { drainCodingTasks, type CodingTask } from "./coding.js";
import { drainEngineTasks, type EngineTask } from "./engine.js";
import { revisitDueLoops, type LoopRevisitResult } from "./loop-revisit.js";
import type { GoldfishRecord } from "./goldfish.js";
import { assessDelivery } from "./worthiness.js";
import { runSkillCurator } from "./skill-author.js";
import { compileSchedule, nextCronRun, ownerTimezone, scriptArgv, scriptCommandNames, validateTimezone } from "./schedule.js";
import { markAttemptFailed, markDelivered, markSuppressed, pendingDeliveries, queueDelivery } from "./delivery-outbox.js";
import { execFile } from "node:child_process";

// Heartbeats: SAM's scheduled self-maintenance and self-directed work.
// Every tick does two things:
//  1. Consolidation - scan new user messages across chats, capture preferences,
//     and promote the ones that earned it into law. This is how SAM's memory
//     updates itself instead of waiting to be told twice.
//  2. Due jobs - standing prompts ("check the stack, flag changes") executed as
//     real chat turns under a profile, with the reply optionally delivered to a
//     channel. A heartbeat is a chat SAM has with itself on a timer.
// Every tick appends to .sam/heartbeats.jsonl, so the engine room is auditable.
export interface HeartbeatJob { id:string; name:string; minutes:number; profile:string; prompt:string; channelId:string|null; enabled:boolean; lastRun:string|null;
 // Real cron (Phase C item 1): every field below is optional and
 // absent on legacy interval jobs, which read exactly as before.
 // cron set = the job fires on a wall-clock schedule in timezone;
 // schedule keeps the owner's original phrase; mode "script" runs
 // an allowlisted no-agent command instead of a model turn;
 // createdAt anchors a cron job's first next-run computation.
 // onceAt (Telegram reminder gaps, 2026-11-10): a one-shot job -
 // the absolute UTC instant it fires, after which the tick that
 // ran it removes the job (self-retiring; see runHeartbeat).
 cron?:string|null; schedule?:string|null; timezone?:string; mode?:"agent"|"script"; script?:string|null; createdAt?:string; onceAt?:string|null }
function jobsPath(root:string){return join(resolve(root),".sam","heartbeat-jobs.json");}
function jobsDbPath(root:string){return join(resolve(root),".sam","heartbeat-jobs.db");}
function statePath(root:string){return join(resolve(root),".sam","heartbeat-state.json");}
function stateDbPath(root:string){return join(resolve(root),".sam","heartbeat-state.db");}
function logPath(root:string){return join(resolve(root),".sam","heartbeats.jsonl");}
// State convergence (UNIFICATION item 4, second store): the job
// store is SQLite (.sam/heartbeat-jobs.db, the actions pattern),
// one row per job holding the job's full JSON (the optional
// schedule fields evolve; the row is the record). The old
// heartbeat-jobs.json was rewritten whole on every create, every
// remove, and every tick that advanced a lastRun or retired a
// one-shot - and three processes write this store (the dashboard
// executing approved proposals, the CLI, the heartbeat tick), so
// two writers holding the same snapshot silently lost the second
// one's change. Here each mutation is a single-row INSERT,
// UPDATE, or DELETE, and connections carry a busy_timeout (the
// F1 cross-process lock seam) so a writer waits out a peer's
// transaction instead of dying on "database is locked". First
// open imports a legacy heartbeat-jobs.json in file order and
// renames it heartbeat-jobs.json.migrated - imported, never
// deleted; a malformed file imports nothing and is left in
// place. A pure read on an install with neither file creates
// nothing, so read-only audits stay read-only. The P9 backup
// snapshots every .sam/*.db generically, so the migrated store
// is carried with no backup change.
function openJobsStore(root:string):Database.Database{
 mkdirSync(join(resolve(root),".sam"),{recursive:true});
 const db=openDatabase(jobsDbPath(root));
 db.exec("CREATE TABLE IF NOT EXISTS heartbeat_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
 migrateLegacyJobs(db,root);
 return db;
}
function migrateLegacyJobs(db:Database.Database,root:string):void{
 const {n}=db.prepare("SELECT COUNT(*) AS n FROM heartbeat_jobs").get() as {n:number};
 if(n>0)return;
 const file=jobsPath(root);
 if(!existsSync(file))return;
 let data:unknown;
 try{data=JSON.parse(readFileSync(file,"utf8"));}catch{return;}
 if(!Array.isArray(data))return;
 const insert=db.prepare("INSERT OR IGNORE INTO heartbeat_jobs (id, data) VALUES (?, ?)");
 const importAll=db.transaction((rows:unknown[])=>{
  for(const raw of rows){
   if(!raw||typeof raw!=="object")continue;
   const job=raw as Partial<HeartbeatJob>;
   if(typeof job.id!=="string"||!job.id)continue;
   insert.run(job.id,JSON.stringify(job));
  }
 });
 importAll(data);
 renameSync(file,file+".migrated");
}
export function heartbeatJobs(root:string):HeartbeatJob[]{
 if(!existsSync(jobsDbPath(root))&&!existsSync(jobsPath(root)))return [];
 const db=openJobsStore(root);
 try{
  const rows=db.prepare("SELECT data FROM heartbeat_jobs ORDER BY rowid").all() as Array<{data:string}>;
  const items=rows.map(r=>JSON.parse(r.data) as HeartbeatJob);
  if(items.length>32)throw Error("Invalid heartbeat jobs file");
  return items;
 }finally{db.close();}
}
function insertJob(root:string,job:HeartbeatJob){const db=openJobsStore(root);try{db.prepare("INSERT INTO heartbeat_jobs (id, data) VALUES (?, ?)").run(job.id,JSON.stringify(job));}finally{db.close();}}
function updateJobRow(root:string,job:HeartbeatJob){const db=openJobsStore(root);try{db.prepare("UPDATE heartbeat_jobs SET data = ? WHERE id = ?").run(JSON.stringify(job),job.id);}finally{db.close();}}
function deleteJobRow(root:string,id:string):boolean{const db=openJobsStore(root);try{return db.prepare("DELETE FROM heartbeat_jobs WHERE id = ?").run(id).changes>0;}finally{db.close();}}
// The store's own update door: patch one job's record in place
// (the tick's lastRun advances ride updateJobRow directly; this
// is the named seam for operator/test mutations, so nothing ever
// needs to write around the store).
export function updateHeartbeatJob(root:string,id:string,patch:Partial<HeartbeatJob>):HeartbeatJob|null{
 const job=heartbeatJobs(root).find(j=>j.id===id);
 if(!job)return null;
 const next:HeartbeatJob={...job,...patch,id:job.id};
 updateJobRow(root,next);
 return next;
}
function createJob(root:string,input:{name:string;minutes:number;profile:string;prompt:string;channelId:string|null;cron?:string|null;schedule?:string|null;timezone?:string;mode?:"agent"|"script";script?:string|null;onceAt?:string|null}):HeartbeatJob{
 if(jobNameTaken(root,input.name))throw Error("Heartbeat limit or duplicate name");
 const item:HeartbeatJob={id:randomUUID(),name:input.name,minutes:input.minutes,profile:input.profile,prompt:input.prompt,channelId:input.channelId,enabled:true,lastRun:null,createdAt:new Date().toISOString()};
 if(input.cron||input.schedule||input.onceAt){item.cron=input.cron??null;item.schedule=input.schedule??null;item.timezone=input.timezone??ownerTimezone();}
 if(input.onceAt)item.onceAt=input.onceAt;
 if(input.mode==="script"){item.mode="script";item.script=input.script??null;}
 insertJob(root,item);return item;
}
function jobNameTaken(root:string,name:string):boolean{const items=heartbeatJobs(root);return items.length>=32||items.some(j=>j.name===name);}
function validJobName(name:string){if(!/^[a-zA-Z0-9 _-]{1,80}$/.test(name))throw Error("Invalid heartbeat name");}
function validJobProfile(profile:string){if(!/^[a-z][a-z0-9._-]{0,63}$/.test(profile))throw Error("Invalid profile");}
export function addHeartbeatJob(root:string,name:string,minutes:number,profile:string,prompt:string,channelId:string|null=null):HeartbeatJob{
 validJobName(name);
 if(!Number.isSafeInteger(minutes)||minutes<5||minutes>10080)throw Error("Interval must be 5 to 10080 minutes");
 validJobProfile(profile);
 if(!prompt.trim()||prompt.length>2000)throw Error("Invalid heartbeat prompt");
 return createJob(root,{name,minutes,profile,prompt:prompt.trim(),channelId});
}
// One scheduling surface (Phase C item 1): the schedule phrase is
// an interval, a wall-clock time, a 5-field cron expression, or
// natural language compiled to cron (schedule.ts). An agent job
// carries a prompt; a script job names one allowlisted command
// and needs no prompt - its stdout is the output.
export function addScheduledJob(root:string,input:{name:string;profile:string;schedule:string;timezone?:string;prompt?:string;script?:string|null;channelId?:string|null}):HeartbeatJob{
 validJobName(input.name);validJobProfile(input.profile);
 // The timezone default is the OWNER's timezone, not UTC (Telegram
 // reminder gaps, 2026-11-10): a job the owner asked for at "8am"
 // fires at 8am where the owner lives. An explicit timezone wins.
 const timezone=validateTimezone(input.timezone??ownerTimezone());
 const compiled=compileSchedule(input.schedule,timezone);
 if(compiled.kind==="cron"&&!compiled.cron)throw Error("Invalid schedule");
 if(compiled.kind==="once"&&!compiled.onceAt)throw Error("Invalid schedule");
 if(input.script!=null&&input.script!==""){
  scriptArgv(root,input.script); // throws naming the allowlist
  return createJob(root,{name:input.name,minutes:compiled.minutes??0,profile:input.profile,prompt:"",channelId:input.channelId??null,cron:compiled.cron,schedule:input.schedule.trim(),timezone,mode:"script",script:input.script,onceAt:compiled.onceAt});
 }
 const prompt=input.prompt??"";
 if(!prompt.trim()||prompt.length>2000)throw Error("Invalid heartbeat prompt");
 return createJob(root,{name:input.name,minutes:compiled.minutes??0,profile:input.profile,prompt:prompt.trim(),channelId:input.channelId??null,cron:compiled.cron,schedule:input.schedule.trim(),timezone,onceAt:compiled.onceAt});
}
// When a job next fires: interval jobs keep the legacy arithmetic
// (last run + interval, due now if never run); cron jobs fire at
// the next wall-clock match after their last run (or creation)
// in their own timezone.
export function jobNextRun(job:HeartbeatJob,from:Date=new Date()):Date|null{
 // A one-shot fires at its stored instant, once: before it, that
 // instant; after it has run, never again (the running tick also
 // removes the job - this guard is the belt to that brace).
 if(job.onceAt){
  if(job.lastRun)return null;
  return new Date(job.onceAt);
 }
 if(job.cron){
  const anchor=job.lastRun?Date.parse(job.lastRun):(job.createdAt?Date.parse(job.createdAt):from.getTime());
  const next=nextCronRun(job.cron,job.timezone??"UTC",new Date(anchor));
  if(!next)return null;
  return next.getTime()<=from.getTime()?from:next;
 }
 if(!job.lastRun)return from;
 return new Date(Date.parse(job.lastRun)+job.minutes*60000);
}
export function jobDue(job:HeartbeatJob,now:Date=new Date()):boolean{
 if(!job.enabled)return false;
 const next=jobNextRun(job,now);
 return next!==null&&next.getTime()<=now.getTime();
}
export function removeHeartbeatJob(root:string,id:string):boolean{
 if(!heartbeatJobs(root).some(j=>j.id===id))return false;
 return deleteJobRow(root,id);
}
export interface HeartbeatOutputRecord { hash:string; at:string; preview:string; sig?:string }
interface HeartbeatState { chats:Record<string,string>; lastTick:string|null; outputs?:Record<string,HeartbeatOutputRecord> }
// State convergence (UNIFICATION item 4, third store): the tick's
// diff/watermark state is SQLite (.sam/heartbeat-state.db, the
// actions/jobs pattern), one keyed row per part - "meta" holds
// lastTick, "chat:<id>" one consolidation watermark, "output:<id>"
// one job's P3 diff record (its JSON). The old
// heartbeat-state.json was rewritten whole on every consolidation
// and every tick that recorded an output, and two tick processes
// (the systemd timer's, a manual CLI tick's) holding the same
// snapshot silently lost the second writer's parts: watermarks
// reverted (consolidation re-scans and re-notes captured
// messages) or a job's diff baseline reverted (an unchanged stack
// re-announces as changed - the noise P3 killed). Here each save
// upserts exactly the parts the in-memory state carries, in one
// transaction, and connections carry a busy_timeout (the F1
// cross-process lock seam) so a writer waits out a peer's
// transaction instead of dying on "database is locked". First
// open imports a legacy heartbeat-state.json and renames it
// heartbeat-state.json.migrated - imported, never deleted; a
// malformed file imports nothing and is left in place (the
// actions/jobs contract; the old reader threw on one, which
// killed the whole tick). A pure read on an install with neither
// file creates nothing, so read-only audits stay read-only. The
// P9 backup snapshots every .sam/*.db generically, so the
// migrated store is carried with no backup change.
function openStateStore(root:string):Database.Database{
 mkdirSync(join(resolve(root),".sam"),{recursive:true});
 const db=openDatabase(stateDbPath(root));
 db.exec("CREATE TABLE IF NOT EXISTS heartbeat_state (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
 migrateLegacyState(db,root);
 return db;
}
function migrateLegacyState(db:Database.Database,root:string):void{
 const {n}=db.prepare("SELECT COUNT(*) AS n FROM heartbeat_state").get() as {n:number};
 if(n>0)return;
 const file=statePath(root);
 if(!existsSync(file))return;
 let value:unknown;
 try{value=JSON.parse(readFileSync(file,"utf8"));}catch{return;}
 if(!value||typeof value!=="object"||Array.isArray(value))return;
 const legacy=value as Partial<HeartbeatState>;
 const upsert=db.prepare("INSERT OR IGNORE INTO heartbeat_state (key, data) VALUES (?, ?)");
 const importAll=db.transaction(()=>{
  if(typeof legacy.lastTick==="string")upsert.run("meta",JSON.stringify({lastTick:legacy.lastTick}));
  if(legacy.chats&&typeof legacy.chats==="object"&&!Array.isArray(legacy.chats)){
   for(const [chatId,watermark] of Object.entries(legacy.chats))if(typeof watermark==="string")upsert.run("chat:"+chatId,JSON.stringify(watermark));
  }
  if(legacy.outputs&&typeof legacy.outputs==="object"&&!Array.isArray(legacy.outputs)){
   for(const [jobId,record] of Object.entries(legacy.outputs))if(record&&typeof record==="object")upsert.run("output:"+jobId,JSON.stringify(record));
  }
 });
 importAll();
 renameSync(file,file+".migrated");
}
function loadState(root:string):HeartbeatState{
 if(!existsSync(stateDbPath(root))&&!existsSync(statePath(root)))return {chats:{},lastTick:null,outputs:{}};
 const db=openStateStore(root);
 try{
  const state:HeartbeatState={chats:{},lastTick:null,outputs:{}};
  const rows=db.prepare("SELECT key, data FROM heartbeat_state").all() as Array<{key:string;data:string}>;
  for(const row of rows){
   try{
    if(row.key==="meta"){const meta=JSON.parse(row.data) as {lastTick?:unknown};if(typeof meta.lastTick==="string")state.lastTick=meta.lastTick;}
    else if(row.key.startsWith("chat:")){const watermark:unknown=JSON.parse(row.data);if(typeof watermark==="string")(state.chats as Record<string,string>)[row.key.slice(5)]=watermark;}
    else if(row.key.startsWith("output:")){const record:unknown=JSON.parse(row.data);if(record&&typeof record==="object")(state.outputs as Record<string,HeartbeatOutputRecord>)[row.key.slice(7)]=record as HeartbeatOutputRecord;}
   }catch{/* a torn row never kills a tick; its part reads as absent */}
  }
  return state;
 }finally{db.close();}
}
// The store's read door (tests and audits read the state through
// the store's own shape, never around it - the actions precedent).
export function heartbeatState(root:string):HeartbeatState{return loadState(root);}
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
function saveState(root:string,state:HeartbeatState){
 const db=openStateStore(root);
 try{
  const upsert=db.prepare("INSERT INTO heartbeat_state (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data");
  const writeAll=db.transaction(()=>{
   upsert.run("meta",JSON.stringify({lastTick:state.lastTick}));
   for(const [chatId,watermark] of Object.entries(state.chats))upsert.run("chat:"+chatId,JSON.stringify(watermark));
   for(const [jobId,record] of Object.entries(state.outputs??{}))upsert.run("output:"+jobId,JSON.stringify(record));
  });
  writeAll();
 }finally{db.close();}
}
export function heartbeatLog(root:string,limit=20):Array<Record<string,unknown>>{
 if(!existsSync(logPath(root)))return [];
 return readFileSync(logPath(root),"utf8").split("\n").filter(Boolean).slice(-limit).map(line=>{try{return JSON.parse(line) as Record<string,unknown>;}catch{return {raw:line};}});
}
function appendLog(root:string,entry:Record<string,unknown>){mkdirSync(join(resolve(root),".sam"),{recursive:true});appendFileSync(logPath(root),JSON.stringify({at:new Date().toISOString(),...entry})+"\n");}
export function consolidatePreferences(root:string):{scanned:number;noted:number;promoted:string[];episodes:string[];corrections:number;visitorSkipped:number;curator:string[]}{
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
  // Skill curator (Phase B item 3): a deterministic pass over the
  // skill library on the same tick - no model call, so the cheap
  // tier costs zero. It flags duplicate, shadowed, orphaned, and
  // unmatchable skills into .sam/skill-curator.db with a suggested
  // patch each, and ledgers only when the finding set changes. A
  // curator failure never breaks a tick.
  let curator:string[]=[];
  try{curator=runSkillCurator(root).findings.map(f=>f.kind+":"+f.skills.join("+"));}catch{/* the curator never breaks a tick */}
  state.lastTick=new Date().toISOString();saveState(root,state);
  appendLog(root,{type:"consolidate",scanned,noted,promoted,episodes,corrections,visitorSkipped,curator});
  return {scanned,noted,promoted,episodes,corrections,visitorSkipped,curator};
 }finally{db.close();prefs.close();}
}
export interface HeartbeatDeps { runTurn:(chatId:string,content:string)=>Promise<string>; runBackgroundTurn?:(chatId:string,content:string)=>Promise<string>; ensureChat:(title:string,profile:string)=>Promise<string>; deliver?:(channelId:string,text:string)=>Promise<void>; runScript?:(name:string)=>Promise<{stdout:string;code:number}>; reviewCoding?:(task:CodingTask)=>Promise<GoldfishRecord>; reviewEngine?:(task:EngineTask)=>Promise<GoldfishRecord> }
// Default no-agent script runner: execFile on the allowlist argv -
// no shell, a 60s timeout, a bounded buffer. A non-zero exit is a
// result the caller logs, not a throw; an unknown script name or a
// spawn failure throws (the allowlist check happens at job creation
// too, so this is a belt-and-braces refusal).
export function defaultRunScript(root:string):(name:string)=>Promise<{stdout:string;code:number}>{
 return (name:string)=>new Promise((resolvePromise,reject)=>{
  let argv:string[];
  try{argv=scriptArgv(root,name);}catch(e){reject(e as Error);return;}
  execFile(argv[0],argv.slice(1),{timeout:60000,maxBuffer:256*1024,windowsHide:true},(err,stdout)=>{
   const code=(err as (NodeJS.ErrnoException&{code?:number|string})|null)?.code;
   if(err&&typeof code!=="number"){reject(err);return;}
   resolvePromise({stdout:String(stdout??""),code:typeof code==="number"?code:0});
  });
 });
}
export async function runHeartbeat(root:string,deps:HeartbeatDeps):Promise<{consolidation:ReturnType<typeof consolidatePreferences>;ran:string[];changed:string[];unchanged:string[];failed:string[];deliveries:{delivered:string[];recovered:string[];pending:number};background:{ran:string[];failed:string[];recovered:string[]};coding:{ran:string[];blocked:string[];failed:string[];recovered:string[]};engine:{ran:string[];blocked:string[];failed:string[];recovered:string[]};loops:LoopRevisitResult}>{
 const consolidation=consolidatePreferences(root);
 const tickStart=new Date();
 const deliveryResult:{delivered:string[];recovered:string[];pending:number}={delivered:[],recovered:[],pending:0};
 // Durable delivery outbox (Phase C item 1): deliveries a previous
 // tick queued but never completed (a crash between the job's
 // reply and the channel send, a failed attempt) are redelivered
 // FIRST, before any new work, and land marked recovered - the
 // at-least-once leg of the ledger. Without a deliver door the
 // pending records simply stay pending, untouched.
 if(deps.deliver){
  for(const pending of pendingDeliveries(root)){
   const recovered=pending.attempts>0||Date.parse(pending.queuedAt)<tickStart.getTime();
   try{
    await deps.deliver(pending.channelId,pending.text);
    markDelivered(root,pending.id,recovered);
    deliveryResult.delivered.push(pending.jobName);
    if(recovered)deliveryResult.recovered.push(pending.jobName);
    appendLog(root,{type:"delivery-recovered",name:pending.jobName,profile:pending.profile,recovered});
   }catch(e){markAttemptFailed(root,pending.id,e instanceof Error?e.message:String(e));}
  }
 }
 const jobs=heartbeatJobs(root);const now=new Date();const ran:string[]=[];const changed:string[]=[];const unchanged:string[]=[];const failed:string[]=[];
 // Loaded after consolidation, which saves this same state file for its
 // watermarks; the outputs map below is this tick's addition to it.
 const state=loadState(root);
 let stateDirty=false;
 // Per-job persistence (item 4 store): a tick updates exactly the
 // rows of the jobs that ran, and deletes exactly the retired
 // one-shots - no whole-store rewrite rides a tick anymore.
 const ranJobs=new Set<string>();
 const retired:string[]=[];
 // One-shot retirement (Telegram reminder gaps, 2026-11-10): a
 // one-shot job that has had its run - a delivered or quiet reply,
 // or an isolated failure (already logged as job-failed; leaving
 // the job in place would refire it on every tick forever) - is
 // removed when this tick saves the jobs file, with one ledger
 // line naming the retirement.
 const retireIfOnce=(job:HeartbeatJob)=>{
  if(!job.onceAt||retired.includes(job.id))return;
  retired.push(job.id);
  appendLog(root,{type:"job-retired",name:job.name,profile:job.profile,onceAt:job.onceAt});
  recordActivity(root,job.profile,"heartbeat-retired","One-shot heartbeat '"+job.name+"' fired and retired");
 };
 for(const job of jobs){
  if(!jobDue(job,now))continue;
  const isScript=job.mode==="script";
  let reply:string;
  if(isScript){
   const runScript=deps.runScript??defaultRunScript(root);
   let outcome:{stdout:string;code:number};
   try{outcome=await runScript(job.script??"");}
   catch(e){
    job.lastRun=new Date().toISOString();ranJobs.add(job.id);ran.push(job.name);failed.push(job.name);
    appendLog(root,{type:"job-failed",name:job.name,profile:job.profile,reason:e instanceof Error?e.message:String(e)});
    recordActivity(root,job.profile,"heartbeat-failed","Heartbeat '"+job.name+"' script failed: "+(e instanceof Error?e.message:String(e)).slice(0,160));
    retireIfOnce(job);
    continue;
   }
   job.lastRun=new Date().toISOString();ranJobs.add(job.id);ran.push(job.name);
   if(outcome.code!==0){
    failed.push(job.name);
    appendLog(root,{type:"job-failed",name:job.name,profile:job.profile,code:outcome.code});
    recordActivity(root,job.profile,"heartbeat-failed","Heartbeat '"+job.name+"' script exited "+outcome.code);
    retireIfOnce(job);
    continue;
   }
   reply=outcome.stdout.replace(/\s+$/,"").slice(0,4000);
   if(!reply.trim()){
    // A quiet script is an unchanged job: silence, one log line.
    unchanged.push(job.name);
    appendLog(root,{type:"job-unchanged",name:job.name,profile:job.profile,script:job.script});
    retireIfOnce(job);
    continue;
   }
  }else{
   // Job-failure isolation (gap found 2026-11-10, Phase C item 1 live
   // review): one job's failed turn must not fail the whole tick. The
   // script path already isolates; the agent path now does the same -
   // a thrown turn logs job-failed with the reason, writes one activity
   // line, advances lastRun (the schedule moves on; the failure is the
   // news, recorded once), and the tick continues to the remaining
   // jobs and the background drain instead of wedging every later job
   // on the same failing turn at every tick.
   try{
    const chatId=await deps.ensureChat("Heartbeat · "+job.name,job.profile);
    reply=await deps.runTurn(chatId,job.prompt);
   }catch(e){
    job.lastRun=new Date().toISOString();ranJobs.add(job.id);ran.push(job.name);failed.push(job.name);
    appendLog(root,{type:"job-failed",name:job.name,profile:job.profile,reason:e instanceof Error?e.message:String(e)});
    recordActivity(root,job.profile,"heartbeat-failed","Heartbeat '"+job.name+"' failed: "+(e instanceof Error?e.message:String(e)).slice(0,160));
    retireIfOnce(job);
    continue;
   }
   job.lastRun=new Date().toISOString();ranJobs.add(job.id);ran.push(job.name);
  }
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
   retireIfOnce(job);
   continue;
  }
  changed.push(job.name);
  appendLog(root,{type:"job",name:job.name,profile:job.profile,changed:true,replyPreview:reply.slice(0,300)});
  recordActivity(root,job.profile,"heartbeat","Heartbeat '"+job.name+"' changed: "+reply.replace(/\s+/g," ").trim().slice(0,180));
  if(job.channelId){
   // Queue FIRST in the durable outbox, then decide, then send:
   // a crash anywhere after this line leaves a pending record the
   // next tick redelivers instead of a delivery nobody can prove
   // was ever owed.
   const queued=queueDelivery(root,{jobId:job.id,jobName:job.name,profile:job.profile,channelId:job.channelId,text:"🫀 SAM heartbeat · "+job.name+"\n\n"+reply});
   // Notification worthiness (S5): the reply is already the chat
   // record; pushing it to a channel must first be worth the
   // owner's attention - duplicates, floods, and law-denied
   // topics are held, and the hold is ledgered either way.
   const verdict=assessDelivery(root,{profile:job.profile,kind:"heartbeat",text:reply});
   if(!verdict.deliver){
    markSuppressed(root,queued.id,verdict.reason);
    appendLog(root,{type:"delivery-suppressed",name:job.name,profile:job.profile,reason:verdict.reason});
    recordActivity(root,job.profile,"delivery-suppressed","Heartbeat '"+job.name+"' update held: "+verdict.reason);
   }else if(deps.deliver){
    try{await deps.deliver(job.channelId,queued.text);markDelivered(root,queued.id,false);deliveryResult.delivered.push(job.name);}
    catch(e){markAttemptFailed(root,queued.id,e instanceof Error?e.message:String(e));appendLog(root,{type:"delivery-failed",name:job.name});}
   }
  }
  retireIfOnce(job);
 }
 for(const job of jobs){if(ranJobs.has(job.id)&&!retired.includes(job.id))updateJobRow(root,job);}
 for(const id of retired)deleteJobRow(root,id);
 if(stateDirty)saveState(root,state);
 deliveryResult.pending=pendingDeliveries(root).length;
 // Legs (P5): every tick also drains the background queue, so a task a chat
 // handed off runs within one tick on the deep background budget tier and
 // posts its result back into its chat. Drained after due jobs so a poll's
 // cheap tier never competes with the deep work.
 const background=await drainBackgroundTasks(root,{runTurn:deps.runBackgroundTurn??deps.runTurn});
 if(background.ran.length||background.failed.length||background.recovered.length)appendLog(root,{type:"background",ran:background.ran.length,failed:background.failed.length,recovered:background.recovered.length});
 // Coder C3: the same tick drains the coding loop, after background
 // work, on the same deep tier - a queued coding task plans, edits,
 // verifies, and iterates without the owner watching it happen.
 const coding=await drainCodingTasks(root,{runTurn:deps.runBackgroundTurn??deps.runTurn,review:deps.reviewCoding});
 if(coding.ran.length||coding.blocked.length||coding.failed.length||coding.recovered.length)appendLog(root,{type:"coding",ran:coding.ran.length,blocked:coding.blocked.length,failed:coding.failed.length,recovered:coding.recovered.length});
 // Coder C6: the same tick drains the managed engine queue, after
 // the coding loop - one owner-approved engine run per tick inside
 // its branch sandbox, with SAM verifying and reviewing its work.
 const engine=await drainEngineTasks(root,{review:deps.reviewEngine});
 if(engine.ran.length||engine.blocked.length||engine.failed.length||engine.recovered.length)appendLog(root,{type:"engine",ran:engine.ran.length,blocked:engine.blocked.length,failed:engine.failed.length,recovered:engine.recovered.length});
 // SECOND ANSWERS: the same tick revisits due open loops, last -
 // a loop's re-check is a cheap-tier turn in its own check chat,
 // and only a proven change crosses into the owner's conversation
 // (plus its channel, through the outbox and the S5 gate, inside
 // the revisit engine itself).
 const loops=await revisitDueLoops(root,{runTurn:deps.runTurn,deliver:deps.deliver});
 if(loops.checked.length)appendLog(root,{type:"loops",checked:loops.checked.length,changed:loops.changed.length,resolved:loops.resolved.length,failed:loops.failed.length,held:loops.held.length});
 return {consolidation,ran,changed,unchanged,failed,deliveries:deliveryResult,background,coding,engine,loops};
}
// Default delivery: Telegram channels send to their known owner chats, Discord
// channels post via webhook. Anything else is a no-op for this tick.
export async function deliverToChannel(root:string,channelId:string,text:string,sendTelegram:(chatId:number,text:string)=>Promise<void>,postDiscordFn:(channel:ReturnType<typeof channels>[number],text:string)=>Promise<number>):Promise<void>{
 const channel=channels(root).find(c=>c.id===channelId&&c.enabled);
 if(!channel)return;
 if(channel.kind==="discord"){await postDiscordFn(channel,text);return;}
 if(channel.kind==="telegram"){
  const state=loadBridgeState(root);
  // Chat keys are telegram chat ids, optionally suffixed ":<profile>"
  // when a binding routed that chat to another profile (Phase C item 3);
  // the numeric id is always the part before the suffix.
  for(const key of Object.keys(state.chats))await sendTelegram(Number(key.split(":")[0]),text);
 }
}
