import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { minis } from "./minis.js";

// The web door: how a person reaches their mini. Each mini can have one door,
// addressed by an unguessable key in the path, the same pattern as the
// dashboard token. The raw key is shown once when issued; only its hash is
// stored. A visitor's browser keeps a session id, and each session maps to
// exactly one chat bound to the mini's profile, so a mini's web conversations
// live in the same scoped world as everything else it owns.
// Doors are rate-limited per session and per mini. Preference capture applies
// to OWNER door turns: a mini exists to learn its person, and the owner door
// is the person talking. A door issued in visitor mode (P12) is a customer
// talking to that person's SAM: those chats are marked visitor, and capture
// never runs on them - visitor words become neither law nor confirmed fact.
// Stranger hardening (P10): keys are 256-bit and EXPIRE 30 days after issue -
// a leaked link is a bounded credential, not a forever one, and rotation is
// the renewal. Records written before expiry existed carry no expires_at;
// their expiry is created_at + the same TTL, so no live door dies early and
// none lives forever either. Door text is screened and abuse is counted by
// door-guard.ts; probing and aggregate rate caps live there.
export const DOOR_KEY_TTL_DAYS=30;
export type DoorMode = "owner" | "visitor";
interface Door { mini:string; keyHash:string; enabled:boolean; created_at:string; expires_at?:string; keyVersion?:number; homeLink?:boolean; mode?:DoorMode }
interface DoorSession { mini:string; session:string; chatId:string; updated_at:string }
interface DoorFile { doors:Door[]; sessions:DoorSession[] }
function doorPath(root:string){return join(resolve(root),".sam","mini-doors.json");}
function doorsDbFile(root:string){return join(resolve(root),".sam","mini-doors.db");}
// State convergence (UNIFICATION item 4, thirteenth store): the web-door
// store is SQLite (.sam/mini-doors.db, the pairing two-collection
// pattern), one row per door keyed by mini holding the door's full JSON
// in rowid order, plus one row per session keyed by mini+session holding
// its full JSON in rowid order. The old mini-doors.json ({doors,
// sessions} in ONE file) was rewritten whole on every issue, disable,
// session creation, session touch (sessionChat saves the whole file
// even when only a session's updated_at moved), and session rotation -
// that is, on essentially every door message the dashboard process
// serves - and its writers are two processes (the dashboard, the door
// server itself, and the CLI issuing / rotating / disabling on
// demand), so two writers holding the same snapshot silently lost the
// second one's change: a CLI disable or key rotation could revert
// under a concurrent door message's session save, resurrecting a
// bearer credential the operator just killed (a door key is a P10
// credential - a reverted rotation is a live leaked link again), and
// a session mapping could vanish and split one person's conversation
// across two chats. Here each mutation is a single-row INSERT,
// UPDATE, or upsert (an issue replaces exactly its one door row -
// delete + insert, so a re-issued door moves to the end exactly as
// the old array filter + append did - a disable updates exactly its
// door row, a session touch updates exactly its session row), and
// connections carry a busy_timeout (the F1 cross-process lock seam)
// so a writer waits out a peer's transaction instead of dying on
// "database is locked". First open imports a legacy mini-doors.json
// (doors in order, sessions in order) and renames it
// mini-doors.json.migrated - imported, never deleted; a malformed
// file imports nothing and is left in place (the migrated shape
// reads it as no doors instead of throwing, the channels/pairing
// precedent - the old reader threw "Invalid mini doors file", and
// doorForKey / listDoors ride the dashboard's door handler and
// /api/status, so one torn write took every door down). A pure read
// on an install with neither file creates nothing. The P9 backup
// snapshots every .sam/*.db generically, so the migrated store is
// carried with no backup change.
const MAX_SESSIONS=1000;
function openDoorsStore(root:string):Database.Database{
  const dir=join(resolve(root),".sam");
  mkdirSync(dir,{recursive:true,mode:0o700});
  if(lstatSync(dir).isSymbolicLink())throw new Error("Unsafe SAM state directory");
  const db=openDatabase(doorsDbFile(root));
  db.exec("CREATE TABLE IF NOT EXISTS mini_doors (mini TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS mini_door_sessions (k TEXT PRIMARY KEY, data TEXT NOT NULL)");
  migrateLegacyDoors(db,root);
  return db;
}
function migrateLegacyDoors(db:Database.Database,root:string):void{
  const doors=db.prepare("SELECT COUNT(*) AS n FROM mini_doors").get() as {n:number};
  const sessions=db.prepare("SELECT COUNT(*) AS n FROM mini_door_sessions").get() as {n:number};
  if(doors.n>0||sessions.n>0)return;
  const file=doorPath(root);
  if(!existsSync(file))return;
  let value:unknown;
  try{value=JSON.parse(readFileSync(file,"utf8"));}catch{return;}
  if(!value||typeof value!=="object"||Array.isArray(value))return;
  const legacy=value as DoorFile;
  if(!Array.isArray(legacy.doors)||!Array.isArray(legacy.sessions))return;
  const insertDoor=db.prepare("INSERT OR IGNORE INTO mini_doors (mini, data) VALUES (?, ?)");
  const insertSession=db.prepare("INSERT OR IGNORE INTO mini_door_sessions (k, data) VALUES (?, ?)");
  const importAll=db.transaction((data:DoorFile)=>{
    for(const raw of data.doors){
      if(!raw||typeof raw!=="object")continue;
      const door=raw as Partial<Door>;
      if(typeof door.mini!=="string"||!door.mini)continue;
      insertDoor.run(door.mini,JSON.stringify(door));
    }
    for(const raw of data.sessions){
      if(!raw||typeof raw!=="object")continue;
      const session=raw as Partial<DoorSession>;
      if(typeof session.mini!=="string"||!session.mini||typeof session.session!=="string"||!session.session)continue;
      insertSession.run(sessionKey(session.mini,session.session),JSON.stringify(session));
    }
  });
  importAll(legacy);
  renameSync(file,file+".migrated");
}
function storeExists(root:string):boolean{
  return existsSync(doorsDbFile(root))||existsSync(doorPath(root));
}
function sessionKey(mini:string,session:string):string{return mini+"\0"+session;}
function rowToDoor(data:string):Door|null{
  try{const value:unknown=JSON.parse(data);return value&&typeof value==="object"?value as Door:null;}
  catch{return null;}
}
function rowToSession(data:string):DoorSession|null{
  try{const value:unknown=JSON.parse(data);return value&&typeof value==="object"?value as DoorSession:null;}
  catch{return null;}
}
function readDoors(db:Database.Database):Door[]{
  const rows=db.prepare("SELECT data FROM mini_doors ORDER BY rowid").all() as Array<{data:string}>;
  const items:Door[]=[];
  for(const row of rows){const door=rowToDoor(row.data);if(door)items.push(door);}
  return items;
}
function readSessions(db:Database.Database):DoorSession[]{
  const rows=db.prepare("SELECT data FROM mini_door_sessions ORDER BY rowid").all() as Array<{data:string}>;
  const items:DoorSession[]=[];
  for(const row of rows){const session=rowToSession(row.data);if(session)items.push(session);}
  return items;
}
function load(root:string):DoorFile{
  if(!storeExists(root))return {doors:[],sessions:[]};
  const db=openDoorsStore(root);
  try{return {doors:readDoors(db),sessions:readSessions(db)};}finally{db.close();}
}
// The store's read door (the readPairingStore precedent): the full
// door snapshot read through the store's own shape. A pure read on
// an install with neither file creates nothing.
export function readDoorStore(root:string):DoorFile{
  return load(root);
}
function hashKey(key:string):string{return createHash("sha256").update(key).digest("hex");}
export function doorExpiry(door:Door):string{
  if(door.expires_at)return door.expires_at;
  const created=Date.parse(door.created_at);
  return new Date((Number.isFinite(created)?created:0)+DOOR_KEY_TTL_DAYS*86400000).toISOString();
}
function doorLive(door:Door,now=Date.now()):boolean{
  return door.enabled&&now<Date.parse(doorExpiry(door));
}
export interface DoorAudit { mini:string; enabled:boolean; expired:boolean; created_at:string; expires_at:string; keyVersion:number; homeLink:boolean; mode:DoorMode; sessions:number }
export function listDoors(root:string,now=Date.now()):DoorAudit[]{
  const file=load(root);
  return file.doors.map(door=>({mini:door.mini,enabled:door.enabled,expired:now>=Date.parse(doorExpiry(door)),created_at:door.created_at,expires_at:doorExpiry(door),keyVersion:door.keyVersion??1,homeLink:!!door.homeLink,mode:door.mode??"owner",sessions:file.sessions.filter(s=>s.mini===door.mini).length}));
}
export function issueDoorKey(root:string,miniName:string,opts?:{homeLink?:boolean;visitor?:boolean}):string{
  // "sam" is the core itself: the main SAM gets a door too, not just the minis.
  if(miniName!=="sam"&&!minis(root).some(m=>m.name===miniName))throw new Error("Mini not found");
  const key=randomBytes(32).toString("hex");
  const now=new Date();
  // Door mode (P12): an owner door is the mini's own person talking; a
  // visitor door is a customer of theirs. Records written before modes
  // existed read as owner doors, so live doors keep learning their person.
  const door:Door={mini:miniName,keyHash:hashKey(key),enabled:true,homeLink:!!opts?.homeLink,mode:opts?.visitor?"visitor":"owner",created_at:now.toISOString(),expires_at:new Date(now.getTime()+DOOR_KEY_TTL_DAYS*86400000).toISOString(),keyVersion:2};
  const db=openDoorsStore(root);
  try{
    // Replace exactly this mini's door row: delete + insert moves a
    // re-issued door to the end, the old array filter + append order.
    const replace=db.transaction(()=>{
      db.prepare("DELETE FROM mini_doors WHERE mini = ?").run(miniName);
      db.prepare("INSERT INTO mini_doors (mini, data) VALUES (?, ?)").run(miniName,JSON.stringify(door));
    });
    replace();
  }finally{db.close();}
  return key;
}
export function doorModeForKey(root:string,key:string):DoorMode|null{
  if(!keyShapeOk(key))return null;
  const wanted=Buffer.from(hashKey(key),"hex");
  for(const door of load(root).doors){
    if(!doorLive(door))continue;
    const stored=Buffer.from(door.keyHash,"hex");
    if(stored.length===wanted.length&&timingSafeEqual(stored,wanted))return door.mode??"owner";
  }
  return null;
}
export function disableDoor(root:string,miniName:string):boolean{
  if(!storeExists(root))return false;
  const db=openDoorsStore(root);
  try{
    const row=db.prepare("SELECT data FROM mini_doors WHERE mini = ?").get(miniName) as {data:string}|undefined;
    const door=row?rowToDoor(row.data):null;
    if(!door||!door.enabled)return false;
    door.enabled=false;
    db.prepare("UPDATE mini_doors SET data = ? WHERE mini = ?").run(JSON.stringify(door),miniName);
    return true;
  }finally{db.close();}
}
export function doorEnabled(root:string,miniName:string):boolean{return load(root).doors.some(d=>d.mini===miniName&&doorLive(d));}
function keyShapeOk(key:string):boolean{return /^[0-9a-f]{32}$/.test(key)||/^[0-9a-f]{64}$/.test(key);}
export function doorForKey(root:string,key:string):string|null{
  if(!keyShapeOk(key))return null;
  const wanted=Buffer.from(hashKey(key),"hex");
  for(const door of load(root).doors){
    if(!doorLive(door))continue;
    const stored=Buffer.from(door.keyHash,"hex");
    if(stored.length===wanted.length&&timingSafeEqual(stored,wanted))return door.mini;
  }
  return null;
}
export function doorHomeLink(root:string,key:string):boolean{
  if(!keyShapeOk(key))return false;
  const wanted=Buffer.from(hashKey(key),"hex");
  for(const door of load(root).doors){
    if(!doorLive(door))continue;
    const stored=Buffer.from(door.keyHash,"hex");
    if(stored.length===wanted.length&&timingSafeEqual(stored,wanted))return !!door.homeLink;
  }
  return false;
}
export function peekSessionChat(root:string,miniName:string,session:string):string|null{
  if(!/^[A-Za-z0-9-]{16,64}$/.test(session))return null;
  return load(root).sessions.find(s=>s.mini===miniName&&s.session===session)?.chatId??null;
}
export function sessionChat(root:string,miniName:string,session:string,createChat:()=>string):string{
  if(!/^[A-Za-z0-9-]{16,64}$/.test(session))throw new Error("Invalid session");
  if(storeExists(root)){
    const db=openDoorsStore(root);
    try{
      const row=db.prepare("SELECT data FROM mini_door_sessions WHERE k = ?").get(sessionKey(miniName,session)) as {data:string}|undefined;
      const found=row?rowToSession(row.data):null;
      if(found){
        // The touch: exactly this session's row moves, nothing else.
        found.updated_at=new Date().toISOString();
        db.prepare("UPDATE mini_door_sessions SET data = ? WHERE k = ?").run(JSON.stringify(found),sessionKey(miniName,session));
        return found.chatId;
      }
    }finally{db.close();}
  }
  const chatId=createChat();
  const record:DoorSession={mini:miniName,session,chatId,updated_at:new Date().toISOString()};
  const db=openDoorsStore(root);
  try{
    const insert=db.transaction(()=>{
      db.prepare("INSERT INTO mini_door_sessions (k, data) VALUES (?, ?)").run(sessionKey(miniName,session),JSON.stringify(record));
      // The 1,000-session cap, pruned oldest-first (the old slice(-1000)).
      const {n}=db.prepare("SELECT COUNT(*) AS n FROM mini_door_sessions").get() as {n:number};
      if(n>MAX_SESSIONS)db.prepare("DELETE FROM mini_door_sessions WHERE rowid IN (SELECT rowid FROM mini_door_sessions ORDER BY rowid ASC LIMIT ?)").run(n-MAX_SESSIONS);
    });
    insert();
  }finally{db.close();}
  return chatId;
}
export function rotateSessionChat(root:string,miniName:string,session:string,createChat:()=>string):string{
  const existing=storeExists(root)?load(root):{doors:[],sessions:[]};
  const chatId=createChat();
  const found=existing.sessions.find(s=>s.mini===miniName&&s.session===session);
  const record:DoorSession=found?{...found,chatId,updated_at:new Date().toISOString()}:{mini:miniName,session,chatId,updated_at:new Date().toISOString()};
  const db=openDoorsStore(root);
  try{
    db.prepare("INSERT INTO mini_door_sessions (k, data) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET data = excluded.data").run(sessionKey(miniName,session),JSON.stringify(record));
  }finally{db.close();}
  return chatId;
}
export class RateLimiter {
  private hits=new Map<string,number[]>();
  constructor(private perWindow=30,private windowMs=3600000,private minGapMs=2000){}
  allow(key:string,now=Date.now()):boolean{
    const list=(this.hits.get(key)??[]).filter(t=>now-t<this.windowMs);
    if(list.length>=this.perWindow)return false;
    if(list.length&&now-list[list.length-1]<this.minGapMs)return false;
    list.push(now);this.hits.set(key,list);return true;
  }
}
function esc(text:string):string{return text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
export function miniDoorPage(person:string,miniName:string,homeLink=false):string{
  const core=miniName==="sam";
  const title=core?"SAM":esc(person)+"'s SAM";
  const hint=core?"Your main SAM. Everything it knows, it knows for you.":("Say hello. This is "+esc(person)+"'s own SAM, it only knows their world.");
  const homeAnchor=homeLink?'<a href="/sam" style="margin-left:auto;color:#80b4ff;text-decoration:none;font-size:14px">Main SAM</a>':"";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title><style>
*{box-sizing:border-box}body{margin:0;background:#101114;color:#f2f3f5;font:16px/1.5 -apple-system,"Segoe UI",sans-serif;height:100dvh;display:flex;flex-direction:column}
header{padding:14px 18px;border-bottom:1px solid #26282e;display:flex;gap:10px;align-items:center;color:#dbe7ff}header svg{width:22px;height:22px;stroke:#80b4ff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}header strong{font-size:17px;color:#f2f3f5}
#thread{flex:1;overflow-y:auto;padding:18px 14px;display:flex;flex-direction:column;gap:10px}
.bubble{max-width:88%;padding:10px 13px;border-radius:16px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text;-webkit-touch-callout:default;position:relative}
.bubble.user{align-self:flex-end;background:#245a9c;border-bottom-right-radius:5px}.bubble.assistant{align-self:flex-start;background:#1d1f24;border:1px solid #2b2e35;border-bottom-left-radius:5px}
.copy{float:right;margin:0 0 6px 10px;min-height:36px;padding:8px 12px;background:#0008;border:0;border-radius:9px;color:#e6e9ee;font-size:13px;cursor:pointer}
#toBottom{position:fixed;right:16px;bottom:96px;width:42px;height:42px;border-radius:50%;background:#282a30;border:1px solid #3a3d44;color:#f2f3f5;display:none;align-items:center;justify-content:center;font-size:18px;cursor:pointer}
form{display:flex;gap:8px;padding:12px 14px calc(12px + env(safe-area-inset-bottom));border-top:1px solid #26282e;background:#15161a}
textarea{flex:1;resize:none;background:#1d1f24;border:1px solid #33363d;border-radius:12px;color:#f2f3f5;padding:11px 12px;font:inherit;max-height:120px}
button.send{background:#2f6fbd;border:0;border-radius:12px;color:#fff;padding:0 18px;font:inherit;cursor:pointer}button.send:disabled{opacity:.5}
.hint{padding:26px 10px;text-align:center;color:#9398a4}
</style></head><body>
<header><svg viewBox="0 0 24 24"><path d="M18 11c-1.5 0-2.5.5-3 2" />
  <path d="M4 6a2 2 0 0 0-2 2v4a5 5 0 0 0 5 5 8 8 0 0 1 5 2 8 8 0 0 1 5-2 5 5 0 0 0 5-5V8a2 2 0 0 0-2-2h-3a8 8 0 0 0-5 2 8 8 0 0 0-5-2z" />
  <path d="M6 11c1.5 0 2.5.5 3 2" /></svg><strong>${title}</strong>${homeAnchor}</header>
<div id="thread"><div class="hint">${hint}</div></div>
<button id="toBottom" title="Jump to latest">&#8595;</button>
<form id="composer"><textarea id="message" rows="1" maxlength="2000" placeholder="Message SAM..."></textarea><button class="send" id="send">Send</button></form>
<script>
const KEY=location.pathname.split("/").pop();
let session=localStorage.getItem("sam-mini-session");
if(!session){session=(crypto.randomUUID?crypto.randomUUID():"s"+Date.now()+Math.random().toString(16).slice(2));localStorage.setItem("sam-mini-session",session);}
const thread=document.getElementById("thread"),input=document.getElementById("message"),send=document.getElementById("send"),toBottom=document.getElementById("toBottom");
fetch("/mini/"+KEY+"/history?session="+encodeURIComponent(session)).then(r=>r.json()).then(d=>{for(const m of (d.messages||[]))bubble(m.role,m.content);}).catch(()=>{});
function fallbackCopyText(text){try{var ta=document.createElement("textarea");ta.value=text;ta.readOnly=true;ta.style.position="fixed";ta.style.top="0";ta.style.left="0";ta.style.opacity="0";ta.style.fontSize="16px";document.body.append(ta);ta.focus();ta.setSelectionRange(0,text.length);var ok=false;try{ok=document.execCommand("copy");}catch(e){ok=false;}ta.remove();return ok;}catch(e){return false;}}
function bubble(role,text){const hint=thread.querySelector(".hint");if(hint)hint.remove();const b=document.createElement("div");b.className="bubble "+role;const c=document.createElement("button");c.className="copy";c.textContent="Copy";c.onclick=async()=>{let ok=fallbackCopyText(text);if(!ok&&navigator.clipboard&&window.isSecureContext){try{await navigator.clipboard.writeText(text);ok=true;}catch(e){ok=false;}}c.textContent=ok?"Copied":"Long-press text to copy";setTimeout(()=>{c.textContent="Copy";},1600);};const sp=document.createElement("span");sp.textContent=text;b.append(c,sp);thread.append(b);thread.scrollTop=thread.scrollHeight;}
thread.addEventListener("scroll",()=>{const d=thread.scrollHeight-thread.scrollTop-thread.clientHeight;toBottom.style.display=d>320?"flex":"none";});
toBottom.onclick=()=>{thread.scrollTo({top:thread.scrollHeight,behavior:"smooth"});};
document.getElementById("composer").addEventListener("submit",async(e)=>{e.preventDefault();const text=input.value.trim();if(!text)return;input.value="";bubble("user",text);send.disabled=true;try{const r=await fetch("/mini/"+KEY+"/message",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session,content:text})});const d=await r.json();const replyText=d.reply?(typeof d.reply==="string"?d.reply:(d.reply.content||"")):"";if(replyText)bubble("assistant",replyText);else if(d.error)bubble("assistant",d.error);else if(!d.reply)bubble("assistant","Something went wrong.");}catch(err){bubble("assistant","Connection hiccup. Try again.");}send.disabled=false;input.focus();});
input.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();document.getElementById("composer").requestSubmit();}});
</script></body></html>`;
}
export function newSessionId():string{return randomUUID();}
