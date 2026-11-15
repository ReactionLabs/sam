import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordActivity } from "./activity.js";

// Preference memory: what the person likes, captured from their own chats with a
// profile, and the path by which a preference becomes LAW for that profile.
// - An explicit rule ("always...", "never...", "remember: ...") is law the moment
//   it is stated. The person said it as law; SAM records it as law.
// - A like/dislike is noted first. When the same preference is reinforced three
//   times it is promoted to law by a heartbeat. Repetition is the evidence.
// - Law is injected into that profile's system prompt on every chat, is listed
//   in the dashboard status, and can be revoked. Every record carries provenance
//   (which chat it came from) and a reinforcement count. Nothing here is silent.
export type PreferenceKind = "like" | "dislike" | "rule";
export type PreferenceStatus = "noted" | "law" | "revoked";
export interface Preference { id:string; profile:string; statement:string; kind:PreferenceKind; status:PreferenceStatus; hits:number; source:string; created_at:string; updated_at:string }
export const PROMOTE_HITS = 3;
function normalize(statement:string):string{return statement.trim().replace(/\s+/g," ").replace(/[.!]+$/,"");}
function key(profile:string,statement:string):string{return createHash("sha256").update(profile+"\n"+normalize(statement).toLowerCase()).digest("hex");}
// Failure visibility (gap found 2026-11-15, hourly run
// 02:04 EST): preferences.db is the store every profile's
// noted preferences and standing LAW live in, behind this
// one class. The handle opens once in the constructor
// (which also runs the schema creation) and every method
// touched it raw: note rides every turn's preference
// capture, lawsFor rides every turn's prompt assembly,
// list rides the dashboard status and the CLI, promote
// rides the heartbeat, and get / revoke ride the dashboard
// and CLI law doors. A dead preferences.db threw into
// whichever catch wrapped the call with the seam unnamed,
// and any reader folding a dead store as "no preferences"
// would silently drop every profile's standing law dressed
// as an empty store - SAM would answer without its law and
// nothing would count it. Now the store's touches own
// their failure (the chats / providers precedent, adapted
// to a class): a failed touch ledgers ONE
// preference-store-failed line (the constructor's open at
// phase write, because the open performs the schema
// writes; read methods at phase read; mutating methods at
// phase write; actor sam; the verbatim reason collapsed
// and capped; never any preference record - statements are
// the owner's words, not failure data), tags the error, and
// rethrows exactly, so every caller's handling is
// unchanged and reads still fail closed. A touch already
// ledgered by an inner door keeps its one line and gains
// no second. Validation errors (Invalid preference
// statement, Invalid profile) are not store failures and
// ledger nothing. CaptureGuardStore rides the same file
// under its own class and table and is a distinct store by
// the census's rule; it is not this seam.
export type PreferenceStorePhase = "read" | "write";

export function preferenceStoreFailureSummary(phase: PreferenceStorePhase, reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown error";
  return ("Preference store " + phase + " failed: " + clean).slice(0, 200);
}

export function recordPreferenceStoreFailure(root: string, phase: PreferenceStorePhase, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  recordActivity(root, "sam", "preference-store-failed", preferenceStoreFailureSummary(phase, reason));
}

function tagPreferenceStoreLedgered(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    (error as { preferenceStoreLedgered?: boolean }).preferenceStoreLedgered = true;
  }
}

export function isPreferenceStoreLedgered(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && (error as { preferenceStoreLedgered?: boolean }).preferenceStoreLedgered === true;
}

const PREFERENCE_STORE_VALIDATION = [/^Invalid preference statement$/, /^Invalid profile$/];

function isPreferenceStoreValidation(error: unknown): boolean {
  return error instanceof Error && PREFERENCE_STORE_VALIDATION.some(re => re.test(error.message));
}

function failPreferenceStore(root: string, phase: PreferenceStorePhase, error: unknown): never {
  if (!isPreferenceStoreLedgered(error) && !isPreferenceStoreValidation(error)) recordPreferenceStoreFailure(root, phase, error);
  if (!isPreferenceStoreValidation(error)) tagPreferenceStoreLedgered(error);
  throw error;
}

export class PreferenceStore {
  private db:Database.Database;
  private root:string;
  constructor(root:string){
    this.root=resolve(root);
    let db:Database.Database|undefined;
    try {
      const dir=join(this.root,".sam");mkdirSync(dir,{recursive:true});
      db=openDatabase(join(dir,"preferences.db"));
      db.exec(`CREATE TABLE IF NOT EXISTS preferences (id TEXT PRIMARY KEY,profile TEXT NOT NULL,statement TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('like','dislike','rule')),status TEXT NOT NULL CHECK(status IN ('noted','law','revoked')),hits INTEGER NOT NULL DEFAULT 1,source TEXT NOT NULL,pkey TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS preferences_by_profile ON preferences(profile,status);`);
    } catch (error) { try { db?.close(); } catch { /* the open already failed */ } failPreferenceStore(this.root, "write", error); }
    this.db=db!;
  }
  private touch<T>(phase:PreferenceStorePhase, fn:()=>T):T{
    try { return fn(); }
    catch (error) { failPreferenceStore(this.root, phase, error); }
  }
  note(profile:string,statement:string,kind:PreferenceKind,source:string):Preference{
    return this.touch("write",()=>{
    const clean=normalize(statement);
    if(!clean||clean.length>200)throw new Error("Invalid preference statement");
    if(!/^[a-z][a-z0-9._-]{0,63}$/.test(profile)&&profile!=="sam")throw new Error("Invalid profile");
    const now=new Date().toISOString(),k=key(profile,clean);
    const existing=this.db.prepare("SELECT * FROM preferences WHERE pkey=?").get(k) as Preference|undefined;
    if(existing){
      if(existing.status!=="revoked")this.db.prepare("UPDATE preferences SET hits=hits+1,updated_at=? WHERE id=?").run(now,existing.id);
      return {...existing,hits:existing.hits+(existing.status!=="revoked"?1:0),updated_at:now};
    }
    const item:Preference={id:randomUUID(),profile,statement:clean,kind,status:kind==="rule"?"law":"noted",hits:1,source,created_at:now,updated_at:now};
    this.db.prepare("INSERT INTO preferences (id,profile,statement,kind,status,hits,source,pkey,created_at,updated_at) VALUES (@id,@profile,@statement,@kind,@status,@hits,@source,@pkey,@created_at,@updated_at)").run({...item,pkey:k});
    return item;
    });
  }
  promote(profile?:string):Preference[]{
    return this.touch("write",()=>{
    const rows=(profile?this.db.prepare("SELECT * FROM preferences WHERE status='noted' AND hits>=? AND profile=?").all(PROMOTE_HITS,profile):this.db.prepare("SELECT * FROM preferences WHERE status='noted' AND hits>=?").all(PROMOTE_HITS)) as Preference[];
    const now=new Date().toISOString();
    for(const row of rows)this.db.prepare("UPDATE preferences SET status='law',updated_at=? WHERE id=?").run(now,row.id);
    return rows.map(r=>({...r,status:"law" as PreferenceStatus,updated_at:now}));
    });
  }
  list(profile?:string):Preference[]{
    return this.touch("read",()=>{
    return (profile?this.db.prepare("SELECT * FROM preferences WHERE profile=? ORDER BY status,updated_at DESC LIMIT 200").all(profile):this.db.prepare("SELECT * FROM preferences ORDER BY updated_at DESC LIMIT 200").all()) as Preference[];
    });
  }
  lawsFor(profile:string):Preference[]{return this.touch("read",()=>this.db.prepare("SELECT * FROM preferences WHERE profile=? AND status='law' ORDER BY updated_at DESC LIMIT 50").all(profile) as Preference[]);}
  get(id:string):Preference|undefined{return this.touch("read",()=>this.db.prepare("SELECT * FROM preferences WHERE id=?").get(id) as Preference|undefined);}
  revoke(id:string):boolean{return this.touch("write",()=>this.db.prepare("UPDATE preferences SET status='revoked',updated_at=? WHERE id=? AND status!='revoked'").run(new Date().toISOString(),id).changes===1);}
  close(){this.db.close();}
}
// Deterministic v1 extraction from the person's own words. Deliberately narrow:
// it only fires on first-person preference language, caps one hit per pattern
// class per message, and stores the fragment it captured as the statement.
export function extractPreferences(text:string):Array<{statement:string;kind:PreferenceKind}>{
  const out:Array<{statement:string;kind:PreferenceKind}>=[];
  const clean=(raw:string)=>normalize(raw.replace(/^[,:\s]+/,"").replace(/\s+(please|thanks|thank you)$/i,""));
  const push=(statement:string,kind:PreferenceKind)=>{const c=clean(statement);if(c.length>=3&&c.length<=200&&!out.some(o=>o.statement.toLowerCase()===c.toLowerCase()))out.push({statement:c,kind});};
  const t=text.trim();
  const remember=/\bremember(?:\s+that)?\s*[:,-]?\s+(.{3,160})/i.exec(t);if(remember)push(remember[1],"rule");
  const always=/\b(always|never)\s+(.{3,150})/i.exec(t);if(always)push(always[1]+" "+always[2],"rule");
  const like=/\bi\s+(?:really\s+|just\s+)?(like|love|prefer)\s+(.{3,150})/i.exec(t);if(like)push(like[2],"like");
  const dislike=/\bi\s+(?:really\s+)?(hate|dislike|don't like|do not like)\s+(.{3,150})/i.exec(t);if(dislike)push(dislike[2],"dislike");
  const fav=/\bmy\s+favou?rite\s+(.{3,150})/i.exec(t);if(fav)push(fav[1],"like");
  return out.slice(0,3);
}
export const LAW_PROMPT_MAX_CHARS=4000;
// The law block carries a character budget like every other bounded
// context surface (HARNESS INTELLIGENCE item 2): lawsFor caps the
// count at 50, but a statement runs to 200 chars, so the count cap
// alone left the volatile tier able to carry ~10k chars of law with
// no marker when anything was left out. Now whole laws are included
// in order until the budget fills, and any law left out is named by
// count in an omission marker - never dropped silently. The laws
// themselves stay in force in the store; the marker says plainly
// that this prompt did not carry all of them.
export function lawPromptBlock(laws:Preference[]):string{
  if(!laws.length)return "";
  const head=" Standing law for this profile, stated or earned from the owner's own preferences. Follow it unless the owner overrides it in this conversation:";
  const marker=(n:number)=>"- ("+n+" more standing law"+(n===1?"":"s")+" not carried in this prompt to keep it bounded; the full law list is in status)";
  const lines=laws.map(l=>"- "+l.statement);
  const included:string[]=[];let used=head.length;let omitted=0;
  for(const line of lines){const cost=line.length+1;if(used+cost<=LAW_PROMPT_MAX_CHARS){included.push(line);used+=cost;}else{omitted=lines.length-included.length;break;}}
  if(omitted>0){
    while(included.length&&(head.length+included.join("\n").length+1+marker(omitted).length)>LAW_PROMPT_MAX_CHARS){included.pop();omitted++;}
    return head+"\n"+[...included,marker(omitted)].join("\n");
  }
  return head+"\n"+included.join("\n");
}
