import Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

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
export class PreferenceStore {
  private db:Database.Database;
  constructor(root:string){
    const dir=join(resolve(root),".sam");mkdirSync(dir,{recursive:true});
    this.db=new Database(join(dir,"preferences.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS preferences (id TEXT PRIMARY KEY,profile TEXT NOT NULL,statement TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('like','dislike','rule')),status TEXT NOT NULL CHECK(status IN ('noted','law','revoked')),hits INTEGER NOT NULL DEFAULT 1,source TEXT NOT NULL,pkey TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS preferences_by_profile ON preferences(profile,status);`);
  }
  note(profile:string,statement:string,kind:PreferenceKind,source:string):Preference{
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
  }
  promote(profile?:string):Preference[]{
    const rows=(profile?this.db.prepare("SELECT * FROM preferences WHERE status='noted' AND hits>=? AND profile=?").all(PROMOTE_HITS,profile):this.db.prepare("SELECT * FROM preferences WHERE status='noted' AND hits>=?").all(PROMOTE_HITS)) as Preference[];
    const now=new Date().toISOString();
    for(const row of rows)this.db.prepare("UPDATE preferences SET status='law',updated_at=? WHERE id=?").run(now,row.id);
    return rows.map(r=>({...r,status:"law" as PreferenceStatus,updated_at:now}));
  }
  list(profile?:string):Preference[]{
    return (profile?this.db.prepare("SELECT * FROM preferences WHERE profile=? ORDER BY status,updated_at DESC LIMIT 200").all(profile):this.db.prepare("SELECT * FROM preferences ORDER BY updated_at DESC LIMIT 200").all()) as Preference[];
  }
  lawsFor(profile:string):Preference[]{return this.db.prepare("SELECT * FROM preferences WHERE profile=? AND status='law' ORDER BY updated_at DESC LIMIT 50").all(profile) as Preference[];}
  get(id:string):Preference|undefined{return this.db.prepare("SELECT * FROM preferences WHERE id=?").get(id) as Preference|undefined;}
  revoke(id:string):boolean{return this.db.prepare("UPDATE preferences SET status='revoked',updated_at=? WHERE id=? AND status!='revoked'").run(new Date().toISOString(),id).changes===1;}
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
export function lawPromptBlock(laws:Preference[]):string{
  if(!laws.length)return "";
  return " Standing law for this profile, stated or earned from the owner's own preferences. Follow it unless the owner overrides it in this conversation:\n"+laws.map(l=>"- "+l.statement).join("\n");
}
