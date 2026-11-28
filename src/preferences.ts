import Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { errorReason } from "./error-reason.js";
import { ChatStore } from "./chats.js";

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
export const PREFERENCE_STATEMENT_MAX = 200;
// The ONE source for whether a statement can be stored at all:
// empty once normalized, or over the cap once normalized (the
// store measures the normalized form - whitespace collapsed,
// trailing punctuation stripped - never the raw text). note()
// throws this at write time; the P1 proposal gate for kind law
// throws the identical text at proposal time, so a law card
// that could only fail on approval is never shown.
export function preferenceStatementBlocker(statement:string):string|null{
  const clean=normalize(statement);
  if(!clean||clean.length>PREFERENCE_STATEMENT_MAX)return "Invalid preference statement";
  return null;
}
function normalizePreferenceProfileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
/** The ONE source for why a preference cannot be created for
 *  this profile: the name is not in the profile registry
 *  ("sam", the implicit core profile, plus every registered
 *  agent), so a preference bound to it - and `preferences add`
 *  records a rule, which is standing LAW the moment it lands -
 *  would be read back by no one: law is injected only through
 *  lawsFor(a real profile) at prompt assembly, so the record
 *  would sit in the store as law governing nobody. The
 *  terminal creation door (CLI `preferences add`) rides this
 *  source and refuses before opening the store or creating
 *  anything. When exactly one valid profile matches the bad
 *  name folded for case and separators, the refusal names it
 *  ("Second Shift" -> "second-shift"). Null means the profile
 *  can be named. The store itself stays permissive by design:
 *  a profile removed after a preference names it leaves the
 *  record with its stored binding, and callers that name a
 *  profile by construction (the turn loop's preference capture
 *  from a chat's own profile, heartbeat consolidation, the ONE
 *  gate's approved law execution, the eval battery's scratch
 *  profile) are not gated here, so PreferenceStore.note is
 *  NOT gated. */
export function preferenceProfileBlocker(root: string, profile: string): string | null {
  const db = new ChatStore(root);
  let names: string[];
  try { names = ["sam", ...db.agents().map(a => a.name).filter(n => n !== "sam")]; } finally { db.close(); }
  if (names.includes(profile)) return null;
  const target = normalizePreferenceProfileName(profile ?? "");
  const matches = target ? names.filter(n => normalizePreferenceProfileName(n) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Unknown profile \"" + profile + "\" in preference detail. Valid profiles: " + names.join(", ") + (fix ? ". Did you mean \"" + fix + "\"?" : "");
}
function normalizePreferenceId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function describePreference(p: Preference): string {
  return p.id + " (profile " + p.profile + ", kind " + p.kind + ", status " + p.status + ")";
}

/** The preference gate for the preferences revoke door
 *  (refusal-class sweep, 2026-11-28): every registry's
 *  remove door now reads its registry through a
 *  fold-corrected ONE source, but CLI `preferences revoke
 *  <id>` rode PreferenceStore.revoke alone and carried no
 *  description, so an unknown id - or a real id typed
 *  folded (upper-case, or without its hyphens, the two
 *  ways a UUID gets copied out of a `preferences list`) -
 *  silently returned {revoked:false}, naming nothing, at
 *  the door that kills standing LAW: a revoke the owner
 *  believes landed leaves the law in force in every
 *  prompt, and one that never existed reads exactly the
 *  same; an already-revoked id read the same false again,
 *  so revoked-now, revoked-before, and never-existed were
 *  indistinguishable at the door. Preferences carry no
 *  human name: the id IS the key, so the registry this
 *  door names is the preferences themselves, each
 *  described ONLY by id, profile, kind, and status - a
 *  preference's STATEMENT is the owner's own words and
 *  never enters a refusal, the drafts discipline.
 *  preferenceRevokeBlocker is now the ONE source over the
 *  preferences registry alone for this door (an exact
 *  live id reads no blocker; an exact already-revoked id
 *  refuses naming that state; anything else refuses with
 *  the value echoed, the preferences named as the
 *  registry, and a fold correction when exactly one
 *  preference id matches folded for case and separators
 *  via normalizePreferenceId); findPreference resolves a
 *  live exact id or throws it, and the CLI revoke door
 *  resolves through findPreference before anything is
 *  revoked. PreferenceStore.revoke keeps its boolean
 *  contract for internal callers - the store seam stays
 *  permissive by design, and the dashboard revoke seam
 *  (with its law-revoked ledgering) is untouched. */
export function preferenceRevokeBlocker(root: string, id: string): string | null {
  const store = new PreferenceStore(root);
  let items: Preference[];
  try { items = store.list(); } finally { store.close(); }
  const exact = items.find(p => p.id === id);
  if (exact && exact.status !== "revoked") return null;
  const registry = items.length ? items.map(describePreference).join(", ") : "none registered";
  if (exact) return "Preference \"" + id + "\" is already revoked. Preferences: " + registry;
  const target = normalizePreferenceId(id ?? "");
  const matches = target ? items.filter(p => normalizePreferenceId(p.id) === target) : [];
  const fix = matches.length === 1 ? matches[0] : null;
  return "Preference not found: \"" + id + "\". Preferences: " + registry + (fix ? ". Did you mean \"" + fix.id + "\"?" : "");
}

export function findPreference(root: string, id: string): Preference {
  const blocker = preferenceRevokeBlocker(root, id);
  if (blocker) throw new Error(blocker);
  const store = new PreferenceStore(root);
  try {
    const found = store.get(id);
    if (!found) throw new Error(preferenceRevokeBlocker(root, id) ?? "Preference not found: \"" + id + "\"");
    return found;
  } finally { store.close(); }
}
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

/**
 * The reason a preference-store-failed line carries (census sprint
 * 2026-11-17): recordPreferenceStoreFailure took error.message alone,
 * discarding error.cause, so a failure whose wrapper hid
 * its cause was countable but never diagnosable. Now it
 * composes through errorReason (the 04:04 bridge seam):
 * causeless errors keep their plain message, a non-Error
 * reads through String, bot-token segments are redacted,
 * and no record content ever enters the line. */
export function preferenceStoreFailureReason(error: unknown): string {
  return errorReason(error);
}

export function recordPreferenceStoreFailure(root: string, phase: PreferenceStorePhase, error: unknown): void {
  const reason = preferenceStoreFailureReason(error);
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
    const blocker=preferenceStatementBlocker(statement);
    if(blocker)throw new Error(blocker);
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

// The law-revoked ledger shape has ONE writer here (the
// measured-proof series, 2026-11-21): the line lived as inline
// concatenation at the dashboard revokeLaw seam, and any drift
// was invisible. The shape is byte-identical to what that seam
// wrote inline before this writer existed.
export function lawRevokedLedgerSummary(profile: string, statement: string): string {
  return profile + ": " + statement;
}

// Law revocation history fold (2026-11-21): a dashboard
// revocation is an act - the preference store shows only each
// record's CURRENT status, so a profile whose law was revoked
// and later re-stated reads as ordinary live law and the
// revocation survives nowhere except this ledger line. The
// class counts dashboard-door revocations only (the CLI
// `preferences revoke` verb rides the store directly and
// ledgers nothing; its revocations stay visible as revoked
// records in the store). This family has no failure class of
// its own, so the verdict is attention only when a line is
// unparseable. The parser validates the profile against the
// store's own profile shape and requires a non-empty
// statement; the statement is the owner's own words - it is
// consumed by the parse and NEVER printed by the fold.
export function parseLawRevokedSummary(summary: string): { profile: string } | null {
  const m = /^([a-z][a-z0-9._-]{0,63}): ([\s\S]*\S[\s\S]*)$/.exec(summary);
  if (!m) return null;
  return { profile: m[1] as string };
}

export function lawRevokedHistoryScorecardText(root: string): string {
  const lines = readActivity(root, Number.MAX_SAFE_INTEGER, { kind: "law-revoked" });
  let revoked = 0;
  let unparseable = 0;
  const profileSet = new Set<string>();
  for (const line of lines) {
    const parsed = parseLawRevokedSummary(line.summary);
    if (!parsed) { unparseable += 1; continue; }
    revoked += 1;
    profileSet.add(parsed.profile);
  }
  const parts: string[] = [];
  parts.push("Law revoked history: " + (unparseable > 0 ? "attention" : "clear"));
  parts.push(String(revoked) + " revoked");
  parts.push(String(profileSet.size) + " distinct profiles");
  parts.push(String(lines.length) + " total");
  if (unparseable > 0) parts.push(String(unparseable) + " unparseable");
  return parts.join(", ");
}
