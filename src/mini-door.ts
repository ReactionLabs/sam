import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
function load(root:string):DoorFile{
  if(!existsSync(doorPath(root)))return {doors:[],sessions:[]};
  const value:unknown=JSON.parse(readFileSync(doorPath(root),"utf8"));
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid mini doors file");
  return value as DoorFile;
}
function save(root:string,file:DoorFile){mkdirSync(join(resolve(root),".sam"),{recursive:true});writeFileSync(doorPath(root),JSON.stringify(file,null,2),{mode:0o600});}
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
  const file=load(root);
  const rest=file.doors.filter(d=>d.mini!==miniName);
  const now=new Date();
  // Door mode (P12): an owner door is the mini's own person talking; a
  // visitor door is a customer of theirs. Records written before modes
  // existed read as owner doors, so live doors keep learning their person.
  save(root,{...file,doors:[...rest,{mini:miniName,keyHash:hashKey(key),enabled:true,homeLink:!!opts?.homeLink,mode:opts?.visitor?"visitor":"owner",created_at:now.toISOString(),expires_at:new Date(now.getTime()+DOOR_KEY_TTL_DAYS*86400000).toISOString(),keyVersion:2}]});
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
  const file=load(root);let changed=false;
  for(const door of file.doors)if(door.mini===miniName&&door.enabled){door.enabled=false;changed=true;}
  if(changed)save(root,file);return changed;
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
  const file=load(root);
  const found=file.sessions.find(s=>s.mini===miniName&&s.session===session);
  if(found){found.updated_at=new Date().toISOString();save(root,file);return found.chatId;}
  const chatId=createChat();
  const sessions=[...file.sessions,{mini:miniName,session,chatId,updated_at:new Date().toISOString()}].slice(-1000);
  save(root,{...file,sessions});
  return chatId;
}
export function rotateSessionChat(root:string,miniName:string,session:string,createChat:()=>string):string{
  const file=load(root);
  const chatId=createChat();
  const found=file.sessions.find(s=>s.mini===miniName&&s.session===session);
  if(found){found.chatId=chatId;found.updated_at=new Date().toISOString();}
  else file.sessions.push({mini:miniName,session,chatId,updated_at:new Date().toISOString()});
  save(root,file);return chatId;
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
document.getElementById("composer").addEventListener("submit",async(e)=>{e.preventDefault();const text=input.value.trim();if(!text)return;input.value="";bubble("user",text);send.disabled=true;try{const r=await fetch("/mini/"+KEY+"/message",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session,content:text})});const d=await r.json();bubble("assistant",d.reply?d.reply.content||d.reply:(d.error||"Something went wrong."));}catch(err){bubble("assistant","Connection hiccup. Try again.");}send.disabled=false;input.focus();});
input.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();document.getElementById("composer").requestSubmit();}});
</script></body></html>`;
}
export function newSessionId():string{return randomUUID();}
